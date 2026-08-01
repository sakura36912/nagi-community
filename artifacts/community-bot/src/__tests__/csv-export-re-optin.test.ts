/**
 * Confirms that the `opted_out` column in the CSV export transitions correctly
 * when a user opts out and then opts back in — covering both the per-guild path
 * (setVcPrivacyOptOut) and the global path (setVcGlobalPrivacyOptOut).
 *
 * Audit rationale: the opted_out flag in the export is computed at query time by
 * EXISTS subqueries that check the current state of the privacy tables.  After a
 * user calls opt-out and then opt-in, those rows have opted_out=false, so the
 * EXISTS predicate (`opted_out = true`) no longer fires and the computed column
 * resolves to false.
 *
 * The critical regression guard is at the SQL level: these tests inspect the SQL
 * template that getAllTempVcDeletions builds and passes to db.execute.  If either
 * `opted_out = true` predicate is weakened or removed (making re-opt-in invisible),
 * the assertions below will catch it.  Tests that only verify the mapper's false/true
 * passthrough are not sufficient on their own — the SQL inspection is what closes the
 * gap between "the mapper works" and "the DB would actually compute false after re-opt-in".
 *
 * Tested behaviours:
 *   1. Global EXISTS subquery requires `opted_out = true` so a re-opted-in global
 *      row (opted_out=false) is excluded from the computed column.
 *   2. Per-guild EXISTS subquery requires `opted_out = true` so a re-opted-in
 *      per-guild row (opted_out=false) is excluded.
 *   3. Both subqueries must be cleared before the computed column drops to false
 *      (OR logic: either active source keeps the flag set).
 *   4. Mapper correctly passes through opted_out=false from the DB row → optedOut:false.
 *   5. buildTempVcCsv writes "false" in the opted_out column after re-opt-in
 *      (per-guild path).
 *   6. buildTempVcCsv writes "false" in the opted_out column after re-opt-in
 *      (global path).
 *   7. The two-export transition sequence ("true" → "false") is reflected in the CSV.
 *   8. Another user's opted_out flag is unaffected when a different user re-opts-in.
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

  // db.insert: no-op stub — setVcPrivacyOptOut / setVcGlobalPrivacyOptOut call
  // this to upsert the privacy rows.  We don't need the upsert to mutate real
  // state; SQL inspection (below) is what verifies the EXISTS predicates.
  const insert = vi.fn((_table: unknown) => ({
    values: (_vals: unknown) => ({
      onConflictDoUpdate: (_opts: unknown) => Promise.resolve([]),
    }),
  }));

  // db.update: no-op stub — closeSession is called by setVcPrivacyOptOut when
  // optedOut=true; since sessions are already closed this is a no-op anyway.
  const update = vi.fn((_table: unknown) => ({
    set: (_vals: unknown) => ({
      where: (_cond: unknown) => ({
        returning: (_shape: unknown) => Promise.resolve([]),
      }),
    }),
  }));

  return {
    db: {
      insert,
      update,
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
  and:       (...args: unknown[])              => ({ op: "and",       args }),
  eq:        (col: unknown, val: unknown)      => ({ op: "eq",        col, val }),
  isNull:    (col: unknown)                    => ({ op: "isNull",    col }),
  isNotNull: (col: unknown)                    => ({ op: "isNotNull", col }),
  gt:        (col: unknown, val: unknown)      => ({ op: "gt",        col, val }),
  gte:       (col: unknown, val: unknown)      => ({ op: "gte",       col, val }),
  lt:        (col: unknown, val: unknown)      => ({ op: "lt",        col, val }),
  lte:       (col: unknown, val: unknown)      => ({ op: "lte",       col, val }),
  or:        (...args: unknown[])              => ({ op: "or",        args }),
  asc:       (col: unknown)                    => ({ op: "asc",       col }),
  desc:      (col: unknown)                    => ({ op: "desc",      col }),
  notInArray:(col: unknown, val: unknown)      => ({ op: "notInArray", col, val }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: "sql", strings: Array.from(strings), values }),
    { raw: (v: unknown) => ({ op: "sql.raw", v }) },
  ),
}));

// ─── Imports under test ───────────────────────────────────────────────────────
import {
  getAllTempVcDeletions,
  setVcPrivacyOptOut,
  setVcGlobalPrivacyOptOut,
  buildTempVcCsv,
} from "../lib/community.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract the flat SQL string from the sql-mock object (the static parts of the
 * template literal joined together — the same approach used in csv-export-opted-out.test.ts).
 */
