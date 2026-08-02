/**
 * Tests verifying that tracking stays blocked when a user has BOTH a global
 * opt-out AND a per-guild opt-out, and removes only the global one.
 *
 * Covers:
 *   1. openSession still returns null in the opted-out guild after only the
 *      global opt-out is cleared (per-guild opt-out was set via the setter API).
 *   2. isVcTrackingOptedOut returns true after the global opt-out is cleared
 *      when a per-guild row with opted_out=true remains.
 *
 * Key design: the DB mock is STATEFUL.  Both setVcGlobalPrivacyOptOut and
 * setVcPrivacyOptOut write into an in-memory store; isVcTrackingOptedOut
 * (and openSession, which calls it) reads from that same store.  A regression
 * where clearing the global row also inadvertently clears per-guild rows would
 * be directly observable here.
 *
 * Mock pattern follows artifacts/community-bot/src/__tests__/global-opt-out-re-optin.test.ts.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock state ─────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  // ── In-memory privacy state ──────────────────────────────────────────────
  /** Global privacy store: userId → optedOut */
  const globalStore = new Map<string, boolean>();
  /** Per-guild privacy store: `${guildId}:${userId}` → optedOut */
  const guildStore  = new Map<string, boolean>();
  /** Captures every (table, values, set) triplet written via onConflictDoUpdate */
  const upsertLog: Array<{ tableTag: string; row: Record<string, unknown>; set: Record<string, unknown> }> = [];
  /** Tracks session rows created via insert().values().returning() */
  const sessionInserts: unknown[] = [];

  const reset = () => {
    globalStore.clear();
    guildStore.clear();
    upsertLog.length = 0;
    sessionInserts.length = 0;
  };

  // ── Table proxies — created once so identity checks (===) work ───────────
  const makeTable = (name: string) =>
    new Proxy({} as Record<string, string>, { get: (_t, p: string) => `${name}.${p}` });

  const tables = {
    global:           makeTable("global"),
    privacy:          makeTable("privacy"),
    sessions:         makeTable("sessions"),
    eventSettings:    makeTable("eventSettings"),
    events:           makeTable("events"),
    eventParticipants:makeTable("eventParticipants"),
    ticketSettings:   makeTable("ticketSettings"),
    tickets:          makeTable("tickets"),
    ticketPanels:     makeTable("ticketPanels"),
    rankingSettings:  makeTable("rankingSettings"),
    roleButtons:      makeTable("roleButtons"),
  };

  // ── Condition helper — extract a scalar value from drizzle-orm mock ops ──
  type Cond = { op: string; col?: unknown; val?: unknown; args?: Cond[] };
  function eqVal(cond: unknown, colPrefix: string): string | undefined {
    if (!cond || typeof cond !== "object") return undefined;
    const c = cond as Cond;
    if (c.op === "eq" && typeof c.col === "string" && c.col.startsWith(colPrefix))
      return c.val as string;
    if (c.op === "and" && Array.isArray(c.args)) {
      for (const a of c.args) {
        const v = eqVal(a, colPrefix);
        if (v !== undefined) return v;
      }
    }
    return undefined;
  }

  // ── Stateful select ───────────────────────────────────────────────────────
  // Each select() call creates an independent chain that captures the `from`
  // table in its own closure — safe to run in parallel (Promise.all).
  const select = vi.fn(() => {
    let fromTable: unknown = null;
    return {
      from: vi.fn((table: unknown) => {
        fromTable = table;
        return {
          where: vi.fn((cond: unknown): Promise<unknown[]> => {
            if (fromTable === tables.global) {
              const userId = eqVal(cond, "global.userId");
              if (userId !== undefined) {
                const optedOut = globalStore.get(userId);
                return Promise.resolve(optedOut !== undefined ? [{ userId, optedOut }] : []);
              }
            } else if (fromTable === tables.privacy) {
              const userId  = eqVal(cond, "privacy.userId");
              const guildId = eqVal(cond, "privacy.guildId");
              if (userId !== undefined && guildId !== undefined) {
                const optedOut = guildStore.get(`${guildId}:${userId}`);
                return Promise.resolve(
                  optedOut !== undefined ? [{ guildId, userId, optedOut }] : [],
                );
              }
            }
            return Promise.resolve([]);
          }),
        };
      }),
    };
  });

  // ── Stateful insert ───────────────────────────────────────────────────────
  const insert = vi.fn((table: unknown) => ({
    values: vi.fn((row: Record<string, unknown>) => ({
      // Path used by setVcGlobalPrivacyOptOut / setVcPrivacyOptOut
      onConflictDoUpdate: vi.fn(({ set }: { set: Record<string, unknown> }) => {
        const tableTag =
          table === tables.global  ? "global"  :
          table === tables.privacy ? "privacy" : "other";

        // The upsert semantic: set fields override values fields
        const effectiveOptedOut =
          "optedOut" in set ? (set.optedOut as boolean) : (row.optedOut as boolean);

        upsertLog.push({ tableTag, row, set });

        if (table === tables.global) {
          const userId = row.userId as string;
          globalStore.set(userId, effectiveOptedOut);
        } else if (table === tables.privacy) {
          const key = `${row.guildId}:${row.userId}`;
          guildStore.set(key, effectiveOptedOut);
        }
        return Promise.resolve([]);
      }),
      // Path used by openSession
      returning: vi.fn(() => {
        const session = {
          id: sessionInserts.length + 1,
          guildId: row.guildId,
          userId: row.userId,
          channelId: row.channelId,
          joinedAt: row.joinedAt ?? new Date(),
          leftAt: null,
        };
        sessionInserts.push(session);
        return Promise.resolve([session]);
      }),
    })),
  }));

  // ── update (used by closeOpenSessionsForUser) ─────────────────────────────
  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([]),
      })),
    })),
  }));

  return { select, insert, update, reset, tables, globalStore, guildStore, upsertLog, sessionInserts };
});

