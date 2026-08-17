/**
 * Tests verifying that getVcTimeInPeriod excludes privacy-closed sessions
 * (is_privacy_closed = true) from eval-sheet VC totals.
 *
 * Covers:
 *   1. The SQL query contains `AND is_privacy_closed = false`
 *   2. Returns 0 when the only sessions in the period are privacy-closed
 *      (DB mock returns null total_seconds, simulating the filter doing its job)
 *   3. Returns the correct total when non-privacy-closed sessions exist
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
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([]),
          })),
        })),
      })),
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
import { getVcTimeInPeriod } from "../lib/community.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────
const GUILD = "guild-privacy-closed-period-test";
const USER = "user-privacy-closed-period-test";
const START = new Date("2024-03-01T00:00:00Z");
const END = new Date("2024-04-01T00:00:00Z");

type SqlFragment = { op: string; strings: string[]; values: unknown[] };

/**
 * Recursively collect every SQL fragment embedded in the values of the outer
 * sql template.
 */
function collectFragments(fragment: SqlFragment): SqlFragment[] {
  const result: SqlFragment[] = [fragment];
  for (const v of fragment.values ?? []) {
    if (v && typeof v === "object" && (v as SqlFragment).op === "sql") {
      result.push(...collectFragments(v as SqlFragment));
    }
  }
  return result;
}

/**
 * Returns the concatenated strings of every SQL fragment, joined together.
 */
function allSqlStrings(callIndex = 0): string {
  const arg = mocks.execute.mock.calls[callIndex]?.[0] as SqlFragment | undefined;
  if (!arg) return "";
  return collectFragments(arg)
    .map((f) => f.strings.join(""))
    .join(" ");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("getVcTimeInPeriod – privacy-closed session exclusion", () => {
  beforeEach(() => vi.clearAllMocks());

  it("SQL query contains AND is_privacy_closed = false", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [{ total_seconds: "0" }] });

    await getVcTimeInPeriod(GUILD, USER, START, END);

    const combined = allSqlStrings();
    expect(combined).toContain("AND is_privacy_closed = false");
  });

  it("returns 0 when the period contains only privacy-closed sessions", async () => {
    // The DB applies AND is_privacy_closed = false, so privacy-closed sessions
    // are excluded and total_seconds comes back null.
    mocks.execute.mockResolvedValueOnce({ rows: [{ total_seconds: null }] });

    const result = await getVcTimeInPeriod(GUILD, USER, START, END);

    expect(result).toBe(0);
  });

  it("returns 0 when the DB returns an empty rows array (all sessions privacy-closed)", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    const result = await getVcTimeInPeriod(GUILD, USER, START, END);

    expect(result).toBe(0);
  });

  it("returns the correct total when non-privacy-closed sessions exist", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [{ total_seconds: "7200" }] });

    const result = await getVcTimeInPeriod(GUILD, USER, START, END);

    expect(result).toBe(7200);
  });

  it("privacy-closed filter is present even when isExile filter is also applied", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [{ total_seconds: null }] });

    await getVcTimeInPeriod(GUILD, USER, START, END, false);

    const combined = allSqlStrings();
    expect(combined).toContain("AND is_privacy_closed = false");
    expect(combined).toContain("AND is_exile = ");
  });

  it("privacy-closed filter is present when isExile=true is applied", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [{ total_seconds: null }] });

    await getVcTimeInPeriod(GUILD, USER, START, END, true);

    const combined = allSqlStrings();
    expect(combined).toContain("AND is_privacy_closed = false");
    expect(combined).toContain("AND is_exile = ");
  });
});
