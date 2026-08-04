/**
 * Focused tests confirming that calling setVcPrivacyOptOut(guildId, false)
 * (per-guild opt-in) does NOT unblock tracking when the global opt-out row
 * (optedOut=true) is still active.
 *
 * Two scenarios exercised:
 *   A. per-guild opt-in while global opt-out is true  → isVcTrackingOptedOut returns true
 *   B. both global and per-guild opt-outs cleared      → isVcTrackingOptedOut returns false
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
  setVcPrivacyOptOut,
  setVcGlobalPrivacyOptOut,
  isVcTrackingOptedOut,
} from "../lib/community.js";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("isVcTrackingOptedOut: per-guild opt-in does not unblock when global opt-out is still active", () => {
  const USER  = "user-perguild-optin-1";
  const GUILD = "guild-under-test";

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();
  });

  it("returns true when setVcPrivacyOptOut(guildId, false) is called while global optedOut=true", async () => {
    // Establish global opt-out
    await setVcGlobalPrivacyOptOut(USER, true);
    expect(mocks.globalStore.get(USER)).toBe(true);

    // Per-guild opt-in: user tries to opt back in for this specific guild
    await setVcPrivacyOptOut(GUILD, USER, false);
    expect(mocks.guildStore.get(`${GUILD}:${USER}`)).toBe(false);

    // Global opt-out is still set — tracking must remain blocked
    const result = await isVcTrackingOptedOut(GUILD, USER);
    expect(result).toBe(true);
  });

  it("returns false when both global and per-guild opt-outs are cleared", async () => {
    // Establish both opt-outs
    await setVcGlobalPrivacyOptOut(USER, true);
    await setVcPrivacyOptOut(GUILD, USER, true);

    expect(mocks.globalStore.get(USER)).toBe(true);
    expect(mocks.guildStore.get(`${GUILD}:${USER}`)).toBe(true);

    // Clear both
    await setVcGlobalPrivacyOptOut(USER, false);
    await setVcPrivacyOptOut(GUILD, USER, false);

    expect(mocks.globalStore.get(USER)).toBe(false);
    expect(mocks.guildStore.get(`${GUILD}:${USER}`)).toBe(false);

    // Both cleared — tracking must be unblocked
    const result = await isVcTrackingOptedOut(GUILD, USER);
    expect(result).toBe(false);
  });

  it("returns true when per-guild opt-in is the only action and global opt-out was never cleared", async () => {
    // Set global opt-out
    await setVcGlobalPrivacyOptOut(USER, true);

    // Do NOT clear the global; only attempt per-guild opt-in
    await setVcPrivacyOptOut(GUILD, USER, false);

    // Global is still active — verify store state
    expect(mocks.globalStore.get(USER)).toBe(true);

    const result = await isVcTrackingOptedOut(GUILD, USER);
    expect(result).toBe(true);
  });

  it("returns true for a guild that was never explicitly opted back in when global opt-out is active", async () => {
    // Global opt-out set; no per-guild action taken at all
    await setVcGlobalPrivacyOptOut(USER, true);

    expect(mocks.guildStore.has(`${GUILD}:${USER}`)).toBe(false);

    const result = await isVcTrackingOptedOut(GUILD, USER);
    expect(result).toBe(true);
  });

  it("remains blocked for GUILD_A after per-guild opt-in on GUILD_B while global opt-out is active", async () => {
    const GUILD_A = "guild-a";
    const GUILD_B = "guild-b";

    // Global opt-out
    await setVcGlobalPrivacyOptOut(USER, true);

    // Per-guild opt-in only for GUILD_B
    await setVcPrivacyOptOut(GUILD_B, USER, false);

    // GUILD_A had no per-guild action — still blocked by global
    const resultA = await isVcTrackingOptedOut(GUILD_A, USER);
    expect(resultA).toBe(true);

    // GUILD_B also still blocked because global opt-out takes priority
    const resultB = await isVcTrackingOptedOut(GUILD_B, USER);
    expect(resultB).toBe(true);
  });
});
