/**
 * Focused tests for isVcTrackingOptedOut.
 *
 * Covers every meaningful combination of global-row and guild-row presence /
 * optedOut value, in particular the boundary between:
 *   - row absent                    → treated as NOT opted out (returns false)
 *   - row present, optedOut: false  → returns false
 *   - row present, optedOut: true   → returns true
 *
 * This guards against silent re-enrollment caused by a missing opt-out row
 * (e.g. after a partial data migration that removed the row instead of setting
 * optedOut=false).
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock state ─────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  // select chain: db.select().from(table).where(cond) → Promise<row[]>
  // isVcTrackingOptedOut runs Promise.all([globalQuery, guildQuery]).
  // Both queries share the same selectWhere mock, resolved in queue order.
  const selectWhere = vi.fn().mockResolvedValue([]);
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  return { select, selectFrom, selectWhere };
});

// ─── Mock @workspace/db ───────────────────────────────────────────────────────
vi.mock("@workspace/db", () => {
  const tbl = (name: string) =>
    new Proxy({} as Record<string, string>, {
      get: (_t, p: string) => `${name}.${p}`,
    });

  return {
    db: { select: mocks.select },
    communityVcPrivacyGlobalTable: tbl("global"),
    communityVcPrivacyTable: tbl("privacy"),
    communityVcSessionsTable: tbl("sessions"),
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

// ─── Mock drizzle-orm operators ───────────────────────────────────────────────
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
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: "sql", strings, values }),
    { raw: (v: unknown) => ({ op: "sql.raw", v }) },
  ),
}));

// ─── Import under test ────────────────────────────────────────────────────────
import { isVcTrackingOptedOut } from "../lib/community.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

type RowResult = { optedOut: boolean } | undefined;

/**
 * Queue the two DB responses that isVcTrackingOptedOut fetches in parallel:
 *   1st resolved value → global privacy table row (or [] for absent)
 *   2nd resolved value → guild privacy table row  (or [] for absent)
 */
function mockRows(globalRow: RowResult, guildRow: RowResult) {
  mocks.selectWhere
    .mockResolvedValueOnce(globalRow ? [globalRow] : [])
    .mockResolvedValueOnce(guildRow ? [guildRow] : []);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("isVcTrackingOptedOut", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Row absent (no record in DB) ───────────────────────────────────────────

  it("returns false when BOTH the global row and guild row are absent", async () => {
    mockRows(undefined, undefined);
    const result = await isVcTrackingOptedOut("guild-1", "user-1");
    expect(result).toBe(false);
  });

  it("returns false when only the global row is absent (guild row also absent)", async () => {
    mockRows(undefined, undefined);
    const result = await isVcTrackingOptedOut("guild-1", "user-missing-global");
    expect(result).toBe(false);
  });

  it("returns false when only the guild row is absent (global row also absent)", async () => {
    mockRows(undefined, undefined);
    const result = await isVcTrackingOptedOut("guild-1", "user-missing-guild");
    expect(result).toBe(false);
  });

  // ── Row present with optedOut: false ───────────────────────────────────────

  it("returns false when global row is present but optedOut is false", async () => {
    mockRows({ optedOut: false }, undefined);
    const result = await isVcTrackingOptedOut("guild-2", "user-global-false");
    expect(result).toBe(false);
  });

  it("returns false when guild row is present but optedOut is false", async () => {
    mockRows(undefined, { optedOut: false });
    const result = await isVcTrackingOptedOut("guild-2", "user-guild-false");
    expect(result).toBe(false);
  });

  it("returns false when both rows are present and both have optedOut: false", async () => {
    mockRows({ optedOut: false }, { optedOut: false });
    const result = await isVcTrackingOptedOut("guild-2", "user-both-false");
    expect(result).toBe(false);
  });

  // ── Row present with optedOut: true ────────────────────────────────────────

  it("returns true when global row has optedOut: true (guild row absent)", async () => {
    mockRows({ optedOut: true }, undefined);
    const result = await isVcTrackingOptedOut("guild-3", "user-global-true");
    expect(result).toBe(true);
  });

  it("returns true when global row has optedOut: true (guild row present but false)", async () => {
    mockRows({ optedOut: true }, { optedOut: false });
    const result = await isVcTrackingOptedOut("guild-3", "user-global-overrides");
    expect(result).toBe(true);
  });

  it("returns true when guild row has optedOut: true (global row absent)", async () => {
    mockRows(undefined, { optedOut: true });
    const result = await isVcTrackingOptedOut("guild-4", "user-guild-true");
    expect(result).toBe(true);
  });

  it("returns true when guild row has optedOut: true (global row present but false)", async () => {
    mockRows({ optedOut: false }, { optedOut: true });
    const result = await isVcTrackingOptedOut("guild-4", "user-guild-true-global-false");
    expect(result).toBe(true);
  });

  it("returns true when both rows have optedOut: true", async () => {
    mockRows({ optedOut: true }, { optedOut: true });
    const result = await isVcTrackingOptedOut("guild-4", "user-both-true");
    expect(result).toBe(true);
  });

  // ── Critical boundary: absent row must NOT be treated as opted-out ──────────

  it("treats an absent global row identically to optedOut: false (not opted out)", async () => {
    // Absent row
    mockRows(undefined, undefined);
    const resultAbsent = await isVcTrackingOptedOut("guild-5", "user-absent");

    vi.clearAllMocks();

    // Explicit false
    mockRows({ optedOut: false }, { optedOut: false });
    const resultFalse = await isVcTrackingOptedOut("guild-5", "user-explicit-false");

    expect(resultAbsent).toBe(false);
    expect(resultFalse).toBe(false);
    expect(resultAbsent).toBe(resultFalse);
  });

  it("treats an absent guild row identically to optedOut: false (not opted out)", async () => {
    // Global row absent too – only guild matters here
    mockRows(undefined, undefined);
    const resultAbsent = await isVcTrackingOptedOut("guild-6", "user-guild-absent");

    vi.clearAllMocks();

    mockRows(undefined, { optedOut: false });
    const resultFalse = await isVcTrackingOptedOut("guild-6", "user-guild-explicit-false");

    expect(resultAbsent).toBe(false);
    expect(resultFalse).toBe(false);
    expect(resultAbsent).toBe(resultFalse);
  });

  // ── Query structure ────────────────────────────────────────────────────────

  it("queries the global table with the correct userId", async () => {
    mockRows(undefined, undefined);
    await isVcTrackingOptedOut("guild-7", "user-query-check");

    const firstWhereArg = mocks.selectWhere.mock.calls[0]?.[0] as {
      op: string;
      col: string;
      val: string;
    };
    expect(firstWhereArg.op).toBe("eq");
    expect(firstWhereArg.col).toBe("global.userId");
    expect(firstWhereArg.val).toBe("user-query-check");
  });

  it("queries the guild table with both guildId and userId", async () => {
    mockRows(undefined, undefined);
    await isVcTrackingOptedOut("guild-7", "user-guild-query");

    const secondWhereArg = mocks.selectWhere.mock.calls[1]?.[0] as {
      op: string;
      args: { op: string; col: string; val: string }[];
    };
    expect(secondWhereArg.op).toBe("and");
    const eqArgs = secondWhereArg.args.filter((a) => a.op === "eq");
    const cols = eqArgs.map((a) => a.col);
    expect(cols).toContain("privacy.guildId");
    expect(cols).toContain("privacy.userId");
  });
});
