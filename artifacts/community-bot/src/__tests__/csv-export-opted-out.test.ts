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

  // ── OR semantics: removing one opt-out source must not clear the flag ─────
  //
  // This is the core invariant for task #257: the computed opted_out column uses
  // OR, not AND, to combine the two EXISTS subqueries.  If the connector were AND,
  // removing the per-guild opt-out row while the global one remains active would
  // silently flip opted_out to false — a privacy bug that would misrepresent the
  // user's actual opt-out status to the admin.
  //
  // The SQL-inspection test proves the OR is structurally present between the two
  // EXISTS blocks so that removing one source alone cannot satisfy a hypothetical
  // AND requirement.  The mapper test confirms that when the DB evaluates the
  // global-active / per-guild-absent path (resolved to opted_out=true via the
  // global EXISTS branch), the mapper faithfully surfaces optedOut:true.

  it("SQL uses OR so the global EXISTS alone is sufficient to set opted_out without the per-guild clause", async () => {
    // If OR is used, either EXISTS clause independently satisfies the condition.
    // An AND would require BOTH to be true simultaneously — meaning removing the
    // per-guild row while the global one remains would produce opted_out=false.
    // We verify the OR appears between the two EXISTS blocks (not AND as the
    // top-level connector), by inspecting the token immediately before the second
    // EXISTS keyword rather than slicing through the first subquery body (which
    // legitimately contains AND for its own WHERE conditions).
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getAllTempVcDeletions("guild-test");

    const sqlArg = mocks.execute.mock.calls[0]?.[0] as { strings: string[] };
    const text = sqlString(sqlArg);

    // Locate both EXISTS keywords.
    const firstExists  = text.indexOf("EXISTS");
    const secondExists = text.indexOf("EXISTS", firstExists + 1);
    expect(firstExists).toBeGreaterThanOrEqual(0);
    expect(secondExists).toBeGreaterThan(firstExists);

    // Look at the short window *before* the second EXISTS to find the top-level
    // connector. The first subquery closes with ")" and then the connector
    // follows before the next EXISTS keyword. Reading up to ~20 chars back is
    // enough to capture "OR" or "AND" at this level without including the
    // internals of the first subquery.
    const preamble = text.slice(Math.max(0, secondExists - 20), secondExists);
    // The connector must be OR, not AND.
    expect(preamble).toMatch(/\bOR\b/);
    expect(preamble).not.toMatch(/\bAND\b/);
  });

  it("mapper returns optedOut:true when global opt-out is active but per-guild opt-out row is absent", async () => {
    // Simulates the path where a user removed their per-guild opt-out but their
    // global opt-out remains.  The DB evaluates the OR of both EXISTS subqueries:
    // the global EXISTS returns true (global row present with opted_out=true),
    // so the computed column resolves to true even though the per-guild clause
    // would return false.  The mapper must not suppress this.
    mocks.execute.mockResolvedValueOnce({
      rows: [makeDbRow("global-opted-out-user", { opted_out: true })],
    });

    const result = await getAllTempVcDeletions("guild-test");

    expect(result).toHaveLength(1);
    expect(result[0]?.userId).toBe("global-opted-out-user");
    // The global opt-out is still active; optedOut must stay true even though
    // the per-guild row is absent (DB already resolved this via OR to true).
    expect(result[0]?.optedOut).toBe(true);
  });

  // ── OR semantics (symmetric): global removed, per-guild remains ───────────
  //
  // This is the symmetric counterpart to the tests above (task #257 direction).
  // When a user has BOTH a per-guild and a global opt-out active, removing only
  // the global opt-out row should leave optedOut:true because the per-guild
  // EXISTS clause still matches.  A regression to AND logic would require both
  // rows to be present and would silently flip the flag to false after the
  // global row is deleted — a privacy bug in the other direction.

  it("SQL uses OR so the per-guild EXISTS alone is sufficient to set opted_out without the global clause", async () => {
    // If OR is used, the per-guild EXISTS independently satisfies the condition
    // even when the global row is absent (or has opted_out=false).  An AND would
    // require BOTH EXISTS to be true simultaneously — meaning removing the global
    // row while the per-guild one remains would produce opted_out=false.
    // We verify the OR appears between the two EXISTS blocks by inspecting the
    // token immediately before the second EXISTS keyword, mirroring the approach
    // used in the symmetric test above.
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getAllTempVcDeletions("guild-test");

    const sqlArg = mocks.execute.mock.calls[0]?.[0] as { strings: string[] };
    const text = sqlString(sqlArg);

    // Locate both EXISTS keywords.
    const firstExists  = text.indexOf("EXISTS");
    const secondExists = text.indexOf("EXISTS", firstExists + 1);
    expect(firstExists).toBeGreaterThanOrEqual(0);
    expect(secondExists).toBeGreaterThan(firstExists);

    // The connector immediately before the second EXISTS must be OR, not AND.
    // Reading ~20 chars back captures the close-paren and whitespace of the
    // first subquery plus the connector, without entering the second subquery.
    const preamble = text.slice(Math.max(0, secondExists - 20), secondExists);
    expect(preamble).toMatch(/\bOR\b/);
    expect(preamble).not.toMatch(/\bAND\b/);

    // The per-guild subquery must itself exist and contain opted_out = true,
    // confirming it can independently satisfy the computed column when the
    // global row is absent.
    expect(text).toMatch(/community_vc_privacy\b[^)]*opted_out\s*=\s*true/s);
  });

  it("mapper returns optedOut:true when per-guild opt-out is active but global opt-out row is absent", async () => {
    // Simulates the path where a user removed their global opt-out but their
    // per-guild opt-out remains.  The DB evaluates the OR of both EXISTS subqueries:
    // the per-guild EXISTS returns true (per-guild row present with opted_out=true),
    // so the computed column resolves to true even though the global clause
    // would return false.  The mapper must faithfully surface optedOut:true.
    mocks.execute.mockResolvedValueOnce({
      rows: [makeDbRow("guild-opted-out-user", { opted_out: true })],
    });

    const result = await getAllTempVcDeletions("guild-test");

    expect(result).toHaveLength(1);
    expect(result[0]?.userId).toBe("guild-opted-out-user");
    // The per-guild opt-out is still active; optedOut must stay true even though
    // the global row is absent (DB already resolved this via OR to true).
    expect(result[0]?.optedOut).toBe(true);
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

  // ── Same userId, two rows, different opted_out values ─────────────────────
  //
  // The opted_out flag is computed per-session-row by EXISTS subqueries that
  // reflect the user's privacy state at query time.  A silent bug in a JOIN-based
  // rewrite (e.g. GROUP BY collapsing rows, or a DISTINCT that merges duplicates)
  // could flatten all rows for a user to the same flag value.
  //
  // These tests guard against that regression by feeding two rows for the same
  // userId with different opted_out values — exactly the shape that a faulty query
  // would collapse — and asserting that both rows survive with their distinct flags.
  //
  // Context: in the re-opt-in flow an export taken before opt-out and one taken
  // after re-opt-in show different flags, but both are taken at different moments
  // (separate db.execute calls).  The multi-row-same-user scenario can arise if
  // the DB computes opted_out at a boundary moment where rows for the same user
  // were written with different privacy states, or in any future refactor that
  // computes opted_out per-row rather than per-user.  The mapper must handle it
  // faithfully regardless of origin.

  it("maps two rows for the same userId independently when they carry different opted_out values", async () => {
    // Simulate the DB returning two completed sessions for the same user where
    // the opted_out column evaluates differently per row (e.g. a partial opt-out
    // recorded at a boundary, or a future per-row privacy implementation).
    // The mapper must not collapse them to a single flag value.
    const t1 = new Date("2025-03-01T10:00:00Z");
    const t2 = new Date("2025-04-01T10:00:00Z");
    mocks.execute.mockResolvedValueOnce({
      rows: [
        makeDbRow("same-user", { opted_out: false, leftAt: t1 }),
        makeDbRow("same-user", { opted_out: true,  leftAt: t2 }),
      ],
    });

    const result = await getAllTempVcDeletions("guild-test");

    expect(result).toHaveLength(2);
    // Both rows must survive — no de-duplication by userId.
    const flags = result.map((r) => r.optedOut);
    expect(flags).toContain(false);
    expect(flags).toContain(true);
    // The earlier row (opted_out=false) must keep its flag.
    const earlier = result.find((r) => r.leftAt.getTime() === t1.getTime());
    expect(earlier?.optedOut).toBe(false);
    // The later row (opted_out=true) must keep its flag.
    const later = result.find((r) => r.leftAt.getTime() === t2.getTime());
    expect(later?.optedOut).toBe(true);
  });

  it("preserves row count and per-row flags when the same userId appears multiple times", async () => {
    // Three rows for the same user: false, true, false.
    // A GROUP BY or DISTINCT bug would reduce this to one or two rows.
    const t1 = new Date("2025-01-01T10:00:00Z");
    const t2 = new Date("2025-02-01T10:00:00Z");
    const t3 = new Date("2025-03-01T10:00:00Z");
    mocks.execute.mockResolvedValueOnce({
      rows: [
        makeDbRow("multi-session-user", { opted_out: false, leftAt: t1 }),
        makeDbRow("multi-session-user", { opted_out: true,  leftAt: t2 }),
        makeDbRow("multi-session-user", { opted_out: false, leftAt: t3 }),
      ],
    });

    const result = await getAllTempVcDeletions("guild-test");

    expect(result).toHaveLength(3);
    const byTime = Object.fromEntries(
      result.map((r) => [r.leftAt.getTime(), r.optedOut]),
    );
    expect(byTime[t1.getTime()]).toBe(false);
    expect(byTime[t2.getTime()]).toBe(true);
    expect(byTime[t3.getTime()]).toBe(false);
  });

  // ── Per-user filter (userId option) ───────────────────────────────────────
  //
  // When an admin exports sessions scoped to a single user, getAllTempVcDeletions
  // must append `AND s.user_id = <userId>` to the WHERE clause so the DB driver
  // receives it as a bound parameter.  A silent bug — wrong column name, omitted
  // interpolation, or the predicate placed outside the WHERE — could leak other
  // users' rows, which is a privacy violation.
  //
  // Because db.execute is mocked at the JS boundary, we cannot run actual SQL.
  // Instead we inspect the sql-template object that the function passes to
  // db.execute.  The mock sql() tagged template returns
  // { op: "sql", strings: string[], values: unknown[] } and nested sql`` calls
  // are embedded as value objects, preserving their own strings/values.  We
  // locate the userFilter fragment by finding the nested object whose strings
  // contain "user_id" and assert both its predicate text and its parameter value.
  //
  // The mapper-passthrough test seeds the mock with rows for BOTH the target user
  // and an unrelated user (simulating what a buggy DB might return if the WHERE
  // predicate were missing).  It asserts the mapper returns all rows the DB gives
  // back — confirming there is no accidental app-level second filter that could
  // silently suppress legitimate rows.  Combined with the SQL-structure test, this
  // gives full coverage: the SQL predicate is correct, and the mapper is transparent.

  it("generates a WHERE predicate for user_id with the target userId as a bound parameter", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getAllTempVcDeletions("guild-test", { userId: "target-user" });

    const sqlArg = mocks.execute.mock.calls[0]?.[0] as {
      strings: string[];
      values: unknown[];
    };

    // The userFilter sql fragment is embedded as a nested value object.
    // We locate it by finding the fragment whose static strings reference user_id.
    type SqlFragment = { op: string; strings: string[]; values: unknown[] };
    const isSqlFragment = (v: unknown): v is SqlFragment =>
      typeof v === "object" &&
      v !== null &&
      "strings" in v &&
      Array.isArray((v as SqlFragment).strings);

    const userFilterFragment = sqlArg.values.find(
      (v): v is SqlFragment =>
        isSqlFragment(v) && (v as SqlFragment).strings.join("").includes("user_id"),
    ) as SqlFragment | undefined;

    // The fragment must exist — if userFilter is sql`` (empty) this fails.
    expect(userFilterFragment).toBeDefined();
    // The static SQL text must contain the correct column reference and operator.
    expect(userFilterFragment?.strings.join("")).toContain("AND s.user_id =");
    // The bound parameter must be the target userId — not a literal string in the SQL text.
    expect(userFilterFragment?.values).toContain("target-user");
  });

  it("returns only the target user's sessions when userId is set — not other users in the same guild", async () => {
    // SQL-aware mock: seed a pool containing both a target-user row and an
    // other-user row in the same guild.  The mock intercepts db.execute,
    // locates the userFilter sql fragment in the template values, extracts
    // the bound userId parameter from it, and applies the same equality
    // filter client-side before returning rows.
    //
    // This proves the full chain: the SQL encodes the userId as a bound
    // parameter in the correct predicate, and when that predicate is applied
    // (here: in the mock; in production: in PostgreSQL) only the target's
    // rows survive — the other user's session is excluded.
    const rowPool = [
      makeDbRow("target-user", { opted_out: false }),
      makeDbRow("other-user",  { opted_out: false }),
    ];

    type SqlFrag = { op: string; strings: string[]; values: unknown[] };
    const isSqlFrag = (v: unknown): v is SqlFrag =>
      typeof v === "object" &&
      v !== null &&
      "strings" in v &&
      Array.isArray((v as SqlFrag).strings);

    mocks.execute.mockImplementationOnce((sqlArg: { values: unknown[] }) => {
      // Find the userFilter fragment (the nested sql object whose static
      // strings reference user_id) among the outer template's values.
      const frag = sqlArg.values.find(
        (v): v is SqlFrag =>
          isSqlFrag(v) && v.strings.join("").includes("user_id"),
      ) as SqlFrag | undefined;

      // Apply the filter the same way PostgreSQL would: keep only rows
      // whose user_id matches the bound parameter in the fragment.
      const boundUserId = frag?.values[0];
      const filteredRows = boundUserId
        ? rowPool.filter((r) => r.user_id === boundUserId)
        : rowPool;

      return Promise.resolve({ rows: filteredRows });
    });

    const result = await getAllTempVcDeletions("guild-test", { userId: "target-user" });

    // Only the target user's session must be returned.
    expect(result).toHaveLength(1);
    expect(result[0]?.userId).toBe("target-user");
    // The other guild member's session must be excluded.
    expect(result.every((r) => r.userId === "target-user")).toBe(true);
  });
});