// ─── Mock @workspace/db ───────────────────────────────────────────────────────
vi.mock("@workspace/db", () => ({
  db: {
    select: mocks.select,
    insert: mocks.insert,
    update: mocks.update,
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })),
    })),
  },
  communityVcPrivacyGlobalTable: mocks.tables.global,
  communityVcPrivacyTable:        mocks.tables.privacy,
  communityVcSessionsTable:       mocks.tables.sessions,
  communityEventSettingsTable:    mocks.tables.eventSettings,
  communityEventsTable:           mocks.tables.events,
  communityEventParticipantsTable:mocks.tables.eventParticipants,
  communityTicketSettingsTable:   mocks.tables.ticketSettings,
  communityTicketsTable:          mocks.tables.tickets,
  communityTicketPanelsTable:     mocks.tables.ticketPanels,
  communityRankingSettingsTable:  mocks.tables.rankingSettings,
  communityRoleButtonsTable:      mocks.tables.roleButtons,
}));

// ─── Mock drizzle-orm ────────────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq:  (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  isNull:    (col: unknown) => ({ op: "isNull", col }),
  isNotNull: (col: unknown) => ({ op: "isNotNull", col }),
  gt:  (col: unknown, val: unknown) => ({ op: "gt", col, val }),
  gte: (col: unknown, val: unknown) => ({ op: "gte", col, val }),
  lt:  (col: unknown, val: unknown) => ({ op: "lt", col, val }),
  lte: (col: unknown, val: unknown) => ({ op: "lte", col, val }),
  or:  (...args: unknown[]) => ({ op: "or", args }),
  asc:  (col: unknown) => ({ op: "asc", col }),
  desc: (col: unknown) => ({ op: "desc", col }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({
      op: "sql",
      strings: Array.from(strings),
      values,
    }),
    { raw: (v: unknown) => ({ op: "sql.raw", v }) },
  ),
}));

// ─── Import after mocks ───────────────────────────────────────────────────────
import {
  setVcGlobalPrivacyOptOut,
  setVcPrivacyOptOut,
  openSession,
  isVcTrackingOptedOut,
} from "../lib/community.js";

