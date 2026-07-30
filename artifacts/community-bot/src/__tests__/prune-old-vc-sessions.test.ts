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
});
