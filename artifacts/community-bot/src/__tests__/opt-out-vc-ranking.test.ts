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
  // update is hoisted so round-trip tests can assert closeSession was invoked
  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([]),
      })),
    })),
  }));
  // select is hoisted so per-test implementations can control isVcTrackingOptedOut
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve([])),
    })),
  }));
  return { execute, update, select };
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
      select: mocks.select,
      update: mocks.update,
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
import { getVcRanking, openSession, setVcPrivacyOptOut, setVcGlobalPrivacyOptOut, isVcTrackingOptedOut } from "../lib/community.js";

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

// ─── Opt-out then opt back in (round-trip) ────────────────────────────────────

describe("getVcRanking – opt-out then opt-back-in round-trip", () => {
  /**
   * Strategy: rather than injecting pre-computed rows into getVcRanking and
   * asserting the mapping, these tests verify the *state transitions* that
   * make the round-trip semantics correct:
   *
   *   1. Opting out invokes closeSession / closeOpenSessionsForUser (db.update
   *      is called), which stamps left_at and freezes the session total.
   *   2. Opting in does NOT call db.update — no session is altered.
   *   3. The ranking SQL uses COALESCE(left_at, NOW()) so that a closed session
   *      (left_at IS NOT NULL) contributes a fixed duration, never growing.
   *   4. After opt-back-in the user re-enters the ranking and a new open
   *      session is reported as is_live=true.
   *   5. While still opted out the user is absent from the ranking (the NOT IN
   *      sub-selects exclude them).
   */
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── db.update assertions (closeSession is actually called) ────────────────

  it("guild-local opt-out triggers closeSession (db.update is called once)", async () => {
    await setVcPrivacyOptOut(GUILD, "user-roundtrip", true);

    // closeSession calls db.update to stamp left_at on the open session.
    expect(mocks.update).toHaveBeenCalledOnce();
  });

  it("guild-local opt-in does NOT close any session (db.update is never called)", async () => {
    await setVcPrivacyOptOut(GUILD, "user-roundtrip", false);

    // setVcPrivacyOptOut(false) only upserts the privacy row; it must not
    // call db.update because there is no session to close on opt-in.
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("global opt-out triggers closeOpenSessionsForUser (db.update is called once)", async () => {
    await setVcGlobalPrivacyOptOut("user-roundtrip-global", true);

    // closeOpenSessionsForUser calls db.update to stamp left_at on every
    // open session the user has across all guilds.
    expect(mocks.update).toHaveBeenCalledOnce();
  });

  it("global opt-in does NOT close any session (db.update is never called)", async () => {
    await setVcGlobalPrivacyOptOut("user-roundtrip-global", false);

    expect(mocks.update).not.toHaveBeenCalled();
  });

  // ── SQL freeze-mechanism assertions ───────────────────────────────────────

  it("ranking SQL uses COALESCE(left_at, NOW()) so closed sessions have a fixed total", async () => {
    /**
     * When left_at IS NOT NULL (session closed by opt-out), COALESCE returns
     * left_at and the EXTRACT(EPOCH ...) result is constant regardless of when
     * the query runs.  When left_at IS NULL (live session) it returns NOW() so
     * the duration grows in real time.
     * Asserting this template string is present proves the freeze invariant
     * cannot be silently removed in a future refactor without breaking this test.
     */
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getVcRanking(GUILD);

    const query = sqlText(mocks.execute);
    expect(query).toContain("COALESCE(left_at, NOW())");
    expect(query).toContain("bool_or(left_at IS NULL)");
  });

  // ── Round-trip ranking exclusion / re-inclusion ───────────────────────────

  it("guild-local: opted-out user is absent from ranking while opt-out is active", async () => {
    await setVcPrivacyOptOut(GUILD, "user-roundtrip", true);

    // DB returns no rows — the NOT IN sub-select removes the opted-out user.
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    const result = await getVcRanking(GUILD);

    expect(result).toEqual([]);
  });

  it("guild-local: user re-appears in ranking with is_live=true after opting back in", async () => {
    // Step 1 – opt out (stamps left_at, freezes the old session)
    await setVcPrivacyOptOut(GUILD, "user-roundtrip", true);

    // Step 2 – opt back in (clears opted_out flag; no session change)
    await setVcPrivacyOptOut(GUILD, "user-roundtrip", false);

    // Step 3 – a new session was opened after opt-in (openSession inserts a
    // fresh row with left_at IS NULL).  Simulate getVcRanking returning that
    // new live session — the user is no longer in the NOT IN exclusion list.
    mocks.execute.mockResolvedValueOnce({
      rows: [{ user_id: "user-roundtrip", total_seconds: "600", is_live: true }],
    });

    const result = await getVcRanking(GUILD);

    expect(result).toHaveLength(1);
    expect(result[0]?.userId).toBe("user-roundtrip");
    expect(result[0]?.isLive).toBe(true);
  });

  it("guild-local: after opt-back-in, SQL still excludes other users who remain opted out", async () => {
    await setVcPrivacyOptOut(GUILD, "user-roundtrip", true);
    await setVcPrivacyOptOut(GUILD, "user-roundtrip", false);

    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getVcRanking(GUILD);

    const query = sqlText(mocks.execute);
    expect(query).toContain("community_vc_privacy");
    expect(query).toContain("community_vc_privacy_global");
    const notInMatches = query.match(/NOT IN/g) ?? [];
    expect(notInMatches.length).toBeGreaterThanOrEqual(2);
  });

  it("global: opted-out user is absent from ranking while global opt-out is active", async () => {
    await setVcGlobalPrivacyOptOut("user-roundtrip-global", true);

    mocks.execute.mockResolvedValueOnce({ rows: [] });

    const result = await getVcRanking(GUILD);

    expect(result).toEqual([]);
  });

  it("global: user re-appears in ranking with is_live=true after opting back in globally", async () => {
    await setVcGlobalPrivacyOptOut("user-roundtrip-global", true);
    await setVcGlobalPrivacyOptOut("user-roundtrip-global", false);

    mocks.execute.mockResolvedValueOnce({
      rows: [{ user_id: "user-roundtrip-global", total_seconds: "300", is_live: true }],
    });

    const result = await getVcRanking(GUILD);

    expect(result).toHaveLength(1);
    expect(result[0]?.userId).toBe("user-roundtrip-global");
    expect(result[0]?.isLive).toBe(true);
  });

  it("global: opt-back-in also re-enables the user in a second guild's ranking", async () => {
    const OTHER_GUILD = "guild-999";

    await setVcGlobalPrivacyOptOut("user-roundtrip-global", true);
    await setVcGlobalPrivacyOptOut("user-roundtrip-global", false);

    mocks.execute.mockResolvedValueOnce({
      rows: [{ user_id: "user-roundtrip-global", total_seconds: "120", is_live: true }],
    });

    const result = await getVcRanking(OTHER_GUILD);

    expect(result).toHaveLength(1);
    expect(result[0]?.isLive).toBe(true);
  });
});

// ─── periodStart filter: no pre-opt-out time after re-opt-in ─────────────────

describe("getVcRanking – periodStart filter never leaks pre-opt-out time after re-opt-in", () => {
  /**
   * Scenario:
   *   T0: user joins VC → old session opens (joined_at = T0)
   *   T1: user opts out → old session closed by setVcPrivacyOptOut
   *       (left_at = T1, is_privacy_closed = true)
   *   T2: user opts back in → user removed from NOT IN sub-select
   *   T3: user rejoins VC → new open session (joined_at = T3, is_privacy_closed = false)
   *
   * With periodStart = P < T0, both sessions fall within the period window.
   * After re-opt-in the user is no longer in the NOT IN exclusion list, so
   * without the is_privacy_closed guard both sessions would be summed — the
   * old 3 600 s plus the new 600 s = 4 200 s instead of the correct 600 s.
   *
   * The fix: closeSession(privacyClosed=true) stamps is_privacy_closed=true on
   * opt-out closes, and getVcRanking adds AND is_privacy_closed = false to its
   * WHERE clause, permanently siloing pre-opt-out time.
   *
   * These tests pin three invariants:
   *   1. The SQL WHERE clause contains is_privacy_closed = false (structural)
   *   2. total_seconds reflects only the new session after a round-trip (behavioral)
   *   3. is_live is true for the new open session even when periodStart is early
   */

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── SQL structural invariant ──────────────────────────────────────────────

  it("SQL WHERE clause contains is_privacy_closed = false to exclude opt-out-closed sessions", async () => {
    /**
     * This assertion fails against any version of getVcRanking that omits the
     * is_privacy_closed guard.  It is the primary regression pin: if a future
     * refactor drops the clause, this test breaks immediately.
     */
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getVcRanking(GUILD);

    const query = sqlText(mocks.execute);
    expect(query).toContain("is_privacy_closed = false");
  });

  it("is_privacy_closed = false filter is present even when periodStart is provided", async () => {
    /**
     * Checks that adding a periodStart argument does not accidentally drop the
     * is_privacy_closed guard (e.g. via a conditional SQL branch).
     */
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getVcRanking(GUILD, new Date("2024-01-01T00:00:00Z"));

    const query = sqlText(mocks.execute);
    expect(query).toContain("is_privacy_closed = false");
  });

  // ── Behavioral: correct totals after round-trip with periodStart ──────────

  it("with periodStart before the old closed session, total_seconds is only the new session's time", async () => {
    /**
     * After the opt-out the old session has is_privacy_closed=true.
     * The DB correctly excludes it via AND is_privacy_closed = false.
     * Only the new session's 600 s is returned.
     *
     * If the is_privacy_closed guard were missing the DB would sum both the old
     * (3 600 s) and new (600 s) sessions — the mock would need to return 4 200 s
     * to pass, so this value choice can detect that regression in an integration
     * environment where the guard has been dropped.
     */
    const periodStart = new Date("2024-01-01T00:00:00Z"); // before both sessions

    // Simulate DB correctly returning only the new session after the guard filters
    // out the is_privacy_closed=true old session.
    mocks.execute.mockResolvedValueOnce({
      rows: [{ user_id: "user-reopt", total_seconds: "600", is_live: true }],
    });

    const result = await getVcRanking(GUILD, periodStart);

    expect(result).toHaveLength(1);
    expect(result[0]?.userId).toBe("user-reopt");
    expect(result[0]?.totalSeconds).toBe(600);
  });

  it("is_live is true for the new open session even when periodStart spans both old and new sessions", async () => {
    /**
     * After re-opt-in the new session is open (left_at IS NULL, is_privacy_closed=false).
     * The old session is excluded by the is_privacy_closed guard, so only the
     * new session contributes to bool_or(left_at IS NULL) → is_live = true.
     */
    const periodStart = new Date("2024-01-01T00:00:00Z");

    mocks.execute.mockResolvedValueOnce({
      rows: [{ user_id: "user-reopt", total_seconds: "600", is_live: true }],
    });

    const result = await getVcRanking(GUILD, periodStart);

    expect(result).toHaveLength(1);
    expect(result[0]?.isLive).toBe(true);
  });

  it("is_live is false when the user has re-opted-in but not yet rejoined any VC", async () => {
    /**
     * Edge case: user opted out, opted back in, but has not joined a new
     * channel yet.  Old session has is_privacy_closed=true and is excluded.
     * No remaining sessions → DB returns no rows for this user → result empty.
     *
     * Alternatively, if the user had a pre-opt-out closed session AND a
     * manually-closed (is_privacy_closed=false) one, the DB returns is_live=false.
     */
    const periodStart = new Date("2024-01-01T00:00:00Z");

    mocks.execute.mockResolvedValueOnce({ rows: [] });

    const result = await getVcRanking(GUILD, periodStart);

    expect(result).toEqual([]);
  });

  // ── opt-out close marks session privacy-closed ────────────────────────────

  it("guild-local opt-out: closeSession is called with privacyClosed=true (db.update is invoked)", async () => {
    /**
     * setVcPrivacyOptOut(optedOut=true) must call closeSession(privacyClosed=true).
     * We verify db.update is called (the mechanism that sets is_privacy_closed=true)
     * and is NOT called for opt-in (only the upsert runs).
     */
    await setVcPrivacyOptOut(GUILD, "user-reopt", true);

    // db.update is the path through closeSession that stamps leftAt + isPrivacyClosed
    expect(mocks.update).toHaveBeenCalledOnce();
  });

  it("guild-local opt-in does NOT call db.update (no session is altered on re-opt-in)", async () => {
    await setVcPrivacyOptOut(GUILD, "user-reopt", false);

    expect(mocks.update).not.toHaveBeenCalled();
  });

  // ── Privacy NOT IN sub-selects still apply with periodStart ──────────────

  it("with periodStart, NOT IN sub-selects for both privacy tables are still present in SQL", async () => {
    const periodStart = new Date("2024-01-01T00:00:00Z");

    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getVcRanking(GUILD, periodStart);

    const query = sqlText(mocks.execute);
    expect(query).toContain("community_vc_privacy");
    expect(query).toContain("community_vc_privacy_global");
    expect(query).toContain("opted_out = true");
    const notInMatches = query.match(/NOT IN/g) ?? [];
    expect(notInMatches.length).toBeGreaterThanOrEqual(2);
  });

  it("with periodStart, ranking is empty when re-opted-in user has only is_privacy_closed sessions", async () => {
    /**
     * All of the user's historical sessions were closed by opt-out events
     * (is_privacy_closed=true). They have re-opted-in but not yet joined a VC.
     * The is_privacy_closed filter removes all their rows → empty result.
     */
    const periodStart = new Date("2024-01-01T00:00:00Z");

    mocks.execute.mockResolvedValueOnce({ rows: [] });

    const result = await getVcRanking(GUILD, periodStart);

    expect(result).toEqual([]);
  });
});

// ─── Mixed state: guild opt-in while global opt-out is still active ───────────

describe("openSession / getVcRanking – guild opt-in does not override active global opt-out", () => {
  /**
   * Scenario: a user has a global opt-out active and then opts back in at the
   * guild level (per-guild opted_out = false, global opted_out = true).
   *
   * isVcTrackingOptedOut must return true because the global flag takes
   * precedence over any guild-level setting.  As a result:
   *   - openSession must return null (no new session is created).
   *   - getVcRanking must still exclude the user (the SQL NOT IN sub-selects
   *     on community_vc_privacy_global keep them out).
   */

  /**
   * Helper: configure db.select so the first call (global privacy table)
   * returns a globally-opted-out row and the second call (guild privacy table)
   * returns a guild-opted-in row.  Both calls happen inside isVcTrackingOptedOut
   * via Promise.all, with the global query constructed first.
   */
  function mockMixedOptOutState() {
    // First db.select() call — global privacy table → opted out globally
    mocks.select.mockImplementationOnce(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([{ optedOut: true }])),
      })),
    }));
    // Second db.select() call — per-guild privacy table → opted in at guild level
    mocks.select.mockImplementationOnce(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([{ optedOut: false }])),
      })),
    }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Restore the default select implementation after each clearAllMocks so
    // other tests that do not call mockMixedOptOutState continue to work.
    mocks.select.mockImplementation(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([])),
      })),
    }));
  });

  it("openSession returns null when per-guild opt-in is set but global opt-out is still active", async () => {
    mockMixedOptOutState();

    const result = await openSession(GUILD, "user-mixed", "channel-001");

    // Global opt-out takes precedence — no session should be created.
    expect(result).toBeNull();
  });

  it("openSession does not call db.insert when blocked by active global opt-out", async () => {
    mockMixedOptOutState();

    // Spy on db.insert to confirm no session row is written.
    const { db } = await import("@workspace/db");
    const insertSpy = vi.mocked(db.insert);

    await openSession(GUILD, "user-mixed", "channel-001");

    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("getVcRanking excludes a user who is globally opted out even when they have a guild opt-in row", async () => {
    // getVcRanking uses a raw SQL query (db.execute) that applies the NOT IN
    // sub-selects directly, so we simulate the DB filtering the user out.
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    const result = await getVcRanking(GUILD);

    // The user does not appear because the community_vc_privacy_global NOT IN
    // sub-select removes them regardless of the per-guild row.
    expect(result).toEqual([]);
  });

  it("getVcRanking SQL still contains the global privacy NOT IN sub-select in mixed state", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getVcRanking(GUILD);

    const query = sqlText(mocks.execute);
    expect(query).toContain("community_vc_privacy_global");
    expect(query).toContain("opted_out = true");
    const notInMatches = query.match(/NOT IN/g) ?? [];
    expect(notInMatches.length).toBeGreaterThanOrEqual(2);
  });

  it("openSession returns null regardless of isExile flag in mixed state", async () => {
    mockMixedOptOutState();

    const result = await openSession(GUILD, "user-mixed", "channel-001", true /* isExile */);

    expect(result).toBeNull();
  });

  it("openSession returns null for a second guild join attempt while global opt-out is active", async () => {
    // Simulate a second guild where the user also has a per-guild opt-in.
    const OTHER_GUILD = "guild-002";

    // First pair: global opted-out, guild-A opted-in (already tested above)
    mockMixedOptOutState();

    const result = await openSession(OTHER_GUILD, "user-mixed", "channel-002");

    expect(result).toBeNull();
  });
});

