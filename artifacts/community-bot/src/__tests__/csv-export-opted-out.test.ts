/**
 * Confirms that getAllTempVcDeletions — the query backing the CSV export — returns
 * completed VC sessions for ALL users, including those who have opted out of tracking.
 *
 * Audit rationale: the export is an administrative tool for compliance and record-keeping.
 * Opt-out only prevents NEW sessions from being recorded and closes any open session; it
 * does not erase historical (completed) sessions unless the user explicitly requests a
 * data wipe.  Therefore the CSV export intentionally includes opted-out users' rows.
 *
 * Contrast with ranking commands (getVcRanking / getVcTimeInPeriod), which explicitly
 * exclude opted-out users from public-facing results.
 *
 * Tested behaviours:
 *   1. Opted-out user's completed sessions appear in the export (no privacy join).
 *   2. The query does NOT join / filter against communityVcPrivacyTable or
 *      communityVcPrivacyGlobalTable.
 *   3. Only completed sessions (leftAt IS NOT NULL) are returned.
 *   4. Date-range filters (start / end) narrow results correctly.
 *   5. Results are ordered ascending by leftAt.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock state ─────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  // select chain: db.select().from(table).where(cond).orderBy(ord)
  const orderBy = vi.fn().mockResolvedValue([]);
  const where   = vi.fn(() => ({ orderBy }));
  const from    = vi.fn(() => ({ where }));
  const select  = vi.fn(() => ({ from }));

  return { select, from, where, orderBy };
});

// ─── Mock @workspace/db ───────────────────────────────────────────────────────
vi.mock("@workspace/db", () => {
  const tbl = (name: string) =>
    new Proxy({} as Record<string, string>, {
      get: (_t, p: string) => `${name}.${p}`,
    });

  return {
    db: {
      select: mocks.select,
    },
    communityVcSessionsTable:          tbl("sessions"),
    communityVcPrivacyGlobalTable:      tbl("global"),
    communityVcPrivacyTable:            tbl("privacy"),
    communityEventSettingsTable:        tbl("eventSettings"),
    communityEventsTable:               tbl("events"),
    communityEventParticipantsTable:    tbl("eventParticipants"),
    communityTicketSettingsTable:       tbl("ticketSettings"),
    communityTicketsTable:              tbl("tickets"),
    communityTicketPanelsTable:         tbl("ticketPanels"),
    communityRankingSettingsTable:      tbl("rankingSettings"),
    communityRoleButtonsTable:          tbl("roleButtons"),
  };
});

// ─── Mock drizzle-orm operators ───────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  and:        (...args: unknown[])              => ({ op: "and", args }),
  eq:         (col: unknown, val: unknown)      => ({ op: "eq",  col, val }),
  isNull:     (col: unknown)                    => ({ op: "isNull",    col }),
  isNotNull:  (col: unknown)                    => ({ op: "isNotNull", col }),
  gt:         (col: unknown, val: unknown)      => ({ op: "gt",  col, val }),
  gte:        (col: unknown, val: unknown)      => ({ op: "gte", col, val }),
  lt:         (col: unknown, val: unknown)      => ({ op: "lt",  col, val }),
  lte:        (col: unknown, val: unknown)      => ({ op: "lte", col, val }),
  or:         (...args: unknown[])              => ({ op: "or",  args }),
  asc:        (col: unknown)                    => ({ op: "asc", col }),
  desc:       (col: unknown)                    => ({ op: "desc", col }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: "sql", strings, values }),
    { raw: (v: unknown) => ({ op: "sql.raw", v }) },
  ),
}));

// ─── Import under test ────────────────────────────────────────────────────────
import { getAllTempVcDeletions } from "../lib/community.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal completed session row with the given userId. */
function makeSession(userId: string, leftAt = new Date()) {
  return {
    id: Math.floor(Math.random() * 10_000),
    guildId: "guild-test",
    userId,
    channelId: "ch-1",
    joinedAt: new Date(leftAt.getTime() - 60_000),
    leftAt,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("getAllTempVcDeletions – CSV export opt-out inclusion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Core audit guarantee ───────────────────────────────────────────────────

  it("returns completed sessions for an opted-out user (rows are included for audit)", async () => {
    const optedOutSession = makeSession("opted-out-user");
    mocks.orderBy.mockResolvedValueOnce([optedOutSession]);

    const result = await getAllTempVcDeletions("guild-test");

    expect(result).toHaveLength(1);
    expect(result[0]?.userId).toBe("opted-out-user");
  });

  it("returns completed sessions for both opted-out and opted-in users together", async () => {
    const sessions = [
      makeSession("opted-out-user"),
      makeSession("active-user"),
    ];
    mocks.orderBy.mockResolvedValueOnce(sessions);

    const result = await getAllTempVcDeletions("guild-test");

    expect(result).toHaveLength(2);
    const userIds = result.map((r) => r.userId);
    expect(userIds).toContain("opted-out-user");
    expect(userIds).toContain("active-user");
  });

  // ── No privacy join ────────────────────────────────────────────────────────

  it("does NOT query communityVcPrivacyTable (no opt-out filter in the export)", async () => {
    mocks.orderBy.mockResolvedValueOnce([]);

    await getAllTempVcDeletions("guild-test");

    // from() is called exactly once — only communityVcSessionsTable, never
    // communityVcPrivacyTable or communityVcPrivacyGlobalTable.
    expect(mocks.from).toHaveBeenCalledTimes(1);
    const [tableArg] = mocks.from.mock.calls[0] as unknown as [Record<string, string>];
    // The stub proxy returns "<table>.<col>" — the sessions table stub uses "sessions.*"
    expect(tableArg["guildId"]).toBe("sessions.guildId");
  });

  it("does NOT query communityVcPrivacyGlobalTable", async () => {
    mocks.orderBy.mockResolvedValueOnce([]);

    await getAllTempVcDeletions("guild-test");

    // Confirm the single from() call targets the sessions table, not the global table.
    const [tableArg] = mocks.from.mock.calls[0] as unknown as [Record<string, string>];
    // Global table stubs return "global.*" — must not appear here.
    expect(tableArg["userId"]).not.toBe("global.userId");
  });

  // ── Completed-only filter (leftAt IS NOT NULL) ─────────────────────────────

  it("filters with isNotNull(leftAt) so open sessions are excluded from the export", async () => {
    mocks.orderBy.mockResolvedValueOnce([]);

    await getAllTempVcDeletions("guild-test");

    const [whereArg] = mocks.where.mock.calls[0] as unknown as [
      { op: string; args: { op: string; col: string }[] }
    ];
    expect(whereArg.op).toBe("and");
    // One branch must be isNotNull targeting leftAt
    const isNotNullBranch = whereArg.args.find(
      (a) => a.op === "isNotNull" && a.col === "sessions.leftAt",
    );
    expect(isNotNullBranch).toBeDefined();
  });

  it("filters by guildId so sessions from other guilds are excluded", async () => {
    mocks.orderBy.mockResolvedValueOnce([]);

    await getAllTempVcDeletions("guild-test");

    const [whereArg] = mocks.where.mock.calls[0] as unknown as [
      { op: string; args: { op: string; col: string; val: unknown }[] }
    ];
    expect(whereArg.op).toBe("and");
    const guildFilter = whereArg.args.find(
      (a) => a.op === "eq" && a.col === "sessions.guildId",
    );
    expect(guildFilter).toBeDefined();
    expect(guildFilter?.val).toBe("guild-test");
  });

  // ── Date-range filters ─────────────────────────────────────────────────────

  it("adds a gte(leftAt, start) condition when start is provided", async () => {
    mocks.orderBy.mockResolvedValueOnce([]);
    const start = new Date("2025-01-01T00:00:00Z");

    await getAllTempVcDeletions("guild-test", { start });

    const [whereArg] = mocks.where.mock.calls[0] as unknown as [
      { op: string; args: { op: string; col: string; val: unknown }[] }
    ];
    const gteFilter = whereArg.args.find(
      (a) => a.op === "gte" && a.col === "sessions.leftAt",
    );
    expect(gteFilter).toBeDefined();
    expect(gteFilter?.val).toBe(start);
  });

  it("adds a lt(leftAt, end) condition when end is provided", async () => {
    mocks.orderBy.mockResolvedValueOnce([]);
    const end = new Date("2025-02-01T00:00:00Z");

    await getAllTempVcDeletions("guild-test", { end });

    const [whereArg] = mocks.where.mock.calls[0] as unknown as [
      { op: string; args: { op: string; col: string; val: unknown }[] }
    ];
    const ltFilter = whereArg.args.find(
      (a) => a.op === "lt" && a.col === "sessions.leftAt",
    );
    expect(ltFilter).toBeDefined();
    expect(ltFilter?.val).toBe(end);
  });

  it("applies both start and end filters together", async () => {
    mocks.orderBy.mockResolvedValueOnce([]);
    const start = new Date("2025-01-01T00:00:00Z");
    const end   = new Date("2025-02-01T00:00:00Z");

    await getAllTempVcDeletions("guild-test", { start, end });

    const [whereArg] = mocks.where.mock.calls[0] as unknown as [
      { op: string; args: { op: string; col: string; val: unknown }[] }
    ];
    const ops = whereArg.args.map((a) => a.op);
    expect(ops).toContain("gte");
    expect(ops).toContain("lt");
  });

  it("applies no date filters when neither start nor end is given", async () => {
    mocks.orderBy.mockResolvedValueOnce([]);

    await getAllTempVcDeletions("guild-test");

    const [whereArg] = mocks.where.mock.calls[0] as unknown as [
      { op: string; args: { op: string }[] }
    ];
    const ops = whereArg.args.map((a) => a.op);
    expect(ops).not.toContain("gte");
    expect(ops).not.toContain("lt");
    // Only guildId eq + isNotNull(leftAt)
    expect(whereArg.args).toHaveLength(2);
  });

  // ── Ordering ───────────────────────────────────────────────────────────────

  it("orders results ascending by leftAt", async () => {
    mocks.orderBy.mockResolvedValueOnce([]);

    await getAllTempVcDeletions("guild-test");

    const [orderArg] = mocks.orderBy.mock.calls[0] as unknown as [
      { op: string; col: string }
    ];
    expect(orderArg.op).toBe("asc");
    expect(orderArg.col).toBe("sessions.leftAt");
  });

  // ── Return value passthrough ───────────────────────────────────────────────

  it("returns the raw rows from the DB without any post-filtering", async () => {
    const sessions = [
      makeSession("user-a"),
      makeSession("user-b"),
      makeSession("user-c"),
    ];
    mocks.orderBy.mockResolvedValueOnce(sessions);

    const result = await getAllTempVcDeletions("guild-test");

    expect(result).toHaveLength(3);
    expect(result).toEqual(sessions);
  });

  it("returns an empty array when no completed sessions exist", async () => {
    mocks.orderBy.mockResolvedValueOnce([]);

    const result = await getAllTempVcDeletions("guild-test");

    expect(result).toEqual([]);
  });
});