function sqlString(sqlObj: { strings: string[] }): string {
  return sqlObj.strings.join("");
}

/**
 * Build a minimal raw DB row (snake_case) as returned by db.execute.
 */
function makeDbRow(userId: string, opts: { opted_out?: boolean } = {}) {
  const leftAt = new Date("2025-06-01T12:00:00.000Z");
  return {
    id:         1,
    guild_id:   "guild-test",
    user_id:    userId,
    channel_id: "ch-1",
    joined_at:  new Date(leftAt.getTime() - 60_000).toISOString(),
    left_at:    leftAt.toISOString(),
    opted_out:  opts.opted_out ?? false,
  };
}

/**
 * Extract the opted_out column value for a given userId from a CSV string.
 * Columns: id, user_id, channel_id, joined_at, left_at, duration_seconds, opted_out
 */
function getOptedOutFromCsv(csv: string, userId: string): string | undefined {
  const [_header, ...lines] = csv.split("\n");
  const row = lines.find((line) => line.split(",")[1] === userId);
  return row?.split(",").at(-1);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("opted_out column transitions in CSV export after re-opt-in", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── SQL predicate assertions (critical: these fail if EXISTS predicates break) ──
  //
  // The opted_out flag in the export is only correct at re-opt-in time if the
  // EXISTS subqueries include `opted_out = true`.  Without that predicate, a row
  // with opted_out=false would still satisfy the EXISTS check and the flag would
  // never clear.  These tests inspect the SQL that getAllTempVcDeletions emits.

  describe("SQL predicate guards — must fail if opted_out = true is removed", () => {
    it("global EXISTS subquery requires opted_out = true so a re-opted-in user is excluded from the flag", async () => {
      // A user who called setVcGlobalPrivacyOptOut(false) now has opted_out=false
      // in the global table.  The EXISTS subquery must NOT match that row.
      // The only way the computed column correctly drops to false is if the subquery
      // filters `g.opted_out = true` — removing that predicate would make any
      // existing row (regardless of value) trigger opted_out=true in the export.
      mocks.execute.mockResolvedValueOnce({ rows: [] });

      await getAllTempVcDeletions("guild-test");

      const sqlArg = mocks.execute.mock.calls[0]?.[0] as { strings: string[] };
      const text   = sqlString(sqlArg);

      expect(text).toContain("community_vc_privacy_global");
      // The predicate `opted_out = true` must be inside the global subquery.
      expect(text).toMatch(/community_vc_privacy_global[^)]*opted_out\s*=\s*true/s);
      // Correlation on user_id so the subquery scopes to the session's owner.
      expect(text).toMatch(/community_vc_privacy_global[^)]*user_id\s*=\s*s\.user_id/s);
    });

    it("per-guild EXISTS subquery requires opted_out = true so a re-opted-in per-guild row is excluded", async () => {
      // A user who called setVcPrivacyOptOut(false) now has opted_out=false in the
      // per-guild table.  The EXISTS subquery must not match that row, so the
      // computed column drops to false in the next export.
      mocks.execute.mockResolvedValueOnce({ rows: [] });

      await getAllTempVcDeletions("guild-test");

      const sqlArg = mocks.execute.mock.calls[0]?.[0] as { strings: string[] };
      const text   = sqlString(sqlArg);

      expect(text).toContain("community_vc_privacy");
      // The predicate `opted_out = true` must be inside the per-guild subquery.
      expect(text).toMatch(/community_vc_privacy\b[^)]*opted_out\s*=\s*true/s);
      // Both guild_id and user_id correlation — avoids cross-guild leakage.
      expect(text).toMatch(/community_vc_privacy\b[^)]*guild_id\s*=\s*s\.guild_id/s);
      expect(text).toMatch(/community_vc_privacy\b[^)]*user_id\s*=\s*s\.user_id/s);
    });

    it("the two EXISTS subqueries are combined with OR so either active source triggers opted-out", async () => {
      // After re-opting-in via one path, the other may still be active.  The OR
      // ensures the flag stays true until BOTH sources are cleared — which means
      // both `opted_out = true` predicates must each be wrapped in EXISTS and then
      // joined by OR.
      mocks.execute.mockResolvedValueOnce({ rows: [] });

      await getAllTempVcDeletions("guild-test");

      const sqlArg = mocks.execute.mock.calls[0]?.[0] as { strings: string[] };
      const text   = sqlString(sqlArg);

      // Both EXISTS must be present.
      const existsMatches = [...text.matchAll(/\bEXISTS\b/g)];
      expect(existsMatches.length).toBeGreaterThanOrEqual(2);
      // Joined by OR.
      expect(text).toMatch(/\bOR\b/);
    });

    it("SQL predicates are present even after setVcPrivacyOptOut is called (re-opt-in does not mutate the query)", async () => {
      // Confirm that the SQL shape is stable regardless of opt-in/out state changes.
      // setVcPrivacyOptOut only mutates the DB row; the SELECT query is built fresh
      // each time getAllTempVcDeletions is called and must always include the predicates.
      mocks.execute.mockResolvedValueOnce({ rows: [] });

      await setVcPrivacyOptOut("guild-test", "user-1", false);
      await getAllTempVcDeletions("guild-test");

      const sqlArg = mocks.execute.mock.calls[0]?.[0] as { strings: string[] };
      const text   = sqlString(sqlArg);

      expect(text).toMatch(/community_vc_privacy_global[^)]*opted_out\s*=\s*true/s);
      expect(text).toMatch(/community_vc_privacy\b[^)]*opted_out\s*=\s*true/s);
    });

    it("SQL predicates are present even after setVcGlobalPrivacyOptOut is called", async () => {
      mocks.execute.mockResolvedValueOnce({ rows: [] });

      await setVcGlobalPrivacyOptOut("user-1", false);
      await getAllTempVcDeletions("guild-test");

      const sqlArg = mocks.execute.mock.calls[0]?.[0] as { strings: string[] };
      const text   = sqlString(sqlArg);

      expect(text).toMatch(/community_vc_privacy_global[^)]*opted_out\s*=\s*true/s);
      expect(text).toMatch(/community_vc_privacy\b[^)]*opted_out\s*=\s*true/s);
    });
  });

  // ── Mapper: DB row false → optedOut:false ─────────────────────────────────
  //
  // When the DB evaluates the EXISTS subqueries to false (because opted_out=false
  // or the row no longer exists), the raw row carries opted_out=false.  The mapper
  // must pass that through as optedOut:false rather than coercing it.

  describe("mapper correctly reflects DB-evaluated opted_out=false after re-opt-in", () => {
    it("getAllTempVcDeletions returns optedOut:false when DB row has opted_out=false (per-guild re-opt-in path)", async () => {
      // After the user calls setVcPrivacyOptOut(false), the real DB would evaluate
      // the EXISTS subquery to false and return opted_out=false on the row.
      // This test confirms the mapper does not flip that back to true.
      mocks.execute.mockResolvedValueOnce({
        rows: [makeDbRow("user-1", { opted_out: false })],
      });

      const rows = await getAllTempVcDeletions("guild-test");

      expect(rows).toHaveLength(1);
      expect(rows[0]?.optedOut).toBe(false);
    });

    it("getAllTempVcDeletions returns optedOut:false when DB row has opted_out=false (global re-opt-in path)", async () => {
      mocks.execute.mockResolvedValueOnce({
        rows: [makeDbRow("user-1", { opted_out: false })],
      });

      const rows = await getAllTempVcDeletions("guild-test");

      expect(rows).toHaveLength(1);
      expect(rows[0]?.optedOut).toBe(false);
    });

    it("mapper returns optedOut:false when DB returns null for opted_out (row deleted — global re-opt-in via wipe)", async () => {
      // When a user deletes their global opt-out row entirely, the EXISTS finds no
      // match and the computed column is null.  The mapper must treat null as false.
      const row = makeDbRow("user-1");
      (row as Record<string, unknown>)["opted_out"] = null;
      mocks.execute.mockResolvedValueOnce({ rows: [row] });

      const rows = await getAllTempVcDeletions("guild-test");

      expect(rows[0]?.optedOut).toBe(false);
    });
  });

  // ── CSV transition: "true" → "false" across two exports ──────────────────
  //
  // These tests simulate the full user flow:
  //   1. User opts out → first export → opted_out column = "true"
  //   2. User re-opts-in → second export → opted_out column = "false"
  //
  // The opted_out value in each export comes from what the DB would return given
  // the current privacy row state.  setVcPrivacyOptOut / setVcGlobalPrivacyOptOut
  // update the DB row; the next getAllTempVcDeletions call re-runs the EXISTS
  // subqueries against those updated rows.
  //
  // Because the SQL inspection tests above confirm both EXISTS predicates require
  // `opted_out = true`, these transition tests close the full picture:
  //   SQL correct (predicates in place) + mapper correct (false passes through)
  //   → CSV reflects the re-opt-in.

  describe("CSV opted_out column transitions from \"true\" to \"false\" after re-opt-in", () => {
    it("per-guild path: CSV shows \"true\" before re-opt-in, then \"false\" after", async () => {
      // First export: user is opted out → DB evaluates EXISTS to true.
      mocks.execute.mockResolvedValueOnce({
        rows: [makeDbRow("user-1", { opted_out: true })],
      });

      await setVcPrivacyOptOut("guild-test", "user-1", true);
      const rowsBefore = await getAllTempVcDeletions("guild-test");
      const csvBefore  = buildTempVcCsv(rowsBefore);
      expect(getOptedOutFromCsv(csvBefore, "user-1")).toBe("true");

      // Verify SQL predicates on the first call.
      const sqlFirst = mocks.execute.mock.calls[0]?.[0] as { strings: string[] };
      expect(sqlString(sqlFirst)).toMatch(/community_vc_privacy\b[^)]*opted_out\s*=\s*true/s);

      // Second export: user re-opts-in → DB evaluates EXISTS to false.
      mocks.execute.mockResolvedValueOnce({
        rows: [makeDbRow("user-1", { opted_out: false })],
      });

      await setVcPrivacyOptOut("guild-test", "user-1", false);
      const rowsAfter = await getAllTempVcDeletions("guild-test");
      const csvAfter  = buildTempVcCsv(rowsAfter);
      expect(getOptedOutFromCsv(csvAfter, "user-1")).toBe("false");

      // Verify SQL predicates are still present on the second call.
      const sqlSecond = mocks.execute.mock.calls[1]?.[0] as { strings: string[] };
      expect(sqlString(sqlSecond)).toMatch(/community_vc_privacy\b[^)]*opted_out\s*=\s*true/s);
    });

    it("global path: CSV shows \"true\" before re-opt-in, then \"false\" after", async () => {
      // First export: globally opted out → DB evaluates global EXISTS to true.
      mocks.execute.mockResolvedValueOnce({
        rows: [makeDbRow("user-1", { opted_out: true })],
      });

      await setVcGlobalPrivacyOptOut("user-1", true);
      const rowsBefore = await getAllTempVcDeletions("guild-test");
      const csvBefore  = buildTempVcCsv(rowsBefore);
      expect(getOptedOutFromCsv(csvBefore, "user-1")).toBe("true");

      // Verify SQL predicate on the first call.
      const sqlFirst = mocks.execute.mock.calls[0]?.[0] as { strings: string[] };
      expect(sqlString(sqlFirst)).toMatch(/community_vc_privacy_global[^)]*opted_out\s*=\s*true/s);

      // Second export: user re-opts-in globally → DB evaluates global EXISTS to false.
      mocks.execute.mockResolvedValueOnce({
        rows: [makeDbRow("user-1", { opted_out: false })],
      });

      await setVcGlobalPrivacyOptOut("user-1", false);
      const rowsAfter = await getAllTempVcDeletions("guild-test");
      const csvAfter  = buildTempVcCsv(rowsAfter);
      expect(getOptedOutFromCsv(csvAfter, "user-1")).toBe("false");

      // Verify SQL predicate still present on the second call.
      const sqlSecond = mocks.execute.mock.calls[1]?.[0] as { strings: string[] };
      expect(sqlString(sqlSecond)).toMatch(/community_vc_privacy_global[^)]*opted_out\s*=\s*true/s);
    });

    it("another user's opted_out flag is unaffected when a different user re-opts-in", async () => {
      // After re-opt-in, the export for the same guild still shows opted_out=true
      // for a user who has not re-opted-in.
      mocks.execute.mockResolvedValueOnce({
        rows: [
          makeDbRow("re-optin-user",  { opted_out: false }),
          makeDbRow("still-out-user", { opted_out: true  }),
        ],
      });

      await setVcPrivacyOptOut("guild-test", "re-optin-user", false);
      const rows = await getAllTempVcDeletions("guild-test");

      const byUser = Object.fromEntries(rows.map((r) => [r.userId, r.optedOut]));
      expect(byUser["re-optin-user"]).toBe(false);
      expect(byUser["still-out-user"]).toBe(true);
    });

    it("CSV header includes opted_out as the last column after a re-opt-in export", async () => {
      mocks.execute.mockResolvedValueOnce({
        rows: [makeDbRow("user-1", { opted_out: false })],
      });

      await setVcPrivacyOptOut("guild-test", "user-1", false);
      const rows = await getAllTempVcDeletions("guild-test");
      const csv  = buildTempVcCsv(rows);
      const header = csv.split("\n")[0]?.split(",");

      expect(header?.at(-1)).toBe("opted_out");
    });
  });
});
