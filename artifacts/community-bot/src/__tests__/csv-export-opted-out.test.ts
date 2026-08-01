/**
 * Confirms that getAllTempVcDeletions — the query backing the CSV export — returns
 * completed VC sessions for ALL users and includes an `optedOut` boolean flag so
 * admins can identify privacy-sensitive rows without a separate lookup.
 *
 * Audit rationale: the export is an administrative tool for compliance and record-keeping.
 * Opt-out only prevents NEW sessions from being recorded and closes any open session; it
 * does not erase historical (completed) sessions unless the user explicitly requests a
 * data wipe.  Therefore the CSV export intentionally includes opted-out users' rows, but
 * now flags them clearly with `optedOut: true`.
 *
 * Tested behaviours:
 *   1. The `optedOut` field is `true` when the DB row carries `opted_out: true`.
 *   2. The `optedOut` field is `false` when the DB row carries `opted_out: false`.
 *   3. The SQL query references both community_vc_privacy and community_vc_privacy_global.
 *   4. All session fields (id, guildId, userId, channelId, joinedAt, leftAt) are mapped.
 *   5. Date-range filters (start / end) are embedded in the SQL values.
 *   6. Results are ordered ascending by left_at (ORDER BY in the SQL string).
 *   7. Returns an empty array when no rows exist.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock state ─────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  const execute = vi.fn().mockResolvedValue({ rows: [] });
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
  and:       (...args: unknown[])              => ({ op: "and",      args }),
  eq:        (col: unknown, val: unknown)      => ({ op: "eq",       col, val }),
  isNull:    (col: unknown)                    => ({ op: "isNull",   col }),
  isNotNull: (col: unknown)                    => ({ op: "isNotNull", col }),
  gt:        (col: unknown, val: unknown)      => ({ op: "gt",       col, val }),
  gte:       (col: unknown, val: unknown)      => ({ op: "gte",      col, val }),
  lt:        (col: unknown, val: unknown)      => ({ op: "lt",       col, val }),
  lte:       (col: unknown, val: unknown)      => ({ op: "lte",      col, val }),
  or:        (...args: unknown[])              => ({ op: "or",       args }),
  asc:       (col: unknown)                    => ({ op: "asc",      col }),
  desc:      (col: unknown)                    => ({ op: "desc",     col }),
  notInArray:(col: unknown, val: unknown)      => ({ op: "notInArray", col, val }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: "sql", strings: Array.from(strings), values }),
    { raw: (v: unknown) => ({ op: "sql.raw", v }) },
  ),
}));

// ─── Import under test ────────────────────────────────────────────────────────
import { getAllTempVcDeletions } from "../lib/community.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal raw DB row (snake_case) as returned by db.execute.
 * `opted_out` defaults to false, matching the SQL subquery default.
 */
function makeDbRow(userId: string, opts: { opted_out?: boolean; leftAt?: Date } = {}) {
  const leftAt = opts.leftAt ?? new Date();
  return {
    id: Math.floor(Math.random() * 10_000),
    guild_id: "guild-test",
    user_id: userId,
    channel_id: "ch-1",
    joined_at: new Date(leftAt.getTime() - 60_000).toISOString(),
    left_at: leftAt.toISOString(),
    opted_out: opts.opted_out ?? false,
  };
}

/**
 * Extract the flat SQL string from a drizzle sql-mock object by joining its
 * `strings` array (the static parts of the template literal).
 */