// ─── Constants ────────────────────────────────────────────────────────────────
const USER          = "user-001";
const GUILD_BLOCKED = "guild-blocked"; // has a per-guild opt-out that survives global opt-in
const GUILD_OPEN    = "guild-open";    // no per-guild opt-out
const CHANNEL       = "channel-001";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("both global and per-guild opt-out: removing only the global one", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();
  });

  it("openSession still returns null in the opted-out guild after removing only the global opt-out", async () => {
    // Step 1 — set both opt-outs via the setter APIs
    await setVcGlobalPrivacyOptOut(USER, true);
    await setVcPrivacyOptOut(GUILD_BLOCKED, USER, true);

    // Both stores should reflect the opt-outs
    expect(mocks.globalStore.get(USER)).toBe(true);
    expect(mocks.guildStore.get(`${GUILD_BLOCKED}:${USER}`)).toBe(true);

    // Step 2 — remove only the global opt-out
    await setVcGlobalPrivacyOptOut(USER, false);

    // Global is now opt-in; per-guild is unchanged
    expect(mocks.globalStore.get(USER)).toBe(false);
    expect(mocks.guildStore.get(`${GUILD_BLOCKED}:${USER}`)).toBe(true);

    // Step 3 — openSession in the blocked guild must still return null
    const session = await openSession(GUILD_BLOCKED, USER, CHANNEL);

    expect(session).toBeNull();
    // No session insert should have occurred
    expect(mocks.sessionInserts).toHaveLength(0);
  });

  it("isVcTrackingOptedOut returns true after global opt-out is cleared when per-guild opt-out remains", async () => {
    // Set both opt-outs via the setter APIs
    await setVcGlobalPrivacyOptOut(USER, true);
    await setVcPrivacyOptOut(GUILD_BLOCKED, USER, true);

    // Remove only the global opt-out
    await setVcGlobalPrivacyOptOut(USER, false);

    // The per-guild row is untouched
    expect(mocks.guildStore.get(`${GUILD_BLOCKED}:${USER}`)).toBe(true);

    // isVcTrackingOptedOut must still return true because the guild-local row is active
    const optedOut = await isVcTrackingOptedOut(GUILD_BLOCKED, USER);
    expect(optedOut).toBe(true);
  });

  it("openSession succeeds in a guild with no per-guild opt-out after removing the global opt-out", async () => {
    // Set both opt-outs — only GUILD_BLOCKED has a per-guild row
    await setVcGlobalPrivacyOptOut(USER, true);
    await setVcPrivacyOptOut(GUILD_BLOCKED, USER, true);

    // Remove only the global opt-out
    await setVcGlobalPrivacyOptOut(USER, false);

    // GUILD_OPEN has no per-guild opt-out → tracking should resume
    const session = await openSession(GUILD_OPEN, USER, CHANNEL);

    expect(session).not.toBeNull();
    expect(session?.userId).toBe(USER);
    expect(session?.guildId).toBe(GUILD_OPEN);
    expect(mocks.sessionInserts).toHaveLength(1);
  });

  it("clearing the global opt-out does not touch the per-guild store", async () => {
    // Set both opt-outs
    await setVcGlobalPrivacyOptOut(USER, true);
    await setVcPrivacyOptOut(GUILD_BLOCKED, USER, true);

    const guildUpsertsBefore = mocks.upsertLog.filter((u) => u.tableTag === "privacy").length;

    // Remove only the global opt-out
    await setVcGlobalPrivacyOptOut(USER, false);

    // No additional privacy (per-guild) upserts should have occurred
    const guildUpsertsAfter = mocks.upsertLog.filter((u) => u.tableTag === "privacy").length;
    expect(guildUpsertsAfter).toBe(guildUpsertsBefore);

    // The per-guild store entry is still intact
    expect(mocks.guildStore.get(`${GUILD_BLOCKED}:${USER}`)).toBe(true);
  });
});
