/**
 * Tests verifying that isVcTrackingOptedOut treats an existing global row with
 * opted_out=false the same as having no global row at all.
 *
 * Covers:
 *   1. isVcTrackingOptedOut returns false when the global table returns a row
 *      with optedOut=false and the per-guild table returns no row.
 *   2. openSession succeeds when the global row has optedOut=false (not just
 *      when the global row is absent).
 *
 * Mock pattern follows artifacts/community-bot/src/__tests__/global-opt-out-re-optin.test.ts.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock state ─────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
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
        };
      }),
    };
  });

  // ── Stateful insert ───────────────────────────────────────────────────────
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

  return { select, insert, update, reset, tables, globalStore, guildStore, sessionInserts };
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
import { isVcTrackingOptedOut, openSession } from "../lib/community.js";

// ─── Constants ────────────────────────────────────────────────────────────────
const USER    = "user-001";
const GUILD   = "guild-alpha";
const CHANNEL = "channel-001";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("isVcTrackingOptedOut: global row present with optedOut=false", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();
  });

  it("returns false when global row exists with optedOut=false and no per-guild row", async () => {
    // Seed a global row that is explicitly opted IN (optedOut=false)
    mocks.globalStore.set(USER, false);

    // No per-guild row
    expect(mocks.guildStore.has(`${GUILD}:${USER}`)).toBe(false);

    // The mock will return a row with optedOut=false — must not be treated as opted out
    const result = await isVcTrackingOptedOut(GUILD, USER);
    expect(result).toBe(false);
  });

  it("returns false when global row exists with optedOut=false even though it is not the default absent case", async () => {
    // Explicitly set optedOut=false — differs from the "no row" default
    mocks.globalStore.set(USER, false);

    const result = await isVcTrackingOptedOut(GUILD, USER);
    expect(result).toBe(false);
  });

  it("returns true when global row exists with optedOut=true (control: row presence alone does not opt out)", async () => {
    mocks.globalStore.set(USER, true);

    const result = await isVcTrackingOptedOut(GUILD, USER);
    expect(result).toBe(true);
  });

  it("returns true when global row has optedOut=false but per-guild row has optedOut=true", async () => {
    // Global: explicitly opted in
    mocks.globalStore.set(USER, false);
    // Per-guild: opted out
    mocks.guildStore.set(`${GUILD}:${USER}`, true);

    const result = await isVcTrackingOptedOut(GUILD, USER);
    expect(result).toBe(true);
  });
});

describe("openSession: global row present with optedOut=false", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();
  });

  it("succeeds (creates a session) when the global row has optedOut=false and no per-guild row", async () => {
    // Seed a global row with optedOut=false (simulates the state after opt-out → opt-in cycle)
    mocks.globalStore.set(USER, false);

    const session = await openSession(GUILD, USER, CHANNEL);

    expect(session).not.toBeNull();
    expect(session?.userId).toBe(USER);
    expect(session?.guildId).toBe(GUILD);
    expect(mocks.sessionInserts).toHaveLength(1);
  });

  it("returns null when global row has optedOut=false but per-guild row has optedOut=true", async () => {
    // Global opted in — but guild-level opt-out still blocks the session
    mocks.globalStore.set(USER, false);
    mocks.guildStore.set(`${GUILD}:${USER}`, true);

    const session = await openSession(GUILD, USER, CHANNEL);

    expect(session).toBeNull();
    expect(mocks.sessionInserts).toHaveLength(0);
  });
});