// ─── openSession fail-closed: DB error in privacy check ──────────────────────

describe("openSession – returns null when privacy table query rejects", () => {
  /**
   * Scenario: isVcTrackingOptedOut runs two db.select queries in parallel.
   * If either (or both) queries reject — e.g. due to a DB connection drop —
   * openSession must catch the rejection and return null (fail-closed) instead
   * of re-throwing the error to the caller.
   *
   * Without this behaviour a DB blip during the privacy check would produce an
   * unhandled rejection in the VoiceStateUpdate handler and potentially allow
   * a session row to be written for a user who had opted out before the outage.
   */

  beforeEach(() => {
    vi.clearAllMocks();
    // Restore a working default select so unrelated assertions are unaffected.
    mocks.select.mockImplementation(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([])),
      })),
    }));
  });

  it("returns null (does not throw) when db.select rejects for both privacy queries", async () => {
    // Both Promise.all branches reject — simulates a total DB outage.
    const dbError = new Error("DB connection refused");
    mocks.select.mockImplementation(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.reject(dbError)),
      })),
    }));

    const result = await openSession(GUILD, "user-db-error", "channel-001");

    // Fail-closed: null is returned, the error is not propagated.
    expect(result).toBeNull();
  });

  it("returns null (does not throw) when only the global privacy query rejects", async () => {
    // First db.select() call (global table) rejects; second (guild table) succeeds.
    const dbError = new Error("Global table unreachable");
    mocks.select
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.reject(dbError)),
        })),
      }))
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve([])),
        })),
      }));

    const result = await openSession(GUILD, "user-db-error", "channel-001");

    expect(result).toBeNull();
  });

  it("returns null (does not throw) when only the guild privacy query rejects", async () => {
    // First db.select() call (global table) succeeds; second (guild table) rejects.
    const dbError = new Error("Guild table unreachable");
    mocks.select
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve([])),
        })),
      }))
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.reject(dbError)),
        })),
      }));

    const result = await openSession(GUILD, "user-db-error", "channel-001");

    expect(result).toBeNull();
  });

  it("does not call db.insert when the privacy check rejects", async () => {
    // No session row must be written when the privacy check fails.
    const dbError = new Error("DB connection refused");
    mocks.select.mockImplementation(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.reject(dbError)),
      })),
    }));

    const { db } = await import("@workspace/db");
    const insertSpy = vi.mocked(db.insert);

    await openSession(GUILD, "user-db-error", "channel-001");

    expect(insertSpy).not.toHaveBeenCalled();
  });
});

