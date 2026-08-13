/**
 * Verifies that isVcTrackingOptedOut initiates both DB queries in parallel
 * (via Promise.all) and never serialises them.
 *
 * Strategy: replace the select mock with deferred promises so neither query
 * auto-resolves. After calling isVcTrackingOptedOut (without awaiting), assert
 * that both where() handlers were already invoked — i.e. both queries were
 * started in the same synchronous batch before either settled.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock state ─────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
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

  const select = vi.fn();

  return { select, tables };
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
const USER  = "user-parallel";
const GUILD = "guild-parallel";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("isVcTrackingOptedOut: parallel query execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("initiates both DB queries before either one resolves", async () => {
    // Track which queries have been started (where() called = query initiated)
    const queriesStarted: Array<"global" | "guild"> = [];

    // Deferred resolvers — neither promise auto-resolves
    let resolveGlobal!: (rows: unknown[]) => void;
    let resolveGuild!:  (rows: unknown[]) => void;

    const globalPromise = new Promise<unknown[]>(resolve => { resolveGlobal = resolve; });
    const guildPromise  = new Promise<unknown[]>(resolve => { resolveGuild  = resolve; });

    // Wire select() to return controlled deferred promises
    mocks.select.mockImplementation(() => {
      let fromTable: unknown = null;
      return {
        from: vi.fn((table: unknown) => {
          fromTable = table;
          return {
            where: vi.fn((): Promise<unknown[]> => {
              if (fromTable === mocks.tables.global) {
                queriesStarted.push("global");
                return globalPromise;
              } else {
                queriesStarted.push("guild");
                return guildPromise;
              }
            }),
          };
        }),
      };
    });

    // Start the call — do NOT await yet so we can inspect before resolution
    const resultPromise = isVcTrackingOptedOut(GUILD, USER);

    // Yield to let the microtask queue flush Promise.all's internal machinery.
    // At this point neither globalPromise nor guildPromise has resolved, so
    // isVcTrackingOptedOut is still pending — but both where() calls must have
    // already been made synchronously inside Promise.all([...]).
    await Promise.resolve();

    // Both queries must be initiated before either settles
    expect(queriesStarted).toContain("global");
    expect(queriesStarted).toContain("guild");
    expect(queriesStarted).toHaveLength(2);

    // Now resolve both to let the function finish
    resolveGlobal([{ userId: USER, optedOut: false }]);
    resolveGuild([{ guildId: GUILD, userId: USER, optedOut: false }]);

    const result = await resultPromise;
    expect(result).toBe(false);
  });

  it("does not await the global query before starting the guild query", async () => {
    // Record timestamps (microtask-tick order) via an incrementing counter
    let tick = 0;
    const startTicks: Record<string, number> = {};

    let resolveGlobal!: (rows: unknown[]) => void;
    let resolveGuild!:  (rows: unknown[]) => void;

    // Global resolves only after an extra microtask delay
    const globalPromise = new Promise<unknown[]>(resolve => {
      resolveGlobal = resolve;
    }).then(rows => {
      // extra async hop to simulate a slow global query
      return new Promise<unknown[]>(r => setTimeout(() => r(rows), 0));
    });
    const guildPromise = new Promise<unknown[]>(resolve => { resolveGuild = resolve; });

    mocks.select.mockImplementation(() => {
      let fromTable: unknown = null;
      return {
        from: vi.fn((table: unknown) => {
          fromTable = table;
          return {
            where: vi.fn((): Promise<unknown[]> => {
              if (fromTable === mocks.tables.global) {
                startTicks["global"] = tick++;
                return globalPromise;
              } else {
                startTicks["guild"] = tick++;
                return guildPromise;
              }
            }),
          };
        }),
      };
    });

    const resultPromise = isVcTrackingOptedOut(GUILD, USER);
    await Promise.resolve();

    // Both queries must have been started in the same synchronous pass (tick 0 and 1)
    // If they were serialised, guild would only start after global resolved (tick >> 1)
    expect(startTicks["global"]).toBeDefined();
    expect(startTicks["guild"]).toBeDefined();
    // Both ticks are 0 and 1, meaning they were kicked off before any await
    expect(Math.max(startTicks["global"]!, startTicks["guild"]!)).toBeLessThan(2);

    resolveGlobal([]);
    resolveGuild([]);
    await resultPromise;
  });

  it("select() is called exactly twice — once per query — not in sequence", async () => {
    let resolveGlobal!: (rows: unknown[]) => void;
    let resolveGuild!:  (rows: unknown[]) => void;

    mocks.select.mockImplementation(() => {
      let fromTable: unknown = null;
      return {
        from: vi.fn((table: unknown) => {
          fromTable = table;
          return {
            where: vi.fn((): Promise<unknown[]> => {
              if (fromTable === mocks.tables.global) {
                return new Promise(r => { resolveGlobal = r; });
              }
              return new Promise(r => { resolveGuild = r; });
            }),
          };
        }),
      };
    });

    const resultPromise = isVcTrackingOptedOut(GUILD, USER);

    // Before awaiting, select must have been called twice already (parallel fan-out)
    await Promise.resolve();
    expect(mocks.select).toHaveBeenCalledTimes(2);

    resolveGlobal([]);
    resolveGuild([]);
    await resultPromise;
  });
});
