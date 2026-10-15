/**
 * Tests verifying that getVcTimeInPeriod correctly clamps sessions that
 * straddle an eval period boundary to only count their overlap with the window.
 *
 * Covers:
 *   1. A session joining before startDate and leaving after endDate contributes
 *      exactly (endDate - startDate) seconds — only the window duration.
 *   2. A session joining before startDate but leaving inside the window contributes
 *      exactly (leftAt - startDate) seconds — from the window start to leftAt.
 *   3. The SQL embeds GREATEST(joined_at, startDate) clamping via the startDate
 *      parameter so the DB lower-bounds the session start at startDate.
 *   4. The SQL embeds LEAST(COALESCE(left_at, NOW()), endDate) clamping via the
 *      endDate parameter so the DB upper-bounds the session end at endDate.
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

// ─── Test fixtures ────────────────────────────────────────────────────────────

const GUILD = "guild-boundary-clamp-test";
const USER = "user-boundary-clamp-test";

// Eval window: January 2024
const START = new Date("2024-01-01T00:00:00Z");
const END = new Date("2024-02-01T00:00:00Z");

// Window duration in seconds: 31 days
const WINDOW_SECONDS = (END.getTime() - START.getTime()) / 1000;

// leftAt inside the window: 10 days after startDate
const LEFT_AT_INSIDE = new Date("2024-01-11T00:00:00Z");
const LEFT_AT_INSIDE_SECONDS = (LEFT_AT_INSIDE.getTime() - START.getTime()) / 1000;

// ─── SQL fragment helpers ─────────────────────────────────────────────────────

type SqlFragment = { op: string; strings: string[]; values: unknown[] };

/** Recursively collect every SQL fragment reachable from a root fragment. */
function collectFragments(fragment: SqlFragment): SqlFragment[] {
  const result: SqlFragment[] = [fragment];
  for (const v of fragment.values ?? []) {
    if (v && typeof v === "object" && (v as SqlFragment).op === "sql") {
      result.push(...collectFragments(v as SqlFragment));
    }
  }
  return result;
}

/** Return all template strings from every reachable SQL fragment joined together. */
function allSqlStrings(callIndex = 0): string {
  const arg = mocks.execute.mock.calls[callIndex]?.[0] as SqlFragment | undefined;
  if (!arg) return "";
  return collectFragments(arg)
    .map((f) => f.strings.join(""))
    .join(" ");
}

/** Return all values (interpolated parameters) from every reachable SQL fragment. */
function allSqlValues(callIndex = 0): unknown[] {
  const arg = mocks.execute.mock.calls[callIndex]?.[0] as SqlFragment | undefined;
  if (!arg) return [];
  return collectFragments(arg).flatMap((f) => f.values);
}

// ─── Return value: session spanning entire window ─────────────────────────────

describe("getVcTimeInPeriod – session spans entire eval window (joined before start, left after end)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns exactly the window duration when the DB reports only the clamped overlap", async () => {
    // The DB applies GREATEST/LEAST clamping and returns (endDate - startDate) for a
    // session that started before startDate and ended after endDate.
    mocks.execute.mockResolvedValueOnce({ rows: [{ total_seconds: String(WINDOW_SECONDS) }] });

    const result = await getVcTimeInPeriod(GUILD, USER, START, END);

    expect(result).toBe(WINDOW_SECONDS);
  });

  it("does not return time outside the window (i.e. the full session duration is not returned)", async () => {
    // The session lasted 90 days but the window is 31 days.  The DB clamps it and
    // returns only WINDOW_SECONDS, not the full 90-day span.
    const fullSessionSeconds = 90 * 24 * 3600;
    mocks.execute.mockResolvedValueOnce({ rows: [{ total_seconds: String(WINDOW_SECONDS) }] });

    const result = await getVcTimeInPeriod(GUILD, USER, START, END);

    expect(result).toBe(WINDOW_SECONDS);
    expect(result).toBeLessThan(fullSessionSeconds);
  });
});

// ─── Return value: session joins before start, leaves inside window ───────────

describe("getVcTimeInPeriod – session joins before startDate, leaves inside the window", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns only (leftAt - startDate) seconds for a session that started before the window", async () => {
    // The DB clamps joined_at to startDate via GREATEST and returns only the
    // overlap from startDate to leftAt (10 days).
    mocks.execute.mockResolvedValueOnce({ rows: [{ total_seconds: String(LEFT_AT_INSIDE_SECONDS) }] });

    const result = await getVcTimeInPeriod(GUILD, USER, START, END);

    expect(result).toBe(LEFT_AT_INSIDE_SECONDS);
  });

  it("does not count time before startDate even when the session started much earlier", async () => {
    // A session that started 30 days before the window but left 10 days in should
    // contribute only LEFT_AT_INSIDE_SECONDS, not include the 30-day pre-window span.
    const fullSessionSeconds = (LEFT_AT_INSIDE.getTime() - new Date("2023-12-02T00:00:00Z").getTime()) / 1000;
    mocks.execute.mockResolvedValueOnce({ rows: [{ total_seconds: String(LEFT_AT_INSIDE_SECONDS) }] });

    const result = await getVcTimeInPeriod(GUILD, USER, START, END);

    expect(result).toBe(LEFT_AT_INSIDE_SECONDS);
    expect(result).toBeLessThan(fullSessionSeconds);
  });
});

// ─── SQL structure: GREATEST/LEAST clamping is present ───────────────────────

describe("getVcTimeInPeriod – SQL embeds GREATEST/LEAST boundary clamping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("SQL contains GREATEST to clamp the lower bound of the session to startDate", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [{ total_seconds: "0" }] });

    await getVcTimeInPeriod(GUILD, USER, START, END);

    const combined = allSqlStrings();
    expect(combined).toContain("MAX(joined_at,");
  });

  it("SQL contains LEAST to clamp the upper bound of the session to endDate", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [{ total_seconds: "0" }] });

    await getVcTimeInPeriod(GUILD, USER, START, END);

    const combined = allSqlStrings();
    expect(combined).toContain("MIN(COALESCE(left_at, cast(unixepoch('subsec') * 1000000 as integer)),");
  });

  it("startDate is passed as a SQL parameter to the GREATEST clamping expression", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [{ total_seconds: "0" }] });

    await getVcTimeInPeriod(GUILD, USER, START, END);

    const values = allSqlValues();
    expect(values).toContain(START);
  });

  it("endDate is passed as a SQL parameter to the LEAST clamping expression", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [{ total_seconds: "0" }] });

    await getVcTimeInPeriod(GUILD, USER, START, END);

    const values = allSqlValues();
    expect(values).toContain(END);
  });

  it("SQL wraps the clamped interval in GREATEST(0, ...) to prevent negative durations", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [{ total_seconds: "0" }] });

    await getVcTimeInPeriod(GUILD, USER, START, END);

    const combined = allSqlStrings();
    expect(combined).toContain("MAX(0,");
  });
});

// ─── Edge: session entirely before window ────────────────────────────────────

describe("getVcTimeInPeriod – session lies entirely outside the eval window", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 0 when the DB reports no overlap (session ended before startDate)", async () => {
    // The WHERE clause (joined_at < endDate AND left_at > startDate) excludes this
    // session, so the DB SUM returns null which the function maps to 0.
    mocks.execute.mockResolvedValueOnce({ rows: [{ total_seconds: null }] });

    const result = await getVcTimeInPeriod(GUILD, USER, START, END);

    expect(result).toBe(0);
  });
});
