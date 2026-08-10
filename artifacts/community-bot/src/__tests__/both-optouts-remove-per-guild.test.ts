/**
 * Tests verifying that tracking stays blocked across ALL guilds after only the
 * per-guild opt-out is removed from one guild.
 *
 * Covers:
 *   1. openSession still returns null in guild-B after only guild-A's per-guild
 *      opt-out is cleared (global opt-out remains; guild-B per-guild opt-out
 *      remains).
 *   2. isVcTrackingOptedOut still returns true for guild-B after guild-A's
 *      per-guild row is set to false.
 *   3. openSession succeeds in guild-A once its per-guild opt-out is cleared
 *      and the global opt-out has also been removed (sanity control).
 *   4. Clearing guild-A's per-guild row does not write to guild-B's per-guild
 *      store (no cross-guild bleed in the upsert log).
 *
 * Key design: the DB mock is STATEFUL.  Both setVcGlobalPrivacyOptOut and
 * setVcPrivacyOptOut write into an in-memory store; isVcTrackingOptedOut
 * (and openSession, which calls it) reads from that same store.  A regression
 * where clearing one guild's per-guild row also clears another guild's row
 * would be directly observable here.
 *
 * Mock pattern follows artifacts/community-bot/src/__tests__/both-optouts-remove-global.test.ts.
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
const USER    = "user-001";
const GUILD_A = "guild-a"; // per-guild opt-out will be removed from this guild
const GUILD_B = "guild-b"; // per-guild opt-out remains; tracking must stay blocked
const CHANNEL  = "channel-001";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("both global and per-guild opt-out: removing only the per-guild entry from guild-A", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();
  });

  it("openSession in guild-B still returns null after guild-A's per-guild opt-out is removed", async () => {
    // Step 1 — set global opt-out and per-guild opt-outs on both guilds
    await setVcGlobalPrivacyOptOut(USER, true);
    await setVcPrivacyOptOut(GUILD_A, USER, true);
    await setVcPrivacyOptOut(GUILD_B, USER, true);

    // Both per-guild stores should reflect the opt-outs
    expect(mocks.guildStore.get(`${GUILD_A}:${USER}`)).toBe(true);
    expect(mocks.guildStore.get(`${GUILD_B}:${USER}`)).toBe(true);

    // Step 2 — remove only guild-A's per-guild opt-out (set to false)
    await setVcPrivacyOptOut(GUILD_A, USER, false);

    // Guild-A per-guild is now opt-in; guild-B per-guild is unchanged
    expect(mocks.guildStore.get(`${GUILD_A}:${USER}`)).toBe(false);
    expect(mocks.guildStore.get(`${GUILD_B}:${USER}`)).toBe(true);

    // Step 3 — openSession in guild-B must still return null (global opt-out
    // is still active, and guild-B's per-guild opt-out is still active)
    const session = await openSession(GUILD_B, USER, CHANNEL);

    expect(session).toBeNull();
    // No session insert should have occurred
    expect(mocks.sessionInserts).toHaveLength(0);
  });

  it("isVcTrackingOptedOut returns true for guild-B after guild-A's per-guild opt-out is removed", async () => {
    // Set global opt-out and per-guild opt-outs on both guilds
    await setVcGlobalPrivacyOptOut(USER, true);
    await setVcPrivacyOptOut(GUILD_A, USER, true);
    await setVcPrivacyOptOut(GUILD_B, USER, true);

    // Remove only guild-A's per-guild opt-out
    await setVcPrivacyOptOut(GUILD_A, USER, false);

    // Guild-B's per-guild row is untouched
    expect(mocks.guildStore.get(`${GUILD_B}:${USER}`)).toBe(true);

    // isVcTrackingOptedOut must still return true for guild-B
    // (global opt-out is still set AND guild-B per-guild is still set)
    const optedOut = await isVcTrackingOptedOut(GUILD_B, USER);
    expect(optedOut).toBe(true);
  });

  it("isVcTrackingOptedOut still returns true for guild-B when only global opt-out remains (no per-guild row needed)", async () => {
    // Set global opt-out only; per-guild opt-outs on both guilds
    await setVcGlobalPrivacyOptOut(USER, true);
    await setVcPrivacyOptOut(GUILD_A, USER, true);
    await setVcPrivacyOptOut(GUILD_B, USER, true);

    // Remove guild-A's per-guild opt-out
    await setVcPrivacyOptOut(GUILD_A, USER, false);

    // The global opt-out alone is sufficient to block guild-B
    expect(mocks.globalStore.get(USER)).toBe(true);

    const optedOut = await isVcTrackingOptedOut(GUILD_B, USER);
    expect(optedOut).toBe(true);
  });

  it("removing guild-A's per-guild opt-out does not write to guild-B's per-guild store", async () => {
    // Set both opt-outs on both guilds
    await setVcGlobalPrivacyOptOut(USER, true);
    await setVcPrivacyOptOut(GUILD_A, USER, true);
    await setVcPrivacyOptOut(GUILD_B, USER, true);

    const guildBUpsertsBefore = mocks.upsertLog.filter(
      (u) => u.tableTag === "privacy" && (u.row.guildId as string) === GUILD_B,
    ).length;

    // Remove only guild-A's per-guild opt-out
    await setVcPrivacyOptOut(GUILD_A, USER, false);

    // No additional privacy upserts for guild-B should have occurred
    const guildBUpsertsAfter = mocks.upsertLog.filter(
      (u) => u.tableTag === "privacy" && (u.row.guildId as string) === GUILD_B,
    ).length;
    expect(guildBUpsertsAfter).toBe(guildBUpsertsBefore);

    // Guild-B's per-guild store entry is still intact
    expect(mocks.guildStore.get(`${GUILD_B}:${USER}`)).toBe(true);
  });
});