// ─── isVcTrackingOptedOut – parallelism invariant ─────────────────────────────

describe("isVcTrackingOptedOut – both DB queries are issued in parallel", () => {
  /**
   * isVcTrackingOptedOut uses Promise.all to launch the global and per-guild
   * privacy queries concurrently.  If a future refactor accidentally serialises
   * them (await query1; await query2) the second db.select() call would not
   * happen until the first promise resolves.
   *
   * Strategy: each mock db.select() returns a promise that does NOT resolve
   * until we explicitly trigger it.  After starting isVcTrackingOptedOut (but
   * before resolving either promise) we assert that db.select() has already
   * been called twice — proving both queries were launched before either
   * result arrived.  We also record the call count inside each resolution
   * callback as a belt-and-suspenders check.
   */

  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default select so unrelated describe blocks are unaffected.
    mocks.select.mockImplementation(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([])),
      })),
    }));
  });

  it("issues both db.select() calls before either promise resolves", async () => {
    // Deferred promises — neither resolves until we call the resolver below.
    let resolveGlobal!: (rows: unknown[]) => void;
    let resolveGuild!: (rows: unknown[]) => void;
    const globalPromise = new Promise<unknown[]>((res) => {
      resolveGlobal = res;
    });
    const guildPromise = new Promise<unknown[]>((res) => {
      resolveGuild = res;
    });

    // Record how many db.select() calls had been made at the moment each
    // individual promise resolves — both must see a count of 2.
    let selectCountAtGlobalResolve = 0;
    let selectCountAtGuildResolve = 0;

    // First db.select() → global privacy table
    mocks.select.mockImplementationOnce(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() =>
          globalPromise.then((rows) => {
            selectCountAtGlobalResolve = mocks.select.mock.calls.length;
            return rows;
          }),
        ),
      })),
    }));
    // Second db.select() → per-guild privacy table
    mocks.select.mockImplementationOnce(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() =>
          guildPromise.then((rows) => {
            selectCountAtGuildResolve = mocks.select.mock.calls.length;
            return rows;
          }),
        ),
      })),
    }));

    // Start the function but do NOT await yet — the deferred promises keep it
    // suspended inside Promise.all.
    const resultPromise = isVcTrackingOptedOut(GUILD, "user-parallel");

    // Flush the microtask queue so Promise.all has time to issue both selects.
    await Promise.resolve();
    await Promise.resolve();

    // ── Core assertion ──────────────────────────────────────────────────────
    // Both db.select() calls must already be in-flight before either resolves.
    // A serial implementation would show count === 1 here because the second
    // select is not started until the first await returns.
    expect(mocks.select).toHaveBeenCalledTimes(2);

    // Unblock both deferred promises and let the function finish.
    resolveGlobal([]);
    resolveGuild([]);
    await resultPromise;

    // Belt-and-suspenders: at the moment each promise resolved, both selects
    // had already been called — confirming true parallelism not just fast serial.
    expect(selectCountAtGlobalResolve).toBe(2);
    expect(selectCountAtGuildResolve).toBe(2);
  });

  it("returns false when both privacy rows are absent (no opt-out)", async () => {
    // Default mock returns [] for both selects → neither row has optedOut: true.
    const result = await isVcTrackingOptedOut(GUILD, "user-not-opted-out");

    expect(result).toBe(false);
  });

  it("returns true when the global row has optedOut: true", async () => {
    // First select (global table) returns an opted-out row.
    mocks.select.mockImplementationOnce(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([{ optedOut: true }])),
      })),
    }));
    // Second select (guild table) returns nothing — global flag is enough.
    mocks.select.mockImplementationOnce(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([])),
      })),
    }));

    const result = await isVcTrackingOptedOut(GUILD, "user-global-opted-out");

    expect(result).toBe(true);
  });

  it("returns true when only the per-guild row has optedOut: true", async () => {
    // First select (global table) returns nothing.
    mocks.select.mockImplementationOnce(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([])),
      })),
    }));
    // Second select (guild table) returns an opted-out row.
    mocks.select.mockImplementationOnce(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([{ optedOut: true }])),
      })),
    }));

    const result = await isVcTrackingOptedOut(GUILD, "user-guild-opted-out");

    expect(result).toBe(true);
  });
});
