/**
 * Tests verifying that sessions with is_exile = true are excluded from the
 * main VC ranking (getVcRanking and getUserVcRank).
 *
 * Covers:
 *   1. getVcRanking – exile session absent when it is the only session in the guild
 *   2. getVcRanking – exile user absent while a non-exile user still ranks normally
 *   3. getVcRanking – SQL query contains AND is_exile = false
 *   4. getUserVcRank – returns null when the user's only sessions are exile sessions
 *   5. getUserVcRank – non-exile user in the same guild still receives a numeric rank
 *   6. getUserVcRank – SQL query contains AND is_exile = false
 *
 * Strategy: db.execute() is mocked so we can:
 *   a) Assert the function maps DB rows (or empty results) correctly.
 *   b) Inspect the raw SQL template strings to confirm the exile filter is
 *      present; a future refactor cannot silently drop it without breaking
 *      these tests.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock state ─────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  const execute = vi.fn();
  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([]),
      })),
    })),
  }));
  return { execute, update };
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

// ─── Mock drizzle-orm ─────────────────────────────────────────────────────────
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
  notInArray: (col: unknown, vals: unknown) => ({ op: "notInArray", col, vals }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({
      op: "sql",
      strings: Array.from(strings),
      values,
    }),
    {
      raw: (v: unknown) => ({ op: "sql.raw", v }),
      join: (parts: unknown[], sep: unknown) => ({ op: "sql.join", parts, sep }),
    },
  ),
}));

// ─── Import after mocks ───────────────────────────────────────────────────────
import { getVcRanking, getUserVcRank } from "../lib/community.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────
const GUILD = "guild-exile-test";

/** Join all SQL template string fragments into one string for pattern matching. */
function sqlText(mock: ReturnType<typeof vi.fn>, callIndex = 0): string {
  const arg = mock.mock.calls[callIndex]?.[0] as { strings: string[] } | undefined;
  return arg?.strings?.join("") ?? "";
}

// ─── getVcRanking – exile exclusion ──────────────────────────────────────────

describe("getVcRanking – exile session exclusion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when the only session in the guild belongs to an exile user", async () => {
    // The DB filters out the exile session via AND is_exile = false, returning nothing.
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    const result = await getVcRanking(GUILD);

    expect(result).toEqual([]);
  });

  it("does not include the exile user when a non-exile user is also present", async () => {
    // DB returns only the non-exile user; the exile user was removed by the SQL filter.
    mocks.execute.mockResolvedValueOnce({
      rows: [{ user_id: "user-normal", total_seconds: "3600", is_live: false }],
    });

    const result = await getVcRanking(GUILD);

    expect(result).toHaveLength(1);
    expect(result[0]?.userId).toBe("user-normal");
    expect(result.some((r) => r.userId === "user-exile")).toBe(false);
  });

  it("non-exile user ranks normally even when an exile user has sessions in the same guild", async () => {
    // Simulate two non-exile users returned by the DB (exile user filtered out).
    mocks.execute.mockResolvedValueOnce({
      rows: [
        { user_id: "user-alpha", total_seconds: "7200", is_live: true },
        { user_id: "user-beta", total_seconds: "1800", is_live: false },
      ],
    });

    const result = await getVcRanking(GUILD);

    expect(result).toHaveLength(2);
    expect(result[0]?.userId).toBe("user-alpha");
    expect(result[0]?.totalSeconds).toBe(7200);
    expect(result[1]?.userId).toBe("user-beta");
  });

  it("SQL query contains the is_exile = false filter", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getVcRanking(GUILD);

    const query = sqlText(mocks.execute);
    expect(query).toContain("is_exile = false");
  });

  it("SQL query contains is_exile = false even when periodStart is supplied", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getVcRanking(GUILD, new Date("2024-01-01T00:00:00Z"));

    const query = sqlText(mocks.execute);
    expect(query).toContain("is_exile = false");
  });

  it("SQL query contains is_exile = false alongside the privacy NOT IN sub-selects", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getVcRanking(GUILD);

    const query = sqlText(mocks.execute);
    expect(query).toContain("is_exile = false");
    expect(query).toContain("community_vc_privacy");
    expect(query).toContain("community_vc_privacy_global");
    const notInMatches = query.match(/NOT IN/g) ?? [];
    expect(notInMatches.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── getUserVcRank – exile exclusion ─────────────────────────────────────────

describe("getUserVcRank – exile session exclusion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when the user's only sessions are exile sessions (DB returns no rank row)", async () => {
    // The exile filter removes every row for this user; no rank is assigned.
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    const rank = await getUserVcRank(GUILD, "user-exile-only");

    expect(rank).toBeNull();
  });

  it("returns null for exile user even when periodStart is supplied", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    const rank = await getUserVcRank(GUILD, "user-exile-only", new Date("2024-01-01T00:00:00Z"));

    expect(rank).toBeNull();
  });

  it("returns a numeric rank for a non-exile user in the same guild", async () => {
    // The non-exile user's sessions pass the is_exile = false filter.
    mocks.execute.mockResolvedValueOnce({ rows: [{ rank: "1" }] });

    const rank = await getUserVcRank(GUILD, "user-normal");

    expect(rank).toBe(1);
  });

  it("returns correct rank value when the non-exile user is not first", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [{ rank: "3" }] });

    const rank = await getUserVcRank(GUILD, "user-normal-third");

    expect(rank).toBe(3);
  });

  it("SQL query contains the is_exile = false filter", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getUserVcRank(GUILD, "user-exile-only");

    const query = sqlText(mocks.execute);
    expect(query).toContain("is_exile = false");
  });

  it("SQL query contains is_exile = false even when periodStart is supplied", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getUserVcRank(GUILD, "user-exile-only", new Date("2024-06-01T00:00:00Z"));

    const query = sqlText(mocks.execute);
    expect(query).toContain("is_exile = false");
  });

  it("SQL query contains is_exile = false alongside the privacy NOT IN sub-selects", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    await getUserVcRank(GUILD, "user-exile-only");

    const query = sqlText(mocks.execute);
    expect(query).toContain("is_exile = false");
    expect(query).toContain("community_vc_privacy");
    expect(query).toContain("community_vc_privacy_global");
    const notInMatches = query.match(/NOT IN/g) ?? [];
    expect(notInMatches.length).toBeGreaterThanOrEqual(2);
  });
});
