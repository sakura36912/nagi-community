/**
 * Tests verifying that isVcTrackingOptedOut correctly combines the global and
 * per-guild opt-out flags using OR logic.
 *
 * Full truth table:
 *   global=false, guild=false → false  (not opted out)
 *   global=false, guild=true  → true   (guild wins)
 *   global=true,  guild=false → true   (global wins)
 *   global=true,  guild=true  → true   (both set)
 *
 * Mock pattern follows
 *   artifacts/community-bot/src/__tests__/opted-out-false-row.test.ts
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock state ─────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  /** Global privacy store: userId → optedOut */
  const globalStore = new Map<string, boolean>();
  /** Per-guild privacy store: `${guildId}:${userId}` → optedOut */
  const guildStore = new Map<string, boolean>();

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
  // Each select() call captures its own `fromTable` in a closure so parallel
  // calls (Promise.all) do not clobber each other.
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
                // Return the row when it exists, even if optedOut=false
                return Promise.resolve(
                  optedOut !== undefined ? [{ userId, optedOut }] : [],
                );
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
          // isVcTrackingOptedOut chains .then() directly on the where result
          then: vi.fn(),
        };
      }),
    };
  });

  return { select, reset, tables, globalStore, guildStore };
});

// ─── Mock @workspace/db ───────────────────────────────────────────────────────
vi.mock("@workspace/db", () => ({
  db: {
    select: mocks.select,
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: vi.fn().mockResolvedValue([]),
        returning: vi.fn().mockResolvedValue([]),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([]),
        })),
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
import { isVcTrackingOptedOut } from "../lib/community.js";

// ─── Constants ────────────────────────────────────────────────────────────────
const USER  = "user-001";
const GUILD = "guild-alpha";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("isVcTrackingOptedOut: all four global × per-guild flag combinations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();
  });

  it("global=false, guild=false → returns false (user is not opted out)", async () => {
    // Seed both flags as explicitly opted-in
    mocks.globalStore.set(USER, false);
    mocks.guildStore.set(`${GUILD}:${USER}`, false);

    const result = await isVcTrackingOptedOut(GUILD, USER);

    expect(result).toBe(false);
  });

  it("global=false, guild=true → returns true (per-guild opt-out wins)", async () => {
    // Global: opted in; guild: opted out
    mocks.globalStore.set(USER, false);
    mocks.guildStore.set(`${GUILD}:${USER}`, true);

    const result = await isVcTrackingOptedOut(GUILD, USER);

    expect(result).toBe(true);
  });

  it("global=true, guild=false → returns true (global opt-out wins)", async () => {
    // Global: opted out; guild: opted in
    mocks.globalStore.set(USER, true);
    mocks.guildStore.set(`${GUILD}:${USER}`, false);

    const result = await isVcTrackingOptedOut(GUILD, USER);

    expect(result).toBe(true);
  });

  it("global=true, guild=true → returns true (both flags agree on opt-out)", async () => {
    // Both flags set to opted out
    mocks.globalStore.set(USER, true);
    mocks.guildStore.set(`${GUILD}:${USER}`, true);

    const result = await isVcTrackingOptedOut(GUILD, USER);

    expect(result).toBe(true);
  });

  it("no rows at all → returns false (brand-new user, never touched any privacy setting)", async () => {
    // Neither store is seeded — both selects return [] and row?.optedOut is undefined
    const result = await isVcTrackingOptedOut(GUILD, USER);

    expect(result).toBe(false);
  });

  it("global row exists with optedOut=null, guild row exists with optedOut=null → returns false", async () => {
    // A row exists in both stores but optedOut is null (e.g. from a partial insert
    // or a schema migration default). The guard `=== true` must reject null, not
    // treat it as truthy.
    mocks.globalStore.set(USER, null as unknown as boolean);
    mocks.guildStore.set(`${GUILD}:${USER}`, null as unknown as boolean);

    const result = await isVcTrackingOptedOut(GUILD, USER);

    expect(result).toBe(false);
  });
});
