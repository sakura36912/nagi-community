/**
 * Tests verifying that getVcTimeInPeriod correctly separates exile and
 * non-exile sessions when computing eval-sheet VC time.
 *
 * Covers:
 *   1. isExile=false  → returns 0 when the user only has exile sessions in the period
 *   2. isExile=true   → returns 0 when the user only has non-exile sessions
 *   3. isExile=undefined → includes both exile and non-exile sessions (no exile filter)
 *   4. SQL query embeds `AND is_exile = <value>` only when the parameter is defined
 *   5. SQL query has no exile clause when isExile is omitted
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
const GUILD = "guild-exile-period-test";
const USER = "user-exile-period-test";
const START = new Date("2024-01-01T00:00:00Z");
const END = new Date("2024-02-01T00:00:00Z");

type SqlFragment = { op: string; strings: string[]; values: unknown[] };

/**
 * Join all SQL template string fragments from the outermost db.execute() call
 * into a single string for pattern matching.
 */
function sqlText(callIndex = 0): string {
  const arg = mocks.execute.mock.calls[callIndex]?.[0] as SqlFragment | undefined;
  return arg?.strings?.join("") ?? "";
}

/**
 * Recursively collect every SQL fragment embedded in the values of the outer
 * sql template (the exile filter is passed as a nested sql`` value).
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
 * Returns the concatenated strings of every nested SQL fragment that contains
 * exile-filter content.
 */
function allSqlStrings(callIndex = 0): string {
  const arg = mocks.execute.mock.calls[callIndex]?.[0] as SqlFragment | undefined;
  if (!arg) return "";
  return collectFragments(arg)
    .map((f) => f.strings.join(""))
    .join(" ");
}

// ─── Return value mapping ─────────────────────────────────────────────────────

describe("getVcTimeInPeriod – return value mapping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the total seconds from the DB row", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [{ total_seconds: "3600" }] });

    const result = await getVcTimeInPeriod(GUILD, USER, START, END);

    expect(result).toBe(3600);
  });

  it("returns 0 when the DB row has null total_seconds (no matching sessions)", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [{ total_seconds: null }] });

    const result = await getVcTimeInPeriod(GUILD, USER, START, END);

    expect(result).toBe(0);
  });

  it("returns 0 when the DB returns an empty rows array", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] });

    const result = await getVcTimeInPeriod(GUILD, USER, START, END);

    expect(result).toBe(0);
  });
});

// ─── isExile = false (non-exile only) ────────────────────────────────────────

describe("getVcTimeInPeriod – isExile=false (non-exile sessions only)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 0 when the user only has exile sessions in the period", async () => {
    // The DB applies AND is_exile = false, so exile sessions are excluded and
    // total_seconds comes back null.
    mocks.execute.mockResolvedValueOnce({ rows: [{ total_seconds: null }] });

    const result = await getVcTimeInPeriod(GUILD, USER, START, END, false);

    expect(result).toBe(0);
  });

  it("returns the correct seconds when the user has non-exile sessions", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [{ total_seconds: "1800" }] });

    const result = await getVcTimeInPeriod(GUILD, USER, START, END, false);

    expect(result).toBe(1800);
  });

  it("SQL query embeds the exile filter with value false", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [{ total_seconds: null }] });

    await getVcTimeInPeriod(GUILD, USER, START, END, false);

    // The exile filter is a nested sql fragment; its strings contain "AND is_exile = "
    const combined = allSqlStrings();
    expect(combined).toContain("AND is_exile = ");
  });

  it("SQL exile filter carries the boolean value false", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [{ total_seconds: null }] });

    await getVcTimeInPeriod(GUILD, USER, START, END, false);

    const arg = mocks.execute.mock.calls[0]?.[0] as SqlFragment;
    const fragments = collectFragments(arg);
    const exileFragment = fragments.find((f) => f.strings.join("").includes("AND is_exile = "));
    expect(exileFragment).toBeDefined();
    expect(exileFragment!.values).toContain(false);
  });
});

// ─── isExile = true (exile sessions only) ────────────────────────────────────

describe("getVcTimeInPeriod – isExile=true (exile sessions only)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 0 when the user only has non-exile sessions in the period", async () => {
    // The DB applies AND is_exile = true, so non-exile sessions are excluded.
    mocks.execute.mockResolvedValueOnce({ rows: [{ total_seconds: null }] });

    const result = await getVcTimeInPeriod(GUILD, USER, START, END, true);

    expect(result).toBe(0);
  });

  it("returns the correct seconds when the user has exile sessions", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [{ total_seconds: "900" }] });

    const result = await getVcTimeInPeriod(GUILD, USER, START, END, true);

    expect(result).toBe(900);
  });

  it("SQL query embeds the exile filter with value true", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [{ total_seconds: null }] });

    await getVcTimeInPeriod(GUILD, USER, START, END, true);

    const combined = allSqlStrings();
    expect(combined).toContain("AND is_exile = ");
  });

  it("SQL exile filter carries the boolean value true", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [{ total_seconds: null }] });

    await getVcTimeInPeriod(GUILD, USER, START, END, true);

    const arg = mocks.execute.mock.calls[0]?.[0] as SqlFragment;
    const fragments = collectFragments(arg);
    const exileFragment = fragments.find((f) => f.strings.join("").includes("AND is_exile = "));
    expect(exileFragment).toBeDefined();
    expect(exileFragment!.values).toContain(true);
  });
});

// ─── isExile = undefined (all sessions) ──────────────────────────────────────

describe("getVcTimeInPeriod – isExile=undefined (all sessions, no filter)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns combined seconds from both exile and non-exile sessions", async () => {
    // With no exile filter the DB sums all matching sessions.
    mocks.execute.mockResolvedValueOnce({ rows: [{ total_seconds: "5400" }] });

    const result = await getVcTimeInPeriod(GUILD, USER, START, END);

    expect(result).toBe(5400);
  });

  it("SQL query does not contain an exile filter when isExile is omitted", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [{ total_seconds: "5400" }] });

    await getVcTimeInPeriod(GUILD, USER, START, END);

    const arg = mocks.execute.mock.calls[0]?.[0] as SqlFragment;
    const fragments = collectFragments(arg);
    const exileFragment = fragments.find((f) => f.strings.join("").includes("AND is_exile = "));
    // No fragment should carry the exile clause when isExile is undefined.
    expect(exileFragment).toBeUndefined();
  });

  it("SQL query does not contain an exile filter when isExile is explicitly undefined", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [{ total_seconds: "0" }] });

    await getVcTimeInPeriod(GUILD, USER, START, END, undefined);

    const combined = allSqlStrings();
    expect(combined).not.toContain("AND is_exile = ");
  });
});
