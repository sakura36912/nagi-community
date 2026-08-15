/**
 * Unit tests for getAllTempVcDeletions.
 *
 * The handler-level CSV export tests mock getAllTempVcDeletions at the boundary
 * and therefore cannot catch a bug inside the library function itself — for
 * example, a stale userId leaking into a date-only query.  These tests exercise
 * the four meaningful filter combinations directly and assert that:
 *
 *   (a) userId-only  — only a userId value is interpolated; no Date objects
 *   (b) date-only    — only Date objects are interpolated; no userId string
 *   (c) combined     — both userId and Date objects appear in the bindings
 *   (d) no filters   — only the guildId appears in the bindings
 *   (e) Row mapping  — the DB row shape is converted to the TempVcDeletionRow
 *       shape correctly (camelCase fields, Date objects, boolean optedOut)
 *   (f) Guild scope  — the guildId is always present in the interpolated values
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
      insert:  vi.fn(),
      select:  vi.fn(),
      update:  vi.fn(),
      delete:  vi.fn(),
    },
    communityVcSessionsTable:        tbl("sessions"),
    communityVcPrivacyTable:          tbl("privacy"),
    communityVcPrivacyGlobalTable:    tbl("global"),
    communityEventSettingsTable:      tbl("eventSettings"),
    communityEventsTable:             tbl("events"),
    communityEventParticipantsTable:  tbl("eventParticipants"),
    communityTicketSettingsTable:     tbl("ticketSettings"),
    communityTicketsTable:            tbl("tickets"),
    communityTicketPanelsTable:       tbl("ticketPanels"),
    communityRankingSettingsTable:    tbl("rankingSettings"),
    communityRoleButtonsTable:        tbl("roleButtons"),
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

// ─── Import under test (after mocks are registered) ──────────────────────────

import { getAllTempVcDeletions } from "../lib/community.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * Raw DB row for user-A, joined/left in February 2025 (early date range).
 * opted_out is computed by the query itself — we return it as a boolean here.
 */
const DB_ROW_A = {
  id:        10,
  guild_id:  "guild-001",
  user_id:   "user-AAA",
  channel_id:"ch-001",
  joined_at: "2025-02-01T00:00:00.000Z",
  left_at:   "2025-02-01T01:00:00.000Z",
  opted_out: false,
};

/**
 * Raw DB row for user-B, joined/left in May 2025 (later date range).
 */
const DB_ROW_B = {
  id:        20,
  guild_id:  "guild-001",
  user_id:   "user-BBB",
  channel_id:"ch-002",
  joined_at: "2025-05-01T00:00:00.000Z",
  left_at:   "2025-05-01T02:00:00.000Z",
  opted_out: false,
};

// ─── Helper: extract the interpolated values from the last execute call ───────

type SqlObj = { op: string; strings: TemplateStringsArray; values: unknown[] };

/**
 * Recursively flattens nested SQL template objects produced by the drizzle-orm
 * `sql` tag mock.  The community.ts implementation composes conditional filter
 * fragments like `sql\`AND s.user_id = ${userId}\`` and interpolates them into
 * the outer query, so the outer values array contains nested SqlObj instances
 * rather than raw scalars.  This helper walks the tree and returns every leaf
 * value (string, Date, number, boolean, etc.) in depth-first order.
 */
function flattenSqlValues(obj: unknown): unknown[] {
  if (
    obj !== null &&
    typeof obj === "object" &&
    "op" in (obj as Record<string, unknown>) &&
    "values" in (obj as Record<string, unknown>)
  ) {
    const sqlObj = obj as SqlObj;
    return sqlObj.values.flatMap((v) => flattenSqlValues(v));
  }
  return [obj];
}

