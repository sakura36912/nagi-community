/**
 * Guards against cross-user contamination in isVcTrackingOptedOut.
 *
 * isVcTrackingOptedOut uses Promise.all internally to fire both the global
 * and guild DB queries in parallel.  If the select mock's closure captured
 * shared state incorrectly, concurrent calls for two different users could
 * return each other's flags.
 *
 * This test calls isVcTrackingOptedOut for user-A (globally opted out) and
 * user-B (not opted out) simultaneously via Promise.all and asserts that
 * neither result leaks into the other.
 *
 * Uses the stateful mock pattern from both-optouts-remove-guild.test.ts:
 * each select() invocation creates an independent chain whose `from` table
 * is captured in its own closure so parallel executions never share state.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock state ─────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  // ── In-memory privacy state ──────────────────────────────────────────────
  /** Global privacy store: userId → optedOut */
  const globalStore = new Map<string, boolean>();
  /** Per-guild privacy store: `${guildId}:${userId}` → optedOut */
  const guildStore  = new Map<string, boolean>();

  const reset = () => {
    globalStore.clear();
    guildStore.clear();
  };

  // ── Table proxies — created once so identity checks (===) work ───────────
  const makeTable = (name: string) =>
    new Proxy({} as Record<string, string>, { get: (_t, p: string) => `${name}.${p}` });

  const tables = {
    global:            makeTable("global"),
    privacy:           makeTable("privacy"),
    sessions:          makeTable("sessions"),
    eventSettings:     makeTable("eventSettings"),
    events:            makeTable("events"),
    eventParticipants: makeTable("eventParticipants"),
    ticketSettings:    makeTable("ticketSettings"),
    tickets:           makeTable("tickets"),
    ticketPanels:      makeTable("ticketPanels"),
    rankingSettings:   makeTable("rankingSettings"),
    roleButtons:       makeTable("roleButtons"),
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

  // ── Stateful insert (needed so setVcGlobalPrivacyOptOut works) ────────────
  const insert = vi.fn((table: unknown) => ({
    values: vi.fn((row: Record<string, unknown>) => ({
      onConflictDoUpdate: vi.fn(({ set }: { set: Record<string, unknown> }) => {
        const effectiveOptedOut =
          "optedOut" in set ? (set.optedOut as boolean) : (row.optedOut as boolean);

        if (table === tables.global) {
          globalStore.set(row.userId as string, effectiveOptedOut);
        } else if (table === tables.privacy) {
          guildStore.set(`${row.guildId}:${row.userId}`, effectiveOptedOut);
        }
        return Promise.resolve([]);
      }),
      returning: vi.fn(() => Promise.resolve([])),
    })),
  }));

  return { select, insert, reset, tables, globalStore, guildStore };
});

// ─── Mock @workspace/db ───────────────────────────────────────────────────────
vi.mock("@workspace/db", () => ({
  db: {
    select: mocks.select,
    insert: mocks.insert,
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })),
      })),
    })),
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

// ─── Mock drizzle-orm ─────────────────────────────────────────────────────────
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
  isVcTrackingOptedOut,
} from "../lib/community.js";

// ─── Constants ────────────────────────────────────────────────────────────────
const GUILD   = "guild-001";
const USER_A  = "user-a-opted-out";
const USER_B  = "user-b-not-opted-out";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("isVcTrackingOptedOut — concurrent isolation between two users", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();
  });

  it("user-A (opted out) and user-B (not opted out) return correct flags when checked concurrently", async () => {
    // Seed: user-A is globally opted out, user-B has no opt-out record
    await setVcGlobalPrivacyOptOut(USER_A, true);

    // Verify state before the concurrent check
    expect(mocks.globalStore.get(USER_A)).toBe(true);
    expect(mocks.globalStore.get(USER_B)).toBeUndefined();

    // Fire both checks at the same time — mirrors real concurrent usage
    const [resultA, resultB] = await Promise.all([
      isVcTrackingOptedOut(GUILD, USER_A),
      isVcTrackingOptedOut(GUILD, USER_B),
    ]);

    // user-A must be opted out; user-B must not be
    expect(resultA).toBe(true);
    expect(resultB).toBe(false);
  });

  it("user-B result does not bleed into user-A when user-B has a per-guild opt-out on a different guild", async () => {
    // user-A: globally opted out
    await setVcGlobalPrivacyOptOut(USER_A, true);
    // user-B: not opted out at all
    // (no store entry — absence is treated as false)

    const [resultA, resultB] = await Promise.all([
      isVcTrackingOptedOut(GUILD, USER_A),
      isVcTrackingOptedOut(GUILD, USER_B),
    ]);

    expect(resultA).toBe(true);
    expect(resultB).toBe(false);
  });

  it("neither result is contaminated when both users are opted out on different guilds", async () => {
    const GUILD_A = "guild-for-user-a";
    const GUILD_B = "guild-for-user-b";

    // user-A: globally opted out (affects all guilds)
    await setVcGlobalPrivacyOptOut(USER_A, true);
    // user-B: not opted out
    // (absent = false)

    const [resultA, resultB] = await Promise.all([
      isVcTrackingOptedOut(GUILD_A, USER_A),
      isVcTrackingOptedOut(GUILD_B, USER_B),
    ]);

    expect(resultA).toBe(true);
    expect(resultB).toBe(false);
  });

  it("flags remain isolated across multiple concurrent rounds", async () => {
    // Round 1: user-A opted out, user-B not
    await setVcGlobalPrivacyOptOut(USER_A, true);

    const [r1A, r1B] = await Promise.all([
      isVcTrackingOptedOut(GUILD, USER_A),
      isVcTrackingOptedOut(GUILD, USER_B),
    ]);
    expect(r1A).toBe(true);
    expect(r1B).toBe(false);

    // Round 2: same checks again — results must still be isolated
    const [r2A, r2B] = await Promise.all([
      isVcTrackingOptedOut(GUILD, USER_A),
      isVcTrackingOptedOut(GUILD, USER_B),
    ]);
    expect(r2A).toBe(true);
    expect(r2B).toBe(false);
  });
});
