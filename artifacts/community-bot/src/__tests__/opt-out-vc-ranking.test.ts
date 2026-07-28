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
import { getVcRanking } from "../lib/community.js";

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