function lastSqlValues(): unknown[] {
  const [[sqlObj]] = mocks.execute.mock.calls as [[SqlObj]];
  return flattenSqlValues(sqlObj);
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── (a) userId-only filter ───────────────────────────────────────────────────

describe("getAllTempVcDeletions – userId-only filter", () => {
  it("interpolates the userId into the SQL query", async () => {
    mocks.execute.mockResolvedValue({ rows: [DB_ROW_A] });

    await getAllTempVcDeletions("guild-001", { userId: "user-AAA" });

    const values = lastSqlValues();
    expect(values).toContain("user-AAA");
  });

  it("does NOT interpolate any Date objects when only userId is provided", async () => {
    mocks.execute.mockResolvedValue({ rows: [DB_ROW_A] });

    await getAllTempVcDeletions("guild-001", { userId: "user-AAA" });

    const values = lastSqlValues();
    const dateValues = values.filter((v) => v instanceof Date);
    expect(dateValues).toHaveLength(0);
  });

  it("returns only the rows the DB provided (user-A's row)", async () => {
    mocks.execute.mockResolvedValue({ rows: [DB_ROW_A] });

    const result = await getAllTempVcDeletions("guild-001", { userId: "user-AAA" });

    expect(result).toHaveLength(1);
    expect(result[0]!.userId).toBe("user-AAA");
  });

  it("does NOT return user-B's row when filtering by user-A", async () => {
    // Simulates a correct DB response: user-B was excluded by the query itself.
    mocks.execute.mockResolvedValue({ rows: [DB_ROW_A] });

    const result = await getAllTempVcDeletions("guild-001", { userId: "user-AAA" });

    expect(result.some((r) => r.userId === "user-BBB")).toBe(false);
  });
});

// ─── (b) date-only filter ─────────────────────────────────────────────────────

describe("getAllTempVcDeletions – date-only filter (excludes user-B's May rows)", () => {
  const START = new Date("2025-01-01T00:00:00.000Z");
  const END   = new Date("2025-03-31T23:59:59.999Z"); // March end — excludes May

  it("interpolates both Date objects (start and end) into the SQL query", async () => {
    mocks.execute.mockResolvedValue({ rows: [DB_ROW_A] });

    await getAllTempVcDeletions("guild-001", { start: START, end: END });

    const values = lastSqlValues();
    const dateValues = values.filter((v) => v instanceof Date);
    expect(dateValues).toHaveLength(2);
  });

  it("does NOT interpolate any userId string when no userId is provided", async () => {
    mocks.execute.mockResolvedValue({ rows: [DB_ROW_A] });

    await getAllTempVcDeletions("guild-001", { start: START, end: END });

    const values = lastSqlValues();
    // The only strings should be the guildId — no accidental userId leakage
    const stringValues = values.filter(
      (v) => typeof v === "string" && v !== "guild-001",
    );
    expect(stringValues).toHaveLength(0);
  });

  it("interpolates the start date before the end date in the bindings (matches WHERE order)", async () => {
    mocks.execute.mockResolvedValue({ rows: [DB_ROW_A] });

    await getAllTempVcDeletions("guild-001", { start: START, end: END });

    const values = lastSqlValues();
    const startIdx = values.indexOf(START);
    const endIdx   = values.indexOf(END);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(startIdx);
  });

  it("returns no rows when the DB returns none (date range excluded all rows)", async () => {
    // Simulates DB correctly excluding user-B's May sessions from a Jan–Mar range.
    mocks.execute.mockResolvedValue({ rows: [] });

    const result = await getAllTempVcDeletions("guild-001", { start: START, end: END });

    expect(result).toHaveLength(0);
  });

  it("returns only the in-range rows the DB provided", async () => {
    mocks.execute.mockResolvedValue({ rows: [DB_ROW_A] });

    const result = await getAllTempVcDeletions("guild-001", { start: START, end: END });

    expect(result).toHaveLength(1);
    expect(result[0]!.userId).toBe("user-AAA");
    expect(result.some((r) => r.userId === "user-BBB")).toBe(false);
  });
});

// ─── (c) combined filter (userId + date range) ────────────────────────────────

describe("getAllTempVcDeletions – combined userId + date range filter", () => {
  const START = new Date("2025-01-01T00:00:00.000Z");
  const END   = new Date("2025-06-30T23:59:59.999Z");

  it("interpolates both the userId and Date objects into the SQL query", async () => {
    mocks.execute.mockResolvedValue({ rows: [DB_ROW_A] });

    await getAllTempVcDeletions("guild-001", { userId: "user-AAA", start: START, end: END });

    const values = lastSqlValues();
    expect(values).toContain("user-AAA");
    const dateValues = values.filter((v) => v instanceof Date);
    expect(dateValues).toHaveLength(2);
  });

  it("returns only the rows the DB provided for the combined filter", async () => {
    mocks.execute.mockResolvedValue({ rows: [DB_ROW_A] });

    const result = await getAllTempVcDeletions("guild-001", {
      userId: "user-AAA",
      start:  START,
      end:    END,
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.userId).toBe("user-AAA");
  });
});

// ─── (d) no filters ───────────────────────────────────────────────────────────

describe("getAllTempVcDeletions – no filters", () => {
  it("interpolates only the guildId (no Date objects, no userId string beyond guildId)", async () => {
    mocks.execute.mockResolvedValue({ rows: [DB_ROW_A, DB_ROW_B] });

    await getAllTempVcDeletions("guild-001");

    const values = lastSqlValues();
    expect(values).toContain("guild-001");

    const dateValues = values.filter((v) => v instanceof Date);
    expect(dateValues).toHaveLength(0);

    const extraStrings = values.filter(
      (v) => typeof v === "string" && v !== "guild-001",
    );
    expect(extraStrings).toHaveLength(0);
  });

  it("returns all rows the DB provided (both user-A and user-B)", async () => {
    mocks.execute.mockResolvedValue({ rows: [DB_ROW_A, DB_ROW_B] });

    const result = await getAllTempVcDeletions("guild-001");

    expect(result).toHaveLength(2);
    expect(result.some((r) => r.userId === "user-AAA")).toBe(true);
    expect(result.some((r) => r.userId === "user-BBB")).toBe(true);
  });

  it("calls db.execute exactly once", async () => {
    mocks.execute.mockResolvedValue({ rows: [] });

    await getAllTempVcDeletions("guild-001");

    expect(mocks.execute).toHaveBeenCalledOnce();
  });
});

// ─── (e) row mapping ──────────────────────────────────────────────────────────

describe("getAllTempVcDeletions – row shape mapping", () => {
  it("converts snake_case DB fields to camelCase TempVcDeletionRow fields", async () => {
    mocks.execute.mockResolvedValue({ rows: [DB_ROW_A] });

    const [row] = await getAllTempVcDeletions("guild-001");

    expect(row).toMatchObject({
      id:        10,
      guildId:   "guild-001",
      userId:    "user-AAA",
      channelId: "ch-001",
    });
  });

  it("parses joinedAt and leftAt as Date objects", async () => {
    mocks.execute.mockResolvedValue({ rows: [DB_ROW_A] });

    const [row] = await getAllTempVcDeletions("guild-001");

    expect(row!.joinedAt).toBeInstanceOf(Date);
    expect(row!.leftAt).toBeInstanceOf(Date);
  });

  it("joinedAt and leftAt have the correct UTC timestamps", async () => {
    mocks.execute.mockResolvedValue({ rows: [DB_ROW_A] });

    const [row] = await getAllTempVcDeletions("guild-001");

    expect(row!.joinedAt.toISOString()).toBe("2025-02-01T00:00:00.000Z");
    expect(row!.leftAt.toISOString()).toBe("2025-02-01T01:00:00.000Z");
  });

  it("maps opted_out=false correctly to the boolean false", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ ...DB_ROW_A, opted_out: false }] });

    const [row] = await getAllTempVcDeletions("guild-001");

    expect(row!.optedOut).toBe(false);
  });

  it("maps opted_out=true correctly to the boolean true", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ ...DB_ROW_A, opted_out: true }] });

    const [row] = await getAllTempVcDeletions("guild-001");

    expect(row!.optedOut).toBe(true);
  });

  it("returns an empty array when the DB returns no rows", async () => {
    mocks.execute.mockResolvedValue({ rows: [] });

    const result = await getAllTempVcDeletions("guild-001");

    expect(result).toEqual([]);
  });
});

