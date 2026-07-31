/**
 * Tests for pruneOldVcSessions.
 *
 * Verifies:
 *   (a) Completed sessions older than the retention window are deleted.
 *   (b) Completed sessions within the retention window are kept.
 *   (c) Active sessions (leftAt IS NULL) are never deleted regardless of age.
 *   (d) The returned count matches the number of deleted rows.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock state ─────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  // delete chain: db.delete(table).where(...).returning({})
  const returning = vi.fn().mockResolvedValue([]);
  const where = vi.fn(() => ({ returning }));
  const del = vi.fn(() => ({ where }));

  return { returning, where, del };
});

// ─── Mock @workspace/db ───────────────────────────────────────────────────────
vi.mock("@workspace/db", () => {
  const tbl = (name: string) =>
    new Proxy({} as Record<string, string>, {
      get: (_t, p: string) => `${name}.${p}`,
    });

  return {
    db: {
      delete: mocks.del,
    },
    communityVcSessionsTable: tbl("sessions"),
    communityVcPrivacyTable: tbl("privacy"),
    communityVcPrivacyGlobalTable: tbl("global"),
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

// ─── Mock drizzle-orm SQL operators ──────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  isNull: (col: unknown) => ({ op: "isNull", col }),
  isNotNull: (col: unknown) => ({ op: "isNotNull", col }),
  lt: (col: unknown, val: unknown) => ({ op: "lt", col, val }),
  lte: (col: unknown, val: unknown) => ({ op: "lte", col, val }),
  gt: (col: unknown, val: unknown) => ({ op: "gt", col, val }),
  gte: (col: unknown, val: unknown) => ({ op: "gte", col, val }),
  or: (...args: unknown[]) => ({ op: "or", args }),
  asc: (col: unknown) => ({ op: "asc", col }),
  desc: (col: unknown) => ({ op: "desc", col }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({
      op: "sql",
      strings,
      values,
    }),
    { raw: (v: unknown) => ({ op: "sql.raw", v }) },
  ),
}));

// ─── Import under test (resolved after mocks) ────────────────────────────────
import { pruneOldVcSessions } from "../lib/community.js";

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("pruneOldVcSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // (a) Old closed sessions are deleted and the count is returned
  it("returns 0 when no sessions fall outside the retention window", async () => {
    mocks.returning.mockResolvedValueOnce([]);
    const count = await pruneOldVcSessions(180);
    expect(count).toBe(0);
  });

  it("returns the number of rows that were deleted", async () => {
    mocks.returning.mockResolvedValueOnce([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const count = await pruneOldVcSessions(180);
    expect(count).toBe(3);
  });

  it("returns 1 when exactly one old closed session exists", async () => {
    mocks.returning.mockResolvedValueOnce([{ id: 42 }]);
    const count = await pruneOldVcSessions(180);
    expect(count).toBe(1);
  });

  // (b) & (c) WHERE clause – only old closed rows targeted
  it("targets the vc sessions table", async () => {
    mocks.returning.mockResolvedValueOnce([]);
    await pruneOldVcSessions();

    // db.delete() must receive the sessions table proxy
    const [tableArg] = mocks.del.mock.calls[0] as unknown as [Record<string, string>];
    expect(tableArg["leftAt"]).toBe("sessions.leftAt");
  });

  it("uses AND( isNotNull(leftAt), lt(leftAt, cutoff) ) so active sessions are never deleted", async () => {
    mocks.returning.mockResolvedValueOnce([]);
    await pruneOldVcSessions(180);

    const [whereArg] = mocks.where.mock.calls[0] as unknown as [
      { op: string; args: { op: string }[] }
    ];
    // Top-level operator must be AND
    expect(whereArg.op).toBe("and");
    // One branch must be isNotNull (left_at IS NOT NULL – active sessions excluded)
    expect(whereArg.args.some((a) => a.op === "isNotNull")).toBe(true);
    // One branch must be lt (left_at < cutoff – only old rows deleted)
    expect(whereArg.args.some((a) => a.op === "lt")).toBe(true);
  });

  it("passes a Date as the cutoff value to lt()", async () => {
    mocks.returning.mockResolvedValueOnce([]);
    await pruneOldVcSessions(180);

    const [whereArg] = mocks.where.mock.calls[0] as unknown as [
      { op: string; args: { op: string; col: unknown; val: unknown }[] }
    ];
    const ltClause = whereArg.args.find((a) => a.op === "lt") as { op: string; col: unknown; val: unknown } | undefined;
    expect(ltClause).toBeDefined();
    expect(ltClause!.val).toBeInstanceOf(Date);
  });

  it("cutoff is approximately retentionDays days ago", async () => {
    mocks.returning.mockResolvedValueOnce([]);
    const retentionDays = 90;
    const before = Date.now();
    await pruneOldVcSessions(retentionDays);
    const after = Date.now();

    const expectedCutoffMin = before - retentionDays * 24 * 60 * 60 * 1000;
    const expectedCutoffMax = after - retentionDays * 24 * 60 * 60 * 1000;

    const [whereArg] = mocks.where.mock.calls[0] as unknown as [
      { op: string; args: { op: string; col: unknown; val: unknown }[] }
    ];
    const ltClause = whereArg.args.find((a) => a.op === "lt") as { op: string; col: unknown; val: Date };
    expect(ltClause!.val.getTime()).toBeGreaterThanOrEqual(expectedCutoffMin);
    expect(ltClause!.val.getTime()).toBeLessThanOrEqual(expectedCutoffMax);
  });

  it("defaults to 180 days when no argument is provided", async () => {
    mocks.returning.mockResolvedValueOnce([]);
    const before = Date.now();
    await pruneOldVcSessions(); // no arg – should default to 180
    const after = Date.now();

    const defaultDays = 180;
    const expectedCutoffMin = before - defaultDays * 24 * 60 * 60 * 1000;
    const expectedCutoffMax = after - defaultDays * 24 * 60 * 60 * 1000;

    const [whereArg] = mocks.where.mock.calls[0] as unknown as [
      { op: string; args: { op: string; col: unknown; val: unknown }[] }
    ];
    const ltClause = whereArg.args.find((a) => a.op === "lt") as { op: string; col: unknown; val: Date };
    expect(ltClause!.val.getTime()).toBeGreaterThanOrEqual(expectedCutoffMin);
    expect(ltClause!.val.getTime()).toBeLessThanOrEqual(expectedCutoffMax);
  });

  // (c) Explicit check: isNotNull ensures leftAt IS NOT NULL is in the predicate,
  // meaning sessions with leftAt = NULL (active) are excluded by the WHERE clause.
  it("includes isNotNull(leftAt) so active sessions are structurally excluded", async () => {
    mocks.returning.mockResolvedValueOnce([]);
    await pruneOldVcSessions();

    const [whereArg] = mocks.where.mock.calls[0] as unknown as [
      { op: string; args: { op: string; col: unknown }[] }
    ];
    const isNotNullClause = whereArg.args.find((a) => a.op === "isNotNull") as
      | { op: string; col: string }
      | undefined;

    expect(isNotNullClause).toBeDefined();
    // The column must be leftAt on the sessions table
    expect(isNotNullClause!.col).toBe("sessions.leftAt");
  });

  it("applies lt() to leftAt so only rows older than the cutoff are deleted", async () => {
    mocks.returning.mockResolvedValueOnce([]);
    await pruneOldVcSessions();

    const [whereArg] = mocks.where.mock.calls[0] as unknown as [
      { op: string; args: { op: string; col: unknown; val: unknown }[] }
    ];
    const ltClause = whereArg.args.find((a) => a.op === "lt") as
      | { op: string; col: string; val: Date }
      | undefined;

    expect(ltClause).toBeDefined();
    // The column must be leftAt on the sessions table
    expect(ltClause!.col).toBe("sessions.leftAt");
  });

  // ── Custom retention window tests ────────────────────────────────────────────

  /**
   * When a custom window shorter than 180 days is used (e.g. 90 days), the
   * cutoff should be ~90 days ago — NOT ~180 days ago.  A row aged 100 days
   * falls between the custom window (90 d) and the default (180 d), so it must
   * be included in the deletion predicate (cutoff ≤ row age).
   */
  it("uses the custom cutoff (not 180-day default) so rows in the gap between custom and default ARE targeted for deletion", async () => {
    mocks.returning.mockResolvedValueOnce([]);
    const customDays = 90;
    const before = Date.now();
    await pruneOldVcSessions(customDays);
    const after = Date.now();

    const expectedCutoffMin = before - customDays * 24 * 60 * 60 * 1000;
    const expectedCutoffMax = after  - customDays * 24 * 60 * 60 * 1000;
    const defaultCutoff     = before - 180       * 24 * 60 * 60 * 1000;

    const [whereArg] = mocks.where.mock.calls[0] as unknown as [
      { op: string; args: { op: string; col: unknown; val: unknown }[] }
    ];
    const ltClause = whereArg.args.find((a) => a.op === "lt") as
      | { op: string; col: string; val: Date }
      | undefined;

    expect(ltClause).toBeDefined();
    const cutoffMs = ltClause!.val.getTime();

    // Cutoff must be in the 90-day range
    expect(cutoffMs).toBeGreaterThanOrEqual(expectedCutoffMin);
    expect(cutoffMs).toBeLessThanOrEqual(expectedCutoffMax);

    // A row aged 100 days (between the custom 90-d window and the default 180-d
    // window) has leftAt ≈ (now – 100 days).  That value is LESS THAN the
    // cutoff (now – 90 days), so lt(leftAt, cutoff) is satisfied — i.e. the row
    // IS included in the deletion predicate.
    const rowAgedMs = before - 100 * 24 * 60 * 60 * 1000;
    expect(rowAgedMs).toBeLessThan(cutoffMs);

    // Sanity: the cutoff is meaningfully newer than the 180-day default so we
    // are not accidentally using the wrong default.
    expect(cutoffMs).toBeGreaterThan(defaultCutoff);
  });

  /**
   * When a custom window longer than 180 days is used (e.g. 365 days), the
   * cutoff should be ~365 days ago — NOT ~180 days ago.  A row aged 200 days
   * falls between the default (180 d) and the custom window (365 d), so it
   * must NOT be included in the deletion predicate (row age < cutoff).
   */
  it("uses the custom cutoff (not 180-day default) so rows in the gap between default and custom are NOT prematurely deleted", async () => {
    mocks.returning.mockResolvedValueOnce([]);
    const customDays = 365;
    const before = Date.now();
    await pruneOldVcSessions(customDays);
    const after = Date.now();

    const expectedCutoffMin = before - customDays * 24 * 60 * 60 * 1000;
    const expectedCutoffMax = after  - customDays * 24 * 60 * 60 * 1000;
    const defaultCutoff     = before - 180        * 24 * 60 * 60 * 1000;

    const [whereArg] = mocks.where.mock.calls[0] as unknown as [
      { op: string; args: { op: string; col: unknown; val: unknown }[] }
    ];
    const ltClause = whereArg.args.find((a) => a.op === "lt") as
      | { op: string; col: string; val: Date }
      | undefined;

    expect(ltClause).toBeDefined();
    const cutoffMs = ltClause!.val.getTime();

    // Cutoff must be in the 365-day range
    expect(cutoffMs).toBeGreaterThanOrEqual(expectedCutoffMin);
    expect(cutoffMs).toBeLessThanOrEqual(expectedCutoffMax);

    // A row aged 200 days (between the default 180-d window and the custom
    // 365-d window) has leftAt ≈ (now – 200 days).  That value is GREATER THAN
    // the cutoff (now – 365 days), so lt(leftAt, cutoff) is NOT satisfied —
    // i.e. the row is NOT included in the deletion predicate and is preserved.
    const rowAgedMs = before - 200 * 24 * 60 * 60 * 1000;
    expect(rowAgedMs).toBeGreaterThan(cutoffMs);

    // Sanity: the cutoff is older than the 180-day default so we are not
    // accidentally using the wrong default.
    expect(cutoffMs).toBeLessThan(defaultCutoff);
  });

  /**
   * Records older than the custom window ARE deleted: a row aged beyond the
   * custom retention period has leftAt < cutoff and must be targeted.
   */
  it("targets records older than the custom retention window for deletion", async () => {
    mocks.returning.mockResolvedValueOnce([{ id: 7 }, { id: 8 }]);
    const customDays = 90;
    const count = await pruneOldVcSessions(customDays);

    // The function should return the count of deleted rows from .returning()
    expect(count).toBe(2);

    const before = Date.now();
    // Verify that a row aged beyond customDays (e.g. 120 days) would satisfy
    // the lt predicate produced for this call.
    const [whereArg] = mocks.where.mock.calls[0] as unknown as [
      { op: string; args: { op: string; col: unknown; val: unknown }[] }
    ];
    const ltClause = whereArg.args.find((a) => a.op === "lt") as
      | { op: string; col: string; val: Date }
      | undefined;

    expect(ltClause).toBeDefined();
    const cutoffMs = ltClause!.val.getTime();

    // A row aged 120 days (older than the 90-day custom window) has
    // leftAt < cutoff — it IS targeted for deletion.
    const rowAgedMs = before - 120 * 24 * 60 * 60 * 1000;
    expect(rowAgedMs).toBeLessThan(cutoffMs);
  });
});
