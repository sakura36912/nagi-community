/**
 * Tests verifying that tracking stays blocked in guild-A when ONLY guild-B's
 * per-guild opt-out is removed — the inverse of
 * both-optouts-remove-per-guild.test.ts, which confirms the same
 * invariant from the other direction.
 *
 * Covers:
 *   1. isVcTrackingOptedOut still returns true for guild-A after guild-B's
 *      per-guild opt-out is cleared (guild-A per-guild row + global row survive
 *      untouched).
 *   2. openSession in guild-A still returns null after guild-B's per-guild
 *      opt-out is cleared.
 *   3. Clearing guild-B's per-guild row does not write to guild-A's per-guild
 *      store (no cross-guild bleed in the upsert log).
 *   4. openSession succeeds in guild-B once its per-guild opt-out and the
 *      global opt-out have both been removed (sanity control).
 *
 * Key design: the DB mock is STATEFUL.  Both setVcGlobalPrivacyOptOut and
 * setVcPrivacyOptOut write into an in-memory store; isVcTrackingOptedOut
 * (and openSession, which calls it) reads from that same store.  A regression
 * where clearing guild-B's per-guild row also touches guild-A's row would be
 * directly observable here.
 *
 * Mock pattern follows artifacts/community-bot/src/__tests__/both-optouts-remove-per-guild.test.ts.
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
const GUILD_A = "guild-a"; // per-guild opt-out remains; tracking must stay blocked
const GUILD_B = "guild-b"; // per-guild opt-out will be removed from this guild
const CHANNEL  = "channel-001";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("both global and per-guild opt-out: removing only the per-guild entry from guild-B leaves guild-A blocked", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();
  });

  it("isVcTrackingOptedOut still returns true for guild-A after guild-B's per-guild opt-out is removed", async () => {
    // Step 1 — set global opt-out and per-guild opt-outs on both guilds
    await setVcGlobalPrivacyOptOut(USER, true);
    await setVcPrivacyOptOut(GUILD_A, USER, true);
    await setVcPrivacyOptOut(GUILD_B, USER, true);

    // Confirm initial state
    expect(mocks.globalStore.get(USER)).toBe(true);
    expect(mocks.guildStore.get(`${GUILD_A}:${USER}`)).toBe(true);
    expect(mocks.guildStore.get(`${GUILD_B}:${USER}`)).toBe(true);

    // Step 2 — remove only guild-B's per-guild opt-out (set to false)
    await setVcPrivacyOptOut(GUILD_B, USER, false);

    // Guild-B per-guild is now opt-in; guild-A per-guild is unchanged
    expect(mocks.guildStore.get(`${GUILD_B}:${USER}`)).toBe(false);
    expect(mocks.guildStore.get(`${GUILD_A}:${USER}`)).toBe(true);

    // Step 3 — isVcTrackingOptedOut for guild-A must still return true
    // (guild-A per-guild row + global row both survive)
    const optedOut = await isVcTrackingOptedOut(GUILD_A, USER);
    expect(optedOut).toBe(true);
  });

  it("openSession in guild-A still returns null after guild-B's per-guild opt-out is cleared", async () => {
    // Step 1 — set global opt-out and per-guild opt-outs on both guilds
    await setVcGlobalPrivacyOptOut(USER, true);
    await setVcPrivacyOptOut(GUILD_A, USER, true);
    await setVcPrivacyOptOut(GUILD_B, USER, true);

    // Step 2 — remove only guild-B's per-guild opt-out
    await setVcPrivacyOptOut(GUILD_B, USER, false);

    // Guild-A per-guild row is unchanged
    expect(mocks.guildStore.get(`${GUILD_A}:${USER}`)).toBe(true);
    // Global opt-out is unchanged
    expect(mocks.globalStore.get(USER)).toBe(true);

    // Step 3 — openSession in guild-A must still return null
    const session = await openSession(GUILD_A, USER, CHANNEL);

    expect(session).toBeNull();
    // No session insert should have occurred
    expect(mocks.sessionInserts).toHaveLength(0);
  });

  it("removing guild-B's per-guild opt-out does not write to guild-A's per-guild store", async () => {
    // Set both opt-outs on both guilds
    await setVcGlobalPrivacyOptOut(USER, true);
    await setVcPrivacyOptOut(GUILD_A, USER, true);
    await setVcPrivacyOptOut(GUILD_B, USER, true);

    const guildAUpsertsBefore = mocks.upsertLog.filter(
      (u) => u.tableTag === "privacy" && (u.row.guildId as string) === GUILD_A,
    ).length;

    // Remove only guild-B's per-guild opt-out
    await setVcPrivacyOptOut(GUILD_B, USER, false);

    // No additional privacy upserts for guild-A should have occurred
    const guildAUpsertsAfter = mocks.upsertLog.filter(
      (u) => u.tableTag === "privacy" && (u.row.guildId as string) === GUILD_A,
    ).length;
    expect(guildAUpsertsAfter).toBe(guildAUpsertsBefore);

    // Guild-A's per-guild store entry is still intact
    expect(mocks.guildStore.get(`${GUILD_A}:${USER}`)).toBe(true);
  });

  it("openSession succeeds in guild-B once its per-guild opt-out and the global opt-out are both removed (sanity control)", async () => {
    // Set global opt-out and per-guild opt-outs on both guilds
    await setVcGlobalPrivacyOptOut(USER, true);
    await setVcPrivacyOptOut(GUILD_A, USER, true);
    await setVcPrivacyOptOut(GUILD_B, USER, true);

    // Remove guild-B's per-guild opt-out and the global opt-out
    await setVcPrivacyOptOut(GUILD_B, USER, false);
    await setVcGlobalPrivacyOptOut(USER, false);

    // Guild-B should now be unblocked (no global opt-out, no per-guild opt-out)
    const session = await openSession(GUILD_B, USER, CHANNEL);

    expect(session).not.toBeNull();
    expect(session?.userId).toBe(USER);
    expect(session?.guildId).toBe(GUILD_B);
    expect(mocks.sessionInserts).toHaveLength(1);
  });
});