// ─── (f) guild scope ─────────────────────────────────────────────────────────

describe("getAllTempVcDeletions – guild scope", () => {
  it("always binds the provided guildId into the SQL — even with no other filters", async () => {
    mocks.execute.mockResolvedValue({ rows: [] });

    await getAllTempVcDeletions("guild-XYZ");

    const values = lastSqlValues();
    expect(values).toContain("guild-XYZ");
  });

  it("uses the exact guildId provided, not a hardcoded default", async () => {
    mocks.execute.mockResolvedValue({ rows: [] });

    await getAllTempVcDeletions("guild-custom-123");

    const values = lastSqlValues();
    expect(values).toContain("guild-custom-123");
    // No other guild strings should appear
    const otherGuilds = values.filter(
      (v) => typeof v === "string" && v !== "guild-custom-123",
    );
    expect(otherGuilds).toHaveLength(0);
  });

  it("guildId appears in the SQL bindings before any date or userId values", async () => {
    const start = new Date("2025-01-01T00:00:00.000Z");
    mocks.execute.mockResolvedValue({ rows: [] });

    await getAllTempVcDeletions("guild-order", { userId: "user-AAA", start });

    const values = lastSqlValues();
    const guildIdx  = values.indexOf("guild-order");
    const userIdx   = values.indexOf("user-AAA");
    const dateIdx   = values.findIndex((v) => v instanceof Date);

    expect(guildIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeGreaterThan(guildIdx);
    expect(dateIdx).toBeGreaterThan(guildIdx);
  });
});
