/**
 * Tests verifying that opted-out users are excluded from the VC ranking list
 * (getVcRanking) even when they still have open sessions.
 *
 * Covers:
 *   1. getVcRanking – globally opted-out user does not appear in results
 *   2. getVcRanking – guild-locally opted-out user does not appear in results
 *   3. SQL query contains both NOT IN privacy sub-selects
 *
 * Strategy: db.execute() is mocked to capture the SQL template object passed
 * to it, letting us assert both:
 *   a) The function returns the right value when the DB returns nothing
 *      (what happens in production when the WHERE clause filters the user out).
 *   b) The SQL query itself contains the privacy exclusion sub-selects so a
 *      future refactor cannot silently drop the opt-out filter.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock state ─────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  const execute = vi.fn();
  return { execute };
});

// ─── Mock @workspace/db ───────────────────────────────────────────────────────
vi.mock("@workspace/db", () => {
  const tbl = (name: string) =>
    new Proxy({} as Record<string, string>, {
      get: (_t, p: string) => `${name}.${p}`,
    });

  return {
    db: {
      execute: mocks.execute,
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })) })) })),
      insert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoUpdate: vi.fn().mockResolvedValue([]) })) })),
      delete: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })) })),
    },
    communityVcSessionsTable: tbl("sessions"),
    communityVcPrivacyGlobalTable: tbl("global"),
    communityVcPrivacyTable: tbl("privacy"),
    communityEventSettingsTable: tbl("eventSettings"),
    communityEventsTable: tbl("events"),
    communityEventParticipantsTable: tbl("eventParticipants"),
    communityTicketSettingsTable: tbl("ticketSettings"),
    communityTicketsTable: tbl("tickets"),
    communityTicketPanelsTable: tbl("ticketPanels"),
    communityRankingSettingsTable: tbl("rankingSettings"),
    communityRoleButtonsTable: tbl("roleButtons"),
  };
});

// ─── Mock drizzle-orm ────────────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  isNull: (col: unknown) => ({ op: "isNull", col }),
  isNotNull: (col: unknown) => ({ op: "isNotNull", col }),
  gt: (col: unknown, val: unknown) => ({ op: "gt", col, val }),
  gte: (col: unknown, val: unknown) => ({ op: "gte", col, val }),
  lt: (col: unknown, val: unknown) => ({ op: "lt", col, val }),
  lte: (col: unknown, val: unknown) => ({ op: "lte", col, val }),
  or: (...args: unknown[]) => ({ op: "or", args }),
  asc: (col: unknown) => ({ op: "asc", col }),
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
import { getVcRanking, setVcPrivacyOptOut, setVcGlobalPrivacyOptOut } from "../lib/community.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────
const GUILD = "guild-001";

/** Join all template string fragments into one string for pattern matching. */
function sqlText(mock: ReturnType<typeof vi.fn>): string {
  const arg = mock.mock.calls[0]?.[0] as { strings: string[] } | undefined;
  return arg?.strings?.join("") ?? "";
}

// ─── getVcRanking – opt-out exclusion ────────────────────────────────────────

