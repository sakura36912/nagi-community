/**
 * Confirms that openSession returns null (fail-closed) when the privacy table
 * query inside isVcTrackingOptedOut rejects — for example, due to a DB error.
 *
 * No unhandled promise rejection should escape; the error must be caught and
 * silently turned into a null return value so the VoiceStateUpdate handler is
 * not disrupted.
 *
 * Mock pattern follows both-optouts-remove-guild.test.ts (stateful select mock
 * with per-table routing), but here we make the privacy table query reject to
 * trigger the fail-closed path.
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

  /**
   * Controls what each select chain returns.
   *
   * "reject" — the .where() promise rejects with a DB error
   * "resolve-empty" — the .where() promise resolves with []
   */
  type SelectBehaviour = "reject" | "resolve-empty";
  let globalBehaviour: SelectBehaviour = "resolve-empty";
  let privacyBehaviour: SelectBehaviour = "reject";

  const dbError = new Error("DB connection lost");

  // Each select() call creates an independent chain that captures `fromTable`
  // in its own closure — safe to run in parallel (Promise.all).
  const select = vi.fn(() => {
    let fromTable: unknown = null;
    return {
      from: vi.fn((table: unknown) => {
        fromTable = table;
        return {
          where: vi.fn((): Promise<unknown[]> => {
            if (fromTable === tables.global) {
              return globalBehaviour === "reject"
                ? Promise.reject(dbError)
                : Promise.resolve([]);
            }
            if (fromTable === tables.privacy) {
              return privacyBehaviour === "reject"
                ? Promise.reject(dbError)
                : Promise.resolve([]);
            }
            return Promise.resolve([]);
          }),
        };
      }),
    };
  });

  const insert = vi.fn(() => ({
    values: vi.fn(() => ({
      returning: vi.fn().mockResolvedValue([]),
    })),
  }));

  const reset = (opts: { global?: SelectBehaviour; privacy?: SelectBehaviour } = {}) => {
    globalBehaviour  = opts.global  ?? "resolve-empty";
    privacyBehaviour = opts.privacy ?? "reject";
  };

  return { select, insert, reset, tables, dbError };
});

// ─── Mock @workspace/db ───────────────────────────────────────────────────────
vi.mock("@workspace/db", () => ({
  db: {
    select: mocks.select,
    insert: mocks.insert,
  },
  communityVcPrivacyGlobalTable:     mocks.tables.global,
  communityVcPrivacyTable:           mocks.tables.privacy,
  communityVcSessionsTable:          mocks.tables.sessions,
  communityEventSettingsTable:       mocks.tables.eventSettings,
  communityEventsTable:              mocks.tables.events,
  communityEventParticipantsTable:   mocks.tables.eventParticipants,
  communityTicketSettingsTable:      mocks.tables.ticketSettings,
  communityTicketsTable:             mocks.tables.tickets,
  communityTicketPanelsTable:        mocks.tables.ticketPanels,
  communityRankingSettingsTable:     mocks.tables.rankingSettings,
  communityRoleButtonsTable:         mocks.tables.roleButtons,
}));

// ─── Mock logger ──────────────────────────────────────────────────────────────
const loggerMocks = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock("../lib/logger.js", () => ({
  logger: loggerMocks,
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
  or:  (...args: unknown[]) => ({ op: "or",  args }),
  asc:  (col: unknown) => ({ op: "asc",  col }),
  desc: (col: unknown) => ({ op: "desc", col }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: "sql", strings: Array.from(strings), values }),
    { raw: (v: unknown) => ({ op: "sql.raw", v }) },
  ),
}));

// ─── Import after mocks ───────────────────────────────────────────────────────
import { openSession } from "../lib/community.js";

// ─── Constants ────────────────────────────────────────────────────────────────
const GUILD   = "guild-001";
const USER    = "user-001";
const CHANNEL = "channel-001";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("openSession – privacy DB error logged for observability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls logger.warn exactly once when the privacy table query rejects", async () => {
    mocks.reset({ global: "resolve-empty", privacy: "reject" });

    await openSession(GUILD, USER, CHANNEL);

    expect(loggerMocks.warn).toHaveBeenCalledTimes(1);
  });

  it("includes guildId in the logger.warn payload", async () => {
    mocks.reset({ global: "resolve-empty", privacy: "reject" });

    await openSession(GUILD, USER, CHANNEL);

    expect(loggerMocks.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ guildId: GUILD }),
    );
  });

  it("includes userId in the logger.warn payload", async () => {
    mocks.reset({ global: "resolve-empty", privacy: "reject" });

    await openSession(GUILD, USER, CHANNEL);

    expect(loggerMocks.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ userId: USER }),
    );
  });

  it("includes the original error object in the logger.warn payload", async () => {
    mocks.reset({ global: "resolve-empty", privacy: "reject" });

    await openSession(GUILD, USER, CHANNEL);

    expect(loggerMocks.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ err: mocks.dbError }),
    );
  });

  it("calls logger.warn exactly once when the global privacy table query rejects", async () => {
    mocks.reset({ global: "reject", privacy: "resolve-empty" });

    await openSession(GUILD, USER, CHANNEL);

    expect(loggerMocks.warn).toHaveBeenCalledTimes(1);
  });

  it("includes guildId, userId, and err when the global table rejects", async () => {
    mocks.reset({ global: "reject", privacy: "resolve-empty" });

    await openSession(GUILD, USER, CHANNEL);

    expect(loggerMocks.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ guildId: GUILD, userId: USER, err: mocks.dbError }),
    );
  });
});

describe("openSession – privacy table DB error (fail-closed)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when the privacy table query rejects", async () => {
    // privacy select rejects; global select resolves empty (default from reset)
    mocks.reset({ global: "resolve-empty", privacy: "reject" });

    const result = await openSession(GUILD, USER, CHANNEL);

    expect(result).toBeNull();
  });

  it("does not throw or propagate the DB rejection to the caller", async () => {
    mocks.reset({ global: "resolve-empty", privacy: "reject" });

    // If openSession re-throws, this assertion itself would reject — that's
    // what we're guarding against.
    await expect(openSession(GUILD, USER, CHANNEL)).resolves.toBeNull();
  });

  it("makes no session insert when the privacy check fails", async () => {
    mocks.reset({ global: "resolve-empty", privacy: "reject" });

    await openSession(GUILD, USER, CHANNEL);

    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("returns null when the global privacy table query rejects", async () => {
    // global select rejects; isVcTrackingOptedOut uses Promise.all, so either
    // rejection causes the whole check to fail — openSession must still return null.
    mocks.reset({ global: "reject", privacy: "resolve-empty" });

    const result = await openSession(GUILD, USER, CHANNEL);

    expect(result).toBeNull();
  });

  it("makes no session insert when the global privacy check fails", async () => {
    mocks.reset({ global: "reject", privacy: "resolve-empty" });

    await openSession(GUILD, USER, CHANNEL);

    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("returns null when both privacy queries reject simultaneously", async () => {
    mocks.reset({ global: "reject", privacy: "reject" });

    const result = await openSession(GUILD, USER, CHANNEL);

    expect(result).toBeNull();
  });
});