function sqlString(sqlObj: { strings: string[] }): string {
  return sqlObj.strings.join("");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("getAllTempVcDeletions – opted_out column in CSV export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── opted_out flag mapping ─────────────────────────────────────────────────

  it("maps opted_out=true from the DB row to optedOut:true on the result", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [makeDbRow("opted-out-user", { opted_out: true })] });

    const result = await getAllTempVcDeletions("guild-test");

    expect(result).toHaveLength(1);
    expect(result[0]?.optedOut).toBe(true);
  });

  it("maps opted_out=false from the DB row to optedOut:false on the result", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [makeDbRow("active-user", { opted_out: false })] });

    const result = await getAllTempVcDeletions("guild-test");

    expect(result).toHaveLength(1);
    expect(result[0]?.optedOut).toBe(false);
  });

  it("treats a falsy opted_out value as optedOut:false", async () => {
    const row = makeDbRow("active-user");
    // Simulate DB returning null/undefined for opted_out
    (row as Record<string, unknown>)["opted_out"] = null;
    mocks.execute.mockResolvedValueOnce({ rows: [row] });

    const result = await getAllTempVcDeletions("guild-test");

    expect(result[0]?.optedOut).toBe(false);
  });

  it("returns both opted-out and active users with their correct flags", async () => {
    mocks.execute.mockResolvedValueOnce({
      rows: [
        makeDbRow("opted-out-user", { opted_out: true }),
        makeDbRow("active-user",    { opted_out: false }),
      ],
    });

    const result = await getAllTempVcDeletions("guild-test");

    expect(result).toHaveLength(2);
    const byUser = Object.fromEntries(result.map((r) => [r.userId, r.optedOut]));
    expect(byUser["opted-out-user"]).toBe(true);
    expect(byUser["active-user"]).toBe(false);
  });

  // ── Session field mapping ──────────────────────────────────────────────────

  it("maps all session fields from snake_case DB columns to camelCase properties", async () => {
    const leftAt = new Date("2025-06-15T10:00:00Z");
    const dbRow = makeDbRow("user-1", { leftAt });
    mocks.execute.mockResolvedValueOnce({ rows: [dbRow] });

    const [row] = await getAllTempVcDeletions("guild-test");

    expect(row?.id).toBe(dbRow.id);
    expect(row?.guildId).toBe("guild-test");
    expect(row?.userId).toBe("user-1");
    expect(row?.channelId).toBe("ch-1");
    expect(row?.joinedAt).toBeInstanceOf(Date);
    expect(row?.leftAt).toBeInstanceOf(Date);
    expect(row?.leftAt?.toISOString()).toBe(leftAt.toISOString());
  });

  // ── SQL content – privacy tables referenced ────────────────────────────────

  it("references community_vc_privacy_global in the SQL for global opt-out detection", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getAllTempVcDeletions("guild-test");

    const sqlArg = mocks.execute.mock.calls[0]?.[0] as { strings: string[] };
    expect(sqlString(sqlArg)).toContain("community_vc_privacy_global");
  });

  it("references community_vc_privacy in the SQL for per-guild opt-out detection", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getAllTempVcDeletions("guild-test");

    const sqlArg = mocks.execute.mock.calls[0]?.[0] as { strings: string[] };
    expect(sqlString(sqlArg)).toContain("community_vc_privacy");
  });

  it("selects opted_out as a computed column in the SQL", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getAllTempVcDeletions("guild-test");

    const sqlArg = mocks.execute.mock.calls[0]?.[0] as { strings: string[] };
    expect(sqlString(sqlArg)).toContain("opted_out");
  });

  // ── SQL content – ordering ─────────────────────────────────────────────────

  it("orders results ascending by left_at (ORDER BY s.left_at ASC)", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getAllTempVcDeletions("guild-test");

    const sqlArg = mocks.execute.mock.calls[0]?.[0] as { strings: string[] };
    const text = sqlString(sqlArg);
    expect(text).toContain("ORDER BY s.left_at ASC");
  });

  // ── SQL content – completed-only filter ───────────────────────────────────

  it("filters with left_at IS NOT NULL so open sessions are excluded", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getAllTempVcDeletions("guild-test");

    const sqlArg = mocks.execute.mock.calls[0]?.[0] as { strings: string[] };
    expect(sqlString(sqlArg)).toContain("left_at IS NOT NULL");
  });

  // ── Date-range filters ─────────────────────────────────────────────────────

  it("embeds the start date in SQL values when start is provided", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });
    const start = new Date("2025-01-01T00:00:00Z");

    await getAllTempVcDeletions("guild-test", { start });

    // The start date should appear in the interpolated values of the outer sql call
    const sqlArg = mocks.execute.mock.calls[0]?.[0] as { values: unknown[] };
    const flatValues = JSON.stringify(sqlArg.values);
    expect(flatValues).toContain(start.toISOString());
  });

  it("embeds the end date in SQL values when end is provided", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });
    const end = new Date("2025-02-01T00:00:00Z");

    await getAllTempVcDeletions("guild-test", { end });

    const sqlArg = mocks.execute.mock.calls[0]?.[0] as { values: unknown[] };
    const flatValues = JSON.stringify(sqlArg.values);
    expect(flatValues).toContain(end.toISOString());
  });

  it("embeds both start and end dates when both are provided", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });
    const start = new Date("2025-01-01T00:00:00Z");
    const end   = new Date("2025-02-01T00:00:00Z");

    await getAllTempVcDeletions("guild-test", { start, end });

    const sqlArg = mocks.execute.mock.calls[0]?.[0] as { values: unknown[] };
    const flatValues = JSON.stringify(sqlArg.values);
    expect(flatValues).toContain(start.toISOString());
    expect(flatValues).toContain(end.toISOString());
  });

  it("does not embed date values when neither start nor end is given", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getAllTempVcDeletions("guild-test");

    // Only guildId should appear as a value; no Date objects
    const sqlArg = mocks.execute.mock.calls[0]?.[0] as { values: unknown[] };
    const hasDateValue = sqlArg.values.some(
      (v) => v instanceof Date || (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)),
    );
    expect(hasDateValue).toBe(false);
  });

  // ── Re-opt-in: SQL predicate correctness ─────────────────────────────────
  //
  // These tests prove that the EXISTS subqueries require `opted_out = true` in
  // both the global and per-guild tables.  That predicate is what makes re-opt-in
  // safe: a row with `opted_out = false` (or a deleted row) will not satisfy the
  // EXISTS condition, so the computed column resolves to false.
  //
  // Because the mock intercepts db.execute before SQL reaches a real database, we
  // inspect the SQL template string that getAllTempVcDeletions builds and passes to
  // db.execute.  If either predicate is missing or weakened (e.g. changed to
  // `IS NOT NULL`), the relevant assertion below will catch it.

  it("global EXISTS subquery requires opted_out = true so a re-opted-in global row is excluded", async () => {
    // A global privacy row with opted_out=false (or a deleted row) must NOT satisfy
    // the global EXISTS subquery.  The SQL must contain the `opted_out = true`
    // predicate correlated on g.user_id = s.user_id inside the global table scan.
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getAllTempVcDeletions("guild-test");

    const sqlArg = mocks.execute.mock.calls[0]?.[0] as { strings: string[] };
    const text = sqlString(sqlArg);

    // The global subquery must reference the global table and require opted_out = true.
    // Without this predicate a user who re-opted-in globally would still appear opted out.
    expect(text).toContain("community_vc_privacy_global");
    expect(text).toMatch(/community_vc_privacy_global[^)]*opted_out\s*=\s*true/s);

    // The subquery must be correlated on user_id so it only matches the session's user.
    expect(text).toMatch(/community_vc_privacy_global[^)]*user_id\s*=\s*s\.user_id/s);
  });

  it("per-guild EXISTS subquery requires opted_out = true so a re-opted-in per-guild row is excluded", async () => {
    // A per-guild privacy row with opted_out=false must NOT satisfy the per-guild
    // EXISTS subquery.  The SQL must contain the `opted_out = true` predicate
    // correlated on both p.guild_id = s.guild_id and p.user_id = s.user_id.
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getAllTempVcDeletions("guild-test");

    const sqlArg = mocks.execute.mock.calls[0]?.[0] as { strings: string[] };
    const text = sqlString(sqlArg);

    // The per-guild subquery must reference the per-guild table and require opted_out = true.
    expect(text).toContain("community_vc_privacy");
    expect(text).toMatch(/community_vc_privacy\b[^)]*opted_out\s*=\s*true/s);

    // Correlation must cover both guild_id and user_id to avoid cross-guild leakage.
    expect(text).toMatch(/community_vc_privacy\b[^)]*guild_id\s*=\s*s\.guild_id/s);
    expect(text).toMatch(/community_vc_privacy\b[^)]*user_id\s*=\s*s\.user_id/s);
  });

  it("combines global and per-guild subqueries with OR so either source triggers opted-out", async () => {
    // The computed opted_out column is the OR of both EXISTS subqueries.
    // If the OR is missing, one re-opt-in path could leave the other source active
    // and the flag would still clear incorrectly.
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getAllTempVcDeletions("guild-test");

    const sqlArg = mocks.execute.mock.calls[0]?.[0] as { strings: string[] };
    const text = sqlString(sqlArg);

    // Both EXISTS clauses must appear.
    expect(text).toContain("community_vc_privacy_global");
    expect(text).toContain("community_vc_privacy");

    // They must be joined by OR (may have surrounding whitespace/newlines).
    expect(text).toMatch(/\bOR\b/);

    // Both are wrapped in EXISTS so the computed column is their disjunction.
    const existsMatches = [...text.matchAll(/\bEXISTS\b/g)];
    expect(existsMatches.length).toBeGreaterThanOrEqual(2);
  });

  it("mapper returns optedOut:false when DB resolves the subquery to false (per-guild re-opt-in path)", async () => {
    // This confirms the mapper correctly passes through false from the DB-evaluated
    // subquery.  The SQL predicate tests above prove the subquery only returns false
    // when opted_out is not true, making this the end-to-end picture: SQL filters
    // correctly → DB returns false → mapper returns false.
    mocks.execute.mockResolvedValueOnce({
      rows: [makeDbRow("re-opted-in-guild-user", { opted_out: false })],
    });

    const result = await getAllTempVcDeletions("guild-test");

    expect(result).toHaveLength(1);
    expect(result[0]?.userId).toBe("re-opted-in-guild-user");
    expect(result[0]?.optedOut).toBe(false);
  });

  it("mapper returns optedOut:false when DB resolves the subquery to null (global re-opt-in: row deleted)", async () => {
    // When a user deletes their global opt-out row entirely, the EXISTS finds no matching
    // row and the computed column evaluates to null/false.  The mapper must treat null
    // as false (not throw or silently coerce to true).
    const row = makeDbRow("re-opted-in-global-user");
    (row as Record<string, unknown>)["opted_out"] = null; // simulate deleted row → null from DB
    mocks.execute.mockResolvedValueOnce({ rows: [row] });

    const result = await getAllTempVcDeletions("guild-test");

    expect(result).toHaveLength(1);
    expect(result[0]?.userId).toBe("re-opted-in-global-user");
    expect(result[0]?.optedOut).toBe(false);
  });

  // ── Return value passthrough ───────────────────────────────────────────────

  it("returns an empty array when no rows exist", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    const result = await getAllTempVcDeletions("guild-test");

    expect(result).toEqual([]);
  });

  it("returns one mapped row per DB row", async () => {
    mocks.execute.mockResolvedValueOnce({
      rows: [
        makeDbRow("user-a", { opted_out: false }),
        makeDbRow("user-b", { opted_out: true }),
        makeDbRow("user-c", { opted_out: false }),
      ],
    });

    const result = await getAllTempVcDeletions("guild-test");

    expect(result).toHaveLength(3);
    const userIds = result.map((r) => r.userId);
    expect(userIds).toContain("user-a");
    expect(userIds).toContain("user-b");
    expect(userIds).toContain("user-c");
  });
});
