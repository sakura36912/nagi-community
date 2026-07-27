/**
 * Tests verifying that opted-out users are excluded from eval sheets and
 * ranking commands end-to-end.
 *
 * Covers:
 *   1. getVcTimeInPeriod – globally opted-out user returns 0
 *   2. getVcTimeInPeriod – guild-locally opted-out user returns 0
 *   3. getUserVcRank – opted-out user returns null (not ranked)
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
      // Stubs for other db methods imported transitively by community.ts
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
  gt: (col: unknown, val: unknown) => ({ op: "gt", col, val }),
  lt: (col: unknown, val: unknown) => ({ op: "lt", col, val }),
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
import { getVcTimeInPeriod, getUserVcRank } from "../lib/community.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────
const GUILD = "guild-001";
const USER = "user-opt-out";
const START = new Date("2024-01-01T00:00:00Z");
const END = new Date("2024-01-31T23:59:59Z");

/** Join all template string fragments into one string for pattern matching. */
function sqlText(mock: ReturnType<typeof vi.fn>): string {
  const arg = mock.mock.calls[0]?.[0] as { strings: string[] } | undefined;
  return arg?.strings?.join("") ?? "";
}

// ─── getVcTimeInPeriod ────────────────────────────────────────────────────────

describe("getVcTimeInPeriod – opt-out exclusion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 0 when the DB returns no rows (globally opted-out user)", async () => {
    // Simulate the SQL WHERE clause filtering the user out entirely
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    const result = await getVcTimeInPeriod(GUILD, USER, START, END);

    expect(result).toBe(0);
  });

  it("returns 0 when total_seconds is null (guild-locally opted-out user)", async () => {
    // Simulate SUM() returning NULL when no rows match after privacy filter
    mocks.execute.mockResolvedValueOnce({ rows: [{ total_seconds: null }] });

    const result = await getVcTimeInPeriod(GUILD, USER, START, END);

    expect(result).toBe(0);
  });

  it("returns the correct seconds for a non-opted-out user", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [{ total_seconds: "3600" }] });

    const result = await getVcTimeInPeriod(GUILD, USER, START, END);

    expect(result).toBe(3600);
  });

  it("SQL query contains the guild-local privacy exclusion sub-select", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getVcTimeInPeriod(GUILD, USER, START, END);

    const query = sqlText(mocks.execute);
    expect(query).toContain("community_vc_privacy");
    expect(query).toContain("opted_out = true");
  });

  it("SQL query contains the global privacy exclusion sub-select", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getVcTimeInPeriod(GUILD, USER, START, END);

    const query = sqlText(mocks.execute);
    expect(query).toContain("community_vc_privacy_global");
    expect(query).toContain("opted_out = true");
  });

  it("SQL query uses NOT IN for both privacy tables", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getVcTimeInPeriod(GUILD, USER, START, END);

    const query = sqlText(mocks.execute);
    // There must be at least two NOT IN clauses
    const notInMatches = query.match(/NOT IN/g) ?? [];
    expect(notInMatches.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── getUserVcRank ────────────────────────────────────────────────────────────

describe("getUserVcRank – opt-out exclusion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when opted-out user has no rows in ranking query", async () => {
    // When the privacy WHERE clause removes the user, the inner SELECT returns
    // no row for them, so the outer WHERE user_id = ? finds nothing.
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    const result = await getUserVcRank(GUILD, USER);

    expect(result).toBeNull();
  });

  it("returns null even when a periodStart is provided (guild-local opt-out path)", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    const result = await getUserVcRank(GUILD, USER, new Date("2024-01-01"));

    expect(result).toBeNull();
  });

  it("returns the numeric rank for a non-opted-out user", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [{ rank: "3" }] });

    const result = await getUserVcRank(GUILD, "user-active");

    expect(result).toBe(3);
  });

  it("SQL query contains the guild-local privacy exclusion sub-select", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getUserVcRank(GUILD, USER);

    const query = sqlText(mocks.execute);
    expect(query).toContain("community_vc_privacy");
    expect(query).toContain("opted_out = true");
  });

  it("SQL query contains the global privacy exclusion sub-select", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getUserVcRank(GUILD, USER);

    const query = sqlText(mocks.execute);
    expect(query).toContain("community_vc_privacy_global");
    expect(query).toContain("opted_out = true");
  });

  it("SQL query uses NOT IN for both privacy tables", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getUserVcRank(GUILD, USER);

    const query = sqlText(mocks.execute);
    const notInMatches = query.match(/NOT IN/g) ?? [];
    expect(notInMatches.length).toBeGreaterThanOrEqual(2);
  });
});
