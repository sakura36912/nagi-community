/**
 * Tests for countCompletedSessionsOlderThan.
 *
 * Confirms that:
 *   (a) The count reflects only completed sessions (left_at IS NOT NULL) for
 *       the target guild older than the given day threshold.
 *   (b) Active sessions (left_at IS NULL) are never included in the count —
 *       the SQL query always filters them out.
 *   (c) Sessions from other guilds do not bleed into the count.
 *   (d) When no sessions match the criteria the function returns 0.
 *   (e) The cutoff date passed to the query corresponds to the requested days.
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
      insert: vi.fn(),
      select: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    communityVcSessionsTable:       tbl("sessions"),
    communityVcPrivacyTable:         tbl("privacy"),
    communityVcPrivacyGlobalTable:   tbl("global"),
    communityEventSettingsTable:     tbl("eventSettings"),
    communityEventsTable:            tbl("events"),
    communityEventParticipantsTable: tbl("eventParticipants"),
    communityTicketSettingsTable:    tbl("ticketSettings"),
    communityTicketsTable:           tbl("tickets"),
    communityTicketPanelsTable:      tbl("ticketPanels"),
    communityRankingSettingsTable:   tbl("rankingSettings"),
    communityRoleButtonsTable:       tbl("roleButtons"),
  };
});

// ─── Mock drizzle-orm ─────────────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  and:       (...args: unknown[]) => ({ op: "and", args }),
  eq:        (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  isNull:    (col: unknown) => ({ op: "isNull", col }),
  isNotNull: (col: unknown) => ({ op: "isNotNull", col }),
  lt:        (col: unknown, val: unknown) => ({ op: "lt", col, val }),
  lte:       (col: unknown, val: unknown) => ({ op: "lte", col, val }),
  gt:        (col: unknown, val: unknown) => ({ op: "gt", col, val }),
  gte:       (col: unknown, val: unknown) => ({ op: "gte", col, val }),
  or:        (...args: unknown[]) => ({ op: "or", args }),
  asc:       (col: unknown) => ({ op: "asc", col }),
  desc:      (col: unknown) => ({ op: "desc", col }),
  notInArray:(col: unknown, vals: unknown) => ({ op: "notInArray", col, vals }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: "sql", strings, values }),
    { raw: (v: unknown) => ({ op: "sql.raw", v }) },
  ),
}));

// ─── Import under test (resolved after mocks) ────────────────────────────────

import { countCompletedSessionsOlderThan } from "../lib/community.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns the interpolated sql template values from the most recent execute call. */
function lastExecuteValues(): unknown[] {
  const [[sqlObj]] = mocks.execute.mock.calls as [[{ op: string; values: unknown[] }]];
  return sqlObj.values;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

describe("countCompletedSessionsOlderThan", () => {
  // ── Return value ────────────────────────────────────────────────────────────

  it("returns the integer count reported by the DB", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ cnt: "7" }] });

    const result = await countCompletedSessionsOlderThan("guild-abc", 30);

    expect(result).toBe(7);
  });

  it("returns 0 when no sessions match (empty rows array)", async () => {
    mocks.execute.mockResolvedValue({ rows: [] });

    const result = await countCompletedSessionsOlderThan("guild-abc", 30);

    expect(result).toBe(0);
  });

  it("returns 0 when the DB reports cnt as '0'", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ cnt: "0" }] });

    const result = await countCompletedSessionsOlderThan("guild-abc", 30);

    expect(result).toBe(0);
  });

  it("correctly converts large bigint-style strings to a number", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ cnt: "1234" }] });

    const result = await countCompletedSessionsOlderThan("guild-abc", 180);

    expect(result).toBe(1234);
  });

  // ── Guild isolation ─────────────────────────────────────────────────────────

  it("binds the guildId to the guild_id column predicate in the SQL", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ cnt: "3" }] });

    await countCompletedSessionsOlderThan("guild-target", 60);

    // Inspect the tagged-template structure: strings[i] is the static fragment
    // that precedes values[i].  For the query to isolate sessions to the right
    // guild, the fragment immediately before the guildId interpolation must
    // reference the guild_id column (e.g. "WHERE guild_id = ").
    const [[sqlObj]] = mocks.execute.mock.calls as [[{ op: string; strings: TemplateStringsArray; values: unknown[] }]];
    const values = sqlObj.values;
    const guildIdIndex = values.indexOf("guild-target");

    // The guild ID must be an interpolated value, not baked into the SQL text.
    expect(guildIdIndex).toBeGreaterThanOrEqual(0);

    // The static SQL fragment that precedes this value must name the guild_id column.
    const precedingFragment = sqlObj.strings[guildIdIndex];
    expect(precedingFragment).toMatch(/guild_id\s*=/i);
  });

  it("uses exactly the provided guildId — not a hardcoded or default value", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ cnt: "2" }] });

    await countCompletedSessionsOlderThan("guild-specific", 30);

    const [[sqlObj]] = mocks.execute.mock.calls as [[{ op: string; strings: TemplateStringsArray; values: unknown[] }]];
    const values = sqlObj.values;

    // The exact guild ID provided must appear in the interpolated values.
    expect(values).toContain("guild-specific");
    // No other guild string should appear — the query must not mix guild IDs.
    expect(values.filter((v) => typeof v === "string" && v !== "guild-specific")).toHaveLength(0);
  });

  it("binds the guildId positionally before the left_at predicate in the SQL template", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ cnt: "1" }] });

    await countCompletedSessionsOlderThan("guild-order-check", 30);

    const [[sqlObj]] = mocks.execute.mock.calls as [[{ op: string; strings: TemplateStringsArray; values: unknown[] }]];
    const values = sqlObj.values;

    // The guildId string must appear before the cutoff Date in the values array,
    // matching the WHERE clause order: guild_id = ? AND ... AND left_at < ?
    const guildIdIndex = values.findIndex((v) => v === "guild-order-check");
    const cutoffIndex  = values.findIndex((v) => v instanceof Date);
    expect(guildIdIndex).toBeGreaterThanOrEqual(0);
    expect(cutoffIndex).toBeGreaterThan(guildIdIndex);
  });

  // ── Cutoff date (completed-sessions-only invariant) ─────────────────────────

  it("passes a cutoff Date into the SQL query for the left_at < cutoff filter", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ cnt: "5" }] });

    const before = Date.now();
    await countCompletedSessionsOlderThan("guild-abc", 30);
    const after = Date.now();

    // The second interpolated value must be a Date and must represent
    // approximately (now − 30 days).  The query uses left_at < cutoff, so
    // active sessions (left_at IS NULL) are structurally excluded.
    const values = lastExecuteValues();
    const cutoff = values.find((v) => v instanceof Date) as Date | undefined;
    expect(cutoff).toBeInstanceOf(Date);

    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const expectedCutoffMin = before - thirtyDaysMs;
    const expectedCutoffMax = after  - thirtyDaysMs;
    expect(cutoff!.getTime()).toBeGreaterThanOrEqual(expectedCutoffMin);
    expect(cutoff!.getTime()).toBeLessThanOrEqual(expectedCutoffMax);
  });

  it("uses a more recent cutoff for fewer days (shorter retention window)", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ cnt: "1" }] });

    await countCompletedSessionsOlderThan("guild-abc", 30);
    const values30 = lastExecuteValues();
    const cutoff30 = values30.find((v) => v instanceof Date) as Date;

    vi.clearAllMocks();
    mocks.execute.mockResolvedValue({ rows: [{ cnt: "1" }] });

    await countCompletedSessionsOlderThan("guild-abc", 90);
    const values90 = lastExecuteValues();
    const cutoff90 = values90.find((v) => v instanceof Date) as Date;

    // 30-day window → cutoff is closer to now (more recent) than 90-day window
    expect(cutoff30.getTime()).toBeGreaterThan(cutoff90.getTime());
  });

  // ── Active-session exclusion (structural guarantee) ─────────────────────────

  it("does not count active sessions: the SQL template contains left_at IS NOT NULL logic", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ cnt: "0" }] });

    await countCompletedSessionsOlderThan("guild-abc", 30);

    // The raw SQL string fragments must include the IS NOT NULL guard so that
    // rows with left_at = NULL (active sessions) are structurally excluded by
    // the query, not just by post-processing.
    const [[sqlObj]] = mocks.execute.mock.calls as [[{ op: string; strings: TemplateStringsArray }]];
    const combinedSql = sqlObj.strings.join(" ");
    expect(combinedSql).toMatch(/IS NOT NULL/i);
  });

  it("the SQL also filters by left_at < cutoff so only old sessions are counted", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ cnt: "0" }] });

    await countCompletedSessionsOlderThan("guild-abc", 30);

    const [[sqlObj]] = mocks.execute.mock.calls as [[{ op: string; strings: TemplateStringsArray }]];
    const combinedSql = sqlObj.strings.join(" ");
    // The comparison operator that restricts to sessions older than the cutoff
    expect(combinedSql).toMatch(/left_at\s*</i);
  });

  // ── execute is always called ─────────────────────────────────────────────────

  it("always calls db.execute exactly once per invocation", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ cnt: "2" }] });

    await countCompletedSessionsOlderThan("guild-abc", 30);

    expect(mocks.execute).toHaveBeenCalledOnce();
  });
});
