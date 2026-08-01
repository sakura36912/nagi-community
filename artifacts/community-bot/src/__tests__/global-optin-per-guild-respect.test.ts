/**
 * Focused tests confirming that opting back in after a global opt-out
 * (setVcGlobalPrivacyOptOut(userId, false)) still respects per-guild
 * opt-outs when isVcTrackingOptedOut is queried directly.
 *
 * Two scenarios exercised:
 *   A. global cleared + per-guild opt-out still true  → isVcTrackingOptedOut returns true
 *   B. global cleared + no per-guild row              → isVcTrackingOptedOut returns false
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

  // ── Table proxies — created once so identity checks (===) work ──────────────
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

  // ── Condition helper — extract a scalar value from drizzle-orm mock ops ──────
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

  // ── Stateful select ───────────────────────────────────────────────────────────
  // Each select() call creates an independent chain (safe for Promise.all).
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
        };
      }),
    };
  });

  // ── Stateful insert (handles the onConflictDoUpdate upsert path) ──────────────
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
      returning: vi.fn().mockResolvedValue([]),
    })),
  }));

  // ── update (used by closeOpenSessionsForUser when optedOut=true) ──────────────
  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([]),
      })),
    })),
  }));

  return { select, insert, update, reset, tables, globalStore, guildStore };
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
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: "sql", strings, values }),
    { raw: (v: unknown) => ({ op: "sql.raw", v }) },
  ),
}));

// ─── Import under test ────────────────────────────────────────────────────────
import {
  setVcGlobalPrivacyOptOut,
  isVcTrackingOptedOut,
} from "../lib/community.js";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("isVcTrackingOptedOut after global opt-in: per-guild opt-outs are still respected", () => {
  const USER          = "user-optin-1";
  const GUILD_BLOCKED = "guild-still-blocked"; // has a per-guild opt-out
  const GUILD_OPEN    = "guild-now-open";       // no per-guild opt-out

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();
  });

  it("returns true for a guild with a per-guild opt-out even after the global opt-out is cleared", async () => {
    // Seed a per-guild opt-out for the blocked guild
    mocks.guildStore.set(`${GUILD_BLOCKED}:${USER}`, true);

    // Global opt-out, then clear it (opt-in)
    await setVcGlobalPrivacyOptOut(USER, true);
    await setVcGlobalPrivacyOptOut(USER, false);

    // Global store now reflects opt-in
    expect(mocks.globalStore.get(USER)).toBe(false);
    // Per-guild store is untouched
    expect(mocks.guildStore.get(`${GUILD_BLOCKED}:${USER}`)).toBe(true);

    // isVcTrackingOptedOut must still return true because the per-guild row is set
    const result = await isVcTrackingOptedOut(GUILD_BLOCKED, USER);
    expect(result).toBe(true);
  });

  it("returns false for a guild with no per-guild opt-out after the global opt-out is cleared", async () => {
    // Global opt-out, then clear it (opt-in); no per-guild row for GUILD_OPEN
    await setVcGlobalPrivacyOptOut(USER, true);
    await setVcGlobalPrivacyOptOut(USER, false);

    expect(mocks.globalStore.get(USER)).toBe(false);
    expect(mocks.guildStore.has(`${GUILD_OPEN}:${USER}`)).toBe(false);

    // With global cleared and no per-guild row, tracking is unblocked
    const result = await isVcTrackingOptedOut(GUILD_OPEN, USER);
    expect(result).toBe(false);
  });

  it("differentiates blocked and open guilds for the same user in the same call sequence", async () => {
    // Seed per-guild opt-out only for the blocked guild
    mocks.guildStore.set(`${GUILD_BLOCKED}:${USER}`, true);

    // Global opt-out then opt-in
    await setVcGlobalPrivacyOptOut(USER, true);
    await setVcGlobalPrivacyOptOut(USER, false);

    const [blockedResult, openResult] = await Promise.all([
      isVcTrackingOptedOut(GUILD_BLOCKED, USER),
      isVcTrackingOptedOut(GUILD_OPEN, USER),
    ]);

    // Blocked guild: per-guild opt-out still in effect
    expect(blockedResult).toBe(true);
    // Open guild: no per-guild opt-out, global cleared
    expect(openResult).toBe(false);
  });

  it("returns true immediately after global opt-out (sanity: global row is still set)", async () => {
    // Just the opt-out, no opt-in yet
    await setVcGlobalPrivacyOptOut(USER, true);

    expect(mocks.globalStore.get(USER)).toBe(true);

    const result = await isVcTrackingOptedOut(GUILD_OPEN, USER);
    expect(result).toBe(true);
  });

  it("per-guild opt-out row with optedOut=false does not block tracking after global opt-in", async () => {
    // Explicitly seed a per-guild row with optedOut=false (user previously opted back in guild-locally)
    mocks.guildStore.set(`${GUILD_OPEN}:${USER}`, false);

    // Global opt-out then opt-in
    await setVcGlobalPrivacyOptOut(USER, true);
    await setVcGlobalPrivacyOptOut(USER, false);

    const result = await isVcTrackingOptedOut(GUILD_OPEN, USER);
    expect(result).toBe(false);
  });
});
