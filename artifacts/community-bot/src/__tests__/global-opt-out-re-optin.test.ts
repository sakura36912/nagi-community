/**
 * Tests verifying that re-opting-in after a global opt-out resumes tracking
 * for the right guilds only.
 *
 * Covers:
 *   1. openSession succeeds for a guild with no per-guild opt-out after
 *      global opt-out → global opt-in.
 *   2. openSession returns null for a guild that still has a per-guild
 *      opted_out=true row, even after the global opt-in.
 *
 * Key design: the DB mock is STATEFUL.  setVcGlobalPrivacyOptOut writes into
 * an in-memory store; isVcTrackingOptedOut (called inside openSession) reads
 * from that same store.  This means a bug in the setter (e.g. writing
 * optedOut=true when it should write false) is directly observable by
 * openSession — the two are no longer independently staged.
 *
 * Mock pattern follows artifacts/community-bot/src/__tests__/opt-out-vc-ranking.test.ts.
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
import { setVcGlobalPrivacyOptOut, openSession } from "../lib/community.js";

// ─── Constants ────────────────────────────────────────────────────────────────
const USER          = "user-001";
const GUILD_OPEN    = "guild-open";    // no per-guild opt-out
const GUILD_BLOCKED = "guild-blocked"; // per-guild opt-out remains after global opt-in
const CHANNEL       = "channel-001";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("re-opt-in after global opt-out: openSession behaviour", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();
  });

  it("openSession succeeds for a guild with no per-guild opt-out after global opt-out → global opt-in", async () => {
    // Step 1 — global opt-out
    await setVcGlobalPrivacyOptOut(USER, true);
    expect(mocks.globalStore.get(USER)).toBe(true);

    // Step 2 — global opt-in
    await setVcGlobalPrivacyOptOut(USER, false);

    // Assert the opt-in upsert explicitly wrote optedOut=false
    const globalUpserts = mocks.upsertLog.filter((u) => u.tableTag === "global");
    expect(globalUpserts).toHaveLength(2);
    const optInUpsert = globalUpserts[1]!;
    expect(optInUpsert.set.optedOut).toBe(false);

    // The store now reflects the opt-in
    expect(mocks.globalStore.get(USER)).toBe(false);

    // No per-guild opt-out for GUILD_OPEN
    expect(mocks.guildStore.has(`${GUILD_OPEN}:${USER}`)).toBe(false);

    // Step 3 — openSession reads state from the store; global row has optedOut=false,
    // no guild-local row → isVcTrackingOptedOut returns false → session is created
    const session = await openSession(GUILD_OPEN, USER, CHANNEL);

    expect(session).not.toBeNull();
    expect(session?.userId).toBe(USER);
    expect(session?.guildId).toBe(GUILD_OPEN);
    // Exactly one session insert was made
    expect(mocks.sessionInserts).toHaveLength(1);
  });

  it("openSession returns null for a guild that still has a per-guild opt-out after global opt-in", async () => {
    // Seed a per-guild opt-out for the blocked guild (simulates a prior guild-local opt-out)
    mocks.guildStore.set(`${GUILD_BLOCKED}:${USER}`, true);

    // Global opt-out then opt-in
    await setVcGlobalPrivacyOptOut(USER, true);
    await setVcGlobalPrivacyOptOut(USER, false);

    // Verify the opt-in upsert recorded optedOut=false
    const optInUpsert = mocks.upsertLog.filter((u) => u.tableTag === "global")[1]!;
    expect(optInUpsert.set.optedOut).toBe(false);

    // The global store shows opt-in; the per-guild store is untouched
    expect(mocks.globalStore.get(USER)).toBe(false);
    expect(mocks.guildStore.get(`${GUILD_BLOCKED}:${USER}`)).toBe(true);

    // openSession reads: global=optedOut:false, guild=optedOut:true → still blocked
    const session = await openSession(GUILD_BLOCKED, USER, CHANNEL);

    expect(session).toBeNull();
    // No session insert should have occurred
    expect(mocks.sessionInserts).toHaveLength(0);
  });

  it("global opt-in selectively unblocks only the guild without a per-guild opt-out", async () => {
    // Seed per-guild opt-out for the blocked guild only
    mocks.guildStore.set(`${GUILD_BLOCKED}:${USER}`, true);

    // Global opt-out then opt-in
    await setVcGlobalPrivacyOptOut(USER, true);
    await setVcGlobalPrivacyOptOut(USER, false);

    // openSession in the open guild → should succeed
    const openResult = await openSession(GUILD_OPEN, USER, CHANNEL);
    expect(openResult).not.toBeNull();
    expect(openResult?.guildId).toBe(GUILD_OPEN);
    expect(mocks.sessionInserts).toHaveLength(1);

    // openSession in the blocked guild → should still return null
    const blockedResult = await openSession(GUILD_BLOCKED, USER, CHANNEL);
    expect(blockedResult).toBeNull();
    // Still only 1 session insert total — blocked guild never inserted
    expect(mocks.sessionInserts).toHaveLength(1);
  });
});