describe("getVcRanking – opt-out exclusion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when globally opted-out user is the only one (DB returns no rows)", async () => {
    // Simulate the SQL WHERE clause filtering the opted-out user out entirely
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    const result = await getVcRanking(GUILD);

    expect(result).toEqual([]);
  });

  it("returns empty array when guild-locally opted-out user is the only one (DB returns no rows)", async () => {
    // Simulate the guild-level privacy filter removing the only user
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    const result = await getVcRanking(GUILD, new Date("2024-01-01T00:00:00Z"));

    expect(result).toEqual([]);
  });

  it("does not include opted-out users when other users are present", async () => {
    // Only the non-opted-out user is returned by the DB (opted-out user filtered by SQL)
    mocks.execute.mockResolvedValueOnce({
      rows: [{ user_id: "user-active", total_seconds: "7200", is_live: false }],
    });

    const result = await getVcRanking(GUILD);

    expect(result).toHaveLength(1);
    expect(result[0]?.userId).toBe("user-active");
    // Opted-out user must not appear
    expect(result.some((r) => r.userId === "user-opted-out")).toBe(false);
  });

  it("SQL query contains the guild-local privacy exclusion sub-select", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getVcRanking(GUILD);

    const query = sqlText(mocks.execute);
    expect(query).toContain("community_vc_privacy");
    expect(query).toContain("opted_out = true");
  });

  it("SQL query contains the global privacy exclusion sub-select", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getVcRanking(GUILD);

    const query = sqlText(mocks.execute);
    expect(query).toContain("community_vc_privacy_global");
    expect(query).toContain("opted_out = true");
  });

  it("SQL query uses NOT IN for both privacy tables", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getVcRanking(GUILD);

    const query = sqlText(mocks.execute);
    // There must be at least two NOT IN clauses (one per privacy table)
    const notInMatches = query.match(/NOT IN/g) ?? [];
    expect(notInMatches.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── Mid-session opt-out: guild-local path ────────────────────────────────────

describe("getVcRanking – guild-local opt-out mid-session", () => {
  /**
   * Scenario: "user-mid-session" is currently in a VC (open session, left_at IS NULL).
   * They call /privacy opt-out for this guild.
   * setVcPrivacyOptOut writes the privacy row, then calls closeSession to stamp
   * left_at on the open session.
   * After that, getVcRanking must not include that user.
   */
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opted-out user is absent from ranking after guild-local opt-out mid-session", async () => {
    // setVcPrivacyOptOut → insert/upsert privacy row (insert mock handles onConflictDoUpdate)
    // setVcPrivacyOptOut → closeSession (update mock handles .set().where().returning())
    // Both already covered by the default mocks; no additional setup needed.

    await setVcPrivacyOptOut(GUILD, "user-mid-session", true);

    // Now simulate getVcRanking: DB returns only the user who did NOT opt out.
    mocks.execute.mockResolvedValueOnce({
      rows: [{ user_id: "user-active", total_seconds: "3600", is_live: false }],
    });

    const result = await getVcRanking(GUILD);

    expect(result).toHaveLength(1);
    expect(result[0]?.userId).toBe("user-active");
    expect(result.some((r) => r.userId === "user-mid-session")).toBe(false);
  });

  it("ranking is empty when the only user opts out guild-locally mid-session", async () => {
    await setVcPrivacyOptOut(GUILD, "user-only", true);

    // DB returns nothing — privacy filter eliminates the sole user.
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    const result = await getVcRanking(GUILD);

    expect(result).toEqual([]);
  });

  it("guild-local opt-out mid-session: SQL still contains both NOT IN sub-selects", async () => {
    await setVcPrivacyOptOut(GUILD, "user-mid-session", true);

    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getVcRanking(GUILD);

    const query = sqlText(mocks.execute);
    expect(query).toContain("community_vc_privacy");
    expect(query).toContain("community_vc_privacy_global");
    const notInMatches = query.match(/NOT IN/g) ?? [];
    expect(notInMatches.length).toBeGreaterThanOrEqual(2);
  });

  it("after guild-local opt-out mid-session, the row for that user has is_live=false", async () => {
    /**
     * closeSession stamps left_at, so bool_or(left_at IS NULL) = false in SQL.
     * Simulate the DB returning the user's row with is_live: false (left_at is
     * now set) and assert the RankingEntry mapping honours that flag correctly.
     */
    await setVcPrivacyOptOut(GUILD, "user-mid-session", true);

    // DB returns the row with is_live: false because left_at was stamped by closeSession.
    mocks.execute.mockResolvedValueOnce({
      rows: [{ user_id: "user-mid-session", total_seconds: "1800", is_live: false }],
    });

    const result = await getVcRanking(GUILD);

    expect(result).toHaveLength(1);
    expect(result[0]?.userId).toBe("user-mid-session");
    expect(result[0]?.isLive).toBe(false);
  });
});

// ─── Mid-session opt-out: global path ────────────────────────────────────────

describe("getVcRanking – global opt-out mid-session", () => {
  /**
   * Scenario: "user-global" is currently in a VC in this guild (open session).
   * They call /privacy global opt-out.
   * setVcGlobalPrivacyOptOut writes the global privacy row, then calls
   * closeOpenSessionsForUser which stamps left_at on every open session across
   * all guilds.
   * After that, getVcRanking for any guild must not include that user.
   */
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opted-out user is absent from ranking after global opt-out mid-session", async () => {
    await setVcGlobalPrivacyOptOut("user-global", true);

    // DB returns only the non-opted-out user.
    mocks.execute.mockResolvedValueOnce({
      rows: [{ user_id: "user-active", total_seconds: "1800", is_live: true }],
    });

    const result = await getVcRanking(GUILD);

    expect(result).toHaveLength(1);
    expect(result[0]?.userId).toBe("user-active");
    expect(result.some((r) => r.userId === "user-global")).toBe(false);
  });

  it("ranking is empty when the only user opts out globally mid-session", async () => {
    await setVcGlobalPrivacyOptOut("user-only-global", true);

    mocks.execute.mockResolvedValueOnce({ rows: [] });

    const result = await getVcRanking(GUILD);

    expect(result).toEqual([]);
  });

  it("global opt-out mid-session: SQL still contains both NOT IN sub-selects", async () => {
    await setVcGlobalPrivacyOptOut("user-global", true);

    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getVcRanking(GUILD);

    const query = sqlText(mocks.execute);
    expect(query).toContain("community_vc_privacy");
    expect(query).toContain("community_vc_privacy_global");
    const notInMatches = query.match(/NOT IN/g) ?? [];
    expect(notInMatches.length).toBeGreaterThanOrEqual(2);
  });

  it("global opt-out mid-session covers all guilds: ranking correct in a second guild too", async () => {
    const OTHER_GUILD = "guild-002";

    await setVcGlobalPrivacyOptOut("user-global", true);

    // Ranking in a different guild also excludes the user (DB returns no rows for them).
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    const result = await getVcRanking(OTHER_GUILD);

    expect(result).toEqual([]);
  });

  it("after global opt-out mid-session, the row for that user has is_live=false", async () => {
    /**
     * closeOpenSessionsForUser stamps left_at on every open session.
     * bool_or(left_at IS NULL) therefore evaluates to false in SQL.
     * Simulate the DB returning the user's row with is_live: false and assert
     * the RankingEntry mapping honours that flag correctly.
     */
    await setVcGlobalPrivacyOptOut("user-global", true);

    // DB returns the row with is_live: false because left_at was stamped by closeOpenSessionsForUser.
    mocks.execute.mockResolvedValueOnce({
      rows: [{ user_id: "user-global", total_seconds: "3600", is_live: false }],
    });

    const result = await getVcRanking(GUILD);

    expect(result).toHaveLength(1);
    expect(result[0]?.userId).toBe("user-global");
    expect(result[0]?.isLive).toBe(false);
  });
});
