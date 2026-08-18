/**
 * Tests confirming that isVcTrackingOptedOut returns false for guild-B when:
 *   - guild-B has NO per-guild opt-out row at all
 *   - the global opt-out is present initially but then cleared
 *   - guild-A has a per-guild opt-out that is also cleared (via setVcPrivacyOptin)
 *
 * Covers:
 *   1. isVcTrackingOptedOut returns false for guild-B after both the global and
 *      guild-A per-guild opt-outs are cleared, when guild-B has no per-guild row.
 *   2. openSession succeeds in guild-B after both opt-outs are removed when
 *      guild-B has no per-guild row.
 *   3. isVcTrackingOptedOut returns false for guild-B immediately when guild-B
 *      has no per-guild row and there is no global opt-out at all (baseline check).
 *   4. openSession succeeds in guild-B when neither a global nor a per-guild row
 *      for guild-B is present (baseline check).
 *
 * Mock pattern follows artifacts/community-bot/src/__tests__/both-optouts-remove-both-from-guild-a.test.ts.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock state ─────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  // ── In-memory privacy state ──────────────────────────────────────────────
  /** Global privacy store: userId → optedOut */
  const globalStore = new Map<string, boolean>();
  /** Per-guild privacy store: `${guildId}:${userId}` → optedOut */
  const guildStore  = new Map<string, boolean>();
  /** Tracks session rows created via insert().values().returning() */
  const sessionInserts: unknown[] = [];

  const reset = () => {
    globalStore.clear();
    guildStore.clear();
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
  const makeInsert = () =>
    vi.fn((table: unknown) => ({
      values: vi.fn((row: Record<string, unknown>) => ({
        onConflictDoUpdate: vi.fn(({ set }: { set: Record<string, unknown> }) => {
          const effectiveOptedOut =
            "optedOut" in set ? (set.optedOut as boolean) : (row.optedOut as boolean);

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
  const transaction = vi.fn(
    async (cb: (tx: { insert: typeof insert }) => Promise<void>) => {
      await cb({ insert });
    },
  );

  // ── Stateful select ───────────────────────────────────────────────────────
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
    tables, globalStore, guildStore, sessionInserts,
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
const GUILD_A = "guild-a"; // has a per-guild opt-out row; cleared via setVcPrivacyOptin
const GUILD_B = "guild-b"; // has NO per-guild row at all
const CHANNEL  = "channel-001";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("isVcTrackingOptedOut returns false for guild-B when its per-guild row is absent and global is also cleared", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();
  });

  it("isVcTrackingOptedOut returns false for guild-B after clearing both the global and guild-A per-guild opt-outs when guild-B has no per-guild row", async () => {
    // Step 1 — set global opt-out and a per-guild opt-out for guild-A only.
    // guild-B intentionally has no per-guild row.
    await setVcGlobalPrivacyOptOut(USER, true);
    await setVcPrivacyOptOut(GUILD_A, USER, true);

    // Confirm initial state
    expect(mocks.globalStore.get(USER)).toBe(true);
    expect(mocks.guildStore.get(`${GUILD_A}:${USER}`)).toBe(true);
    // guild-B has no row
    expect(mocks.guildStore.has(`${GUILD_B}:${USER}`)).toBe(false);

    // Step 2 — atomically clear both global + guild-A per-guild opt-outs
    await setVcPrivacyOptin(GUILD_A, USER);

    // Global and guild-A per-guild are now opted-in
    expect(mocks.globalStore.get(USER)).toBe(false);
    expect(mocks.guildStore.get(`${GUILD_A}:${USER}`)).toBe(false);
    // guild-B still has no per-guild row
    expect(mocks.guildStore.has(`${GUILD_B}:${USER}`)).toBe(false);

    // Step 3 — isVcTrackingOptedOut for guild-B must return false because
    // neither the global nor a guild-B per-guild row blocks tracking
    const optedOut = await isVcTrackingOptedOut(GUILD_B, USER);
    expect(optedOut).toBe(false);
  });

  it("openSession succeeds in guild-B after both global and guild-A per-guild opt-outs are removed when guild-B has no per-guild row", async () => {
    // Step 1 — set global opt-out and per-guild opt-out for guild-A only
    await setVcGlobalPrivacyOptOut(USER, true);
    await setVcPrivacyOptOut(GUILD_A, USER, true);

    // guild-B has no per-guild row
    expect(mocks.guildStore.has(`${GUILD_B}:${USER}`)).toBe(false);

    // Step 2 — atomically clear both global + guild-A per-guild opt-outs
    await setVcPrivacyOptin(GUILD_A, USER);

    // Step 3 — openSession in guild-B must succeed because nothing blocks tracking
    const session = await openSession(GUILD_B, USER, CHANNEL);

    expect(session).not.toBeNull();
    expect(session?.userId).toBe(USER);
    expect(session?.guildId).toBe(GUILD_B);
    expect(mocks.sessionInserts).toHaveLength(1);
  });

  it("isVcTrackingOptedOut returns false for guild-B when neither a global nor a per-guild row for guild-B exists (baseline: no opt-outs at all)", async () => {
    // No opt-outs set — stores are empty
    expect(mocks.globalStore.has(USER)).toBe(false);
    expect(mocks.guildStore.has(`${GUILD_B}:${USER}`)).toBe(false);

    const optedOut = await isVcTrackingOptedOut(GUILD_B, USER);
    expect(optedOut).toBe(false);
  });

  it("openSession succeeds in guild-B when no global opt-out and no per-guild row for guild-B exist (baseline: no opt-outs at all)", async () => {
    // No opt-outs set — stores are empty
    expect(mocks.globalStore.has(USER)).toBe(false);
    expect(mocks.guildStore.has(`${GUILD_B}:${USER}`)).toBe(false);

    const session = await openSession(GUILD_B, USER, CHANNEL);

    expect(session).not.toBeNull();
    expect(session?.userId).toBe(USER);
    expect(session?.guildId).toBe(GUILD_B);
    expect(mocks.sessionInserts).toHaveLength(1);
  });
});
