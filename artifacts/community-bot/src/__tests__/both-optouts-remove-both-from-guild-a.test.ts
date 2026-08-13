/**
 * Tests verifying that tracking stays blocked in guild-B when BOTH the global
 * opt-out AND guild-A's per-guild opt-out are removed SIMULTANEOUSLY via the
 * atomic `setVcPrivacyOptin(guildA, user)` path — which writes `optedOut=false`
 * to both the global and per-guild rows inside a single `db.transaction`.
 *
 * Covers:
 *   1. isVcTrackingOptedOut still returns true for guild-B after
 *      `setVcPrivacyOptin(GUILD_A, USER)` clears the global row and guild-A's
 *      per-guild row in one transaction (guild-B per-guild row survives).
 *   2. openSession in guild-B still returns null after the atomic opt-in for
 *      guild-A is complete.
 *   3. openSession succeeds in guild-A once its per-guild opt-out and the global
 *      opt-out have both been removed by `setVcPrivacyOptin` (sanity control).
 *   4. `setVcPrivacyOptin(GUILD_A, USER)` issues no upsert targeting guild-B's
 *      per-guild row (no cross-guild bleed in the transaction).
 *
 * Key design: the DB mock is STATEFUL and includes a `transaction` shim that
 * passes the same stateful `insert` as the `tx` argument so writes made inside
 * the transaction callback reach the same in-memory stores that `select` reads.
 * A regression where the transaction's guild-A upsert also touches guild-B's
 * row would be directly observable here.
 *
 * Mock pattern follows artifacts/community-bot/src/__tests__/privacy-status-after-optin.test.ts.
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

  // ── Shared stateful insert implementation ─────────────────────────────────
  // Used both by the top-level db.insert and by the tx object passed into the
  // db.transaction callback, so writes made inside a transaction land in the
  // same in-memory stores that select reads from.
  const makeInsert = () =>
    vi.fn((table: unknown) => ({
      values: vi.fn((row: Record<string, unknown>) => ({
        // Path used by setVcGlobalPrivacyOptOut / setVcPrivacyOptOut /
        // setVcPrivacyOptin (via tx.insert inside db.transaction)
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

  const insert = makeInsert();

  // ── db.transaction shim ───────────────────────────────────────────────────
  // Passes the same stateful insert as the `tx` argument so that writes made
  // inside setVcPrivacyOptin's transaction callback reach globalStore /
  // guildStore just like bare db.insert calls do.
  const transaction = vi.fn(
    async (cb: (tx: { insert: typeof insert }) => Promise<void>) => {
      await cb({ insert });
    },
  );

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

  // ── update (used by closeOpenSessionsForUser) ─────────────────────────────
  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([]),
      })),
    })),
  }));

  return {
    select, insert, update, transaction, reset,
    tables, globalStore, guildStore, upsertLog, sessionInserts,
  };
});

// ─── Mock @workspace/db ───────────────────────────────────────────────────────
vi.mock("@workspace/db", () => ({
  db: {
    select:      mocks.select,
    insert:      mocks.insert,
    update:      mocks.update,
    transaction: mocks.transaction,
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
  setVcPrivacyOptin,
  openSession,
  isVcTrackingOptedOut,
} from "../lib/community.js";

// ─── Constants ────────────────────────────────────────────────────────────────
const USER    = "user-001";
const GUILD_A = "guild-a"; // atomic opt-in via setVcPrivacyOptin clears both opt-outs here
const GUILD_B = "guild-b"; // per-guild opt-out remains; tracking must stay blocked
const CHANNEL  = "channel-001";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("atomic opt-in for guild-A clears both global and guild-A per-guild rows; guild-B per-guild row survives", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();
  });

  it("isVcTrackingOptedOut still returns true for guild-B after setVcPrivacyOptin removes both opt-outs for guild-A", async () => {
    // Step 1 — set global opt-out and per-guild opt-outs on both guilds
    await setVcGlobalPrivacyOptOut(USER, true);
    await setVcPrivacyOptOut(GUILD_A, USER, true);
    await setVcPrivacyOptOut(GUILD_B, USER, true);

    // Confirm initial state
    expect(mocks.globalStore.get(USER)).toBe(true);
    expect(mocks.guildStore.get(`${GUILD_A}:${USER}`)).toBe(true);
    expect(mocks.guildStore.get(`${GUILD_B}:${USER}`)).toBe(true);

    // Step 2 — atomically clear both global + guild-A per-guild opt-outs via
    // setVcPrivacyOptin, which issues a single db.transaction write
    await setVcPrivacyOptin(GUILD_A, USER);

    // Global and guild-A per-guild are now opted-in
    expect(mocks.globalStore.get(USER)).toBe(false);
    expect(mocks.guildStore.get(`${GUILD_A}:${USER}`)).toBe(false);
    // Guild-B per-guild row is unchanged
    expect(mocks.guildStore.get(`${GUILD_B}:${USER}`)).toBe(true);

    // Step 3 — isVcTrackingOptedOut for guild-B must still return true
    // (guild-B's per-guild row is still opted-out)
    const optedOut = await isVcTrackingOptedOut(GUILD_B, USER);
    expect(optedOut).toBe(true);
  });

  it("openSession in guild-B still returns null after setVcPrivacyOptin atomically clears both opt-outs for guild-A", async () => {
    // Step 1 — set global opt-out and per-guild opt-outs on both guilds
    await setVcGlobalPrivacyOptOut(USER, true);
    await setVcPrivacyOptOut(GUILD_A, USER, true);
    await setVcPrivacyOptOut(GUILD_B, USER, true);

    // Step 2 — atomically clear both global + guild-A per-guild opt-outs
    await setVcPrivacyOptin(GUILD_A, USER);

    // Guild-B per-guild row is unchanged
    expect(mocks.guildStore.get(`${GUILD_B}:${USER}`)).toBe(true);

    // Step 3 — openSession in guild-B must still return null
    const session = await openSession(GUILD_B, USER, CHANNEL);

    expect(session).toBeNull();
    // No session insert should have occurred
    expect(mocks.sessionInserts).toHaveLength(0);
  });

  it("openSession succeeds in guild-A after setVcPrivacyOptin removes both its opt-outs (sanity control)", async () => {
    // Set global opt-out and per-guild opt-outs on both guilds
    await setVcGlobalPrivacyOptOut(USER, true);
    await setVcPrivacyOptOut(GUILD_A, USER, true);
    await setVcPrivacyOptOut(GUILD_B, USER, true);

    // Atomically clear both global + guild-A per-guild opt-outs
    await setVcPrivacyOptin(GUILD_A, USER);

    // Guild-A should now be unblocked
    const session = await openSession(GUILD_A, USER, CHANNEL);

    expect(session).not.toBeNull();
    expect(session?.userId).toBe(USER);
    expect(session?.guildId).toBe(GUILD_A);
    expect(mocks.sessionInserts).toHaveLength(1);
  });

  it("setVcPrivacyOptin routes through db.transaction (both writes are atomic)", async () => {
    await setVcGlobalPrivacyOptOut(USER, true);
    await setVcPrivacyOptOut(GUILD_A, USER, true);
    await setVcPrivacyOptOut(GUILD_B, USER, true);

    mocks.transaction.mockClear();

    await setVcPrivacyOptin(GUILD_A, USER);

    // The opt-in must go through exactly one transaction
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it("setVcPrivacyOptin does not write any upsert targeting guild-B's per-guild row", async () => {
    // Set global opt-out and per-guild opt-outs on both guilds
    await setVcGlobalPrivacyOptOut(USER, true);
    await setVcPrivacyOptOut(GUILD_A, USER, true);
    await setVcPrivacyOptOut(GUILD_B, USER, true);

    const guildBUpsertsBefore = mocks.upsertLog.filter(
      (u) => u.tableTag === "privacy" && (u.row.guildId as string) === GUILD_B,
    ).length;

    // Atomically clear both global + guild-A per-guild opt-outs
    await setVcPrivacyOptin(GUILD_A, USER);

    // No additional privacy upserts for guild-B should have occurred
    const guildBUpsertsAfter = mocks.upsertLog.filter(
      (u) => u.tableTag === "privacy" && (u.row.guildId as string) === GUILD_B,
    ).length;
    expect(guildBUpsertsAfter).toBe(guildBUpsertsBefore);

    // Guild-B's per-guild store entry is still intact
    expect(mocks.guildStore.get(`${GUILD_B}:${USER}`)).toBe(true);
  });
});
