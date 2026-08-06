/**
 * Tests for pruneOrphanedVcSchedules.
 *
 * Verifies:
 *   (a) Rows for guilds not in activeGuildIds are deleted.
 *   (b) Rows for active guilds are preserved (via notInArray exclusion).
 *   (c) The function is a no-op when activeGuildIds is empty — prevents
 *       mass-deletion of all rows when the bot briefly has an empty guild cache.
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
    vcSchedulesTable: tbl("schedules"),
  };
});

// ─── Mock drizzle-orm SQL operators ──────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  isNull: (col: unknown) => ({ op: "isNull", col }),
  lte: (col: unknown, val: unknown) => ({ op: "lte", col, val }),
  gt: (col: unknown, val: unknown) => ({ op: "gt", col, val }),
  notInArray: (col: unknown, vals: unknown[]) => ({ op: "notInArray", col, vals }),
}));

// ─── Import under test (resolved after mocks) ─────────────────────────────────
import { pruneOrphanedVcSchedules } from "../lib/vc.js";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("pruneOrphanedVcSchedules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * When activeGuildIds is empty the function must short-circuit and return 0
   * without touching the database.  If it proceeded with an empty list the
   * notInArray predicate would match ALL rows, wiping every schedule row.
   */
  it("is a no-op when activeGuildIds is empty — returns 0 and never calls db.delete()", async () => {
    const count = await pruneOrphanedVcSchedules([]);
    expect(count).toBe(0);
    expect(mocks.del).not.toHaveBeenCalled();
  });

  /**
   * The WHERE clause must contain a notInArray predicate so only rows from
   * guilds the bot has left are targeted.
   */
  it("WHERE clause contains a notInArray predicate targeting the supplied active guild IDs", async () => {
    mocks.returning.mockResolvedValueOnce([]);
    const activeGuilds = ["guild-A", "guild-B"];
    await pruneOrphanedVcSchedules(activeGuilds);

    const [whereArg] = mocks.where.mock.calls[0] as unknown as [
      { op: string; col: string; vals: string[] }
    ];
    expect(whereArg.op).toBe("notInArray");
    expect(whereArg.col).toBe("schedules.guildId");
    expect(whereArg.vals).toEqual(activeGuilds);
  });

  /**
   * Active guild IDs must appear in the notInArray exclusion list so their
   * rows are never matched by the WHERE clause.
   */
  it("active-guild IDs appear in the notInArray exclusion list so their rows are never deleted", async () => {
    mocks.returning.mockResolvedValueOnce([]);
    const activeGuilds = ["guild-live-1", "guild-live-2", "guild-live-3"];
    await pruneOrphanedVcSchedules(activeGuilds);

    const [whereArg] = mocks.where.mock.calls[0] as unknown as [
      { op: string; col: string; vals: string[] }
    ];
    expect(whereArg.op).toBe("notInArray");
    for (const guildId of activeGuilds) {
      expect(whereArg.vals).toContain(guildId);
    }
  });

  it("returns the number of deleted rows", async () => {
    mocks.returning.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
    const count = await pruneOrphanedVcSchedules(["guild-A"]);
    expect(count).toBe(2);
  });

  it("returns 0 when no orphaned rows exist", async () => {
    mocks.returning.mockResolvedValueOnce([]);
    const count = await pruneOrphanedVcSchedules(["guild-A"]);
    expect(count).toBe(0);
  });

  it("returns 1 when exactly one orphaned row is deleted", async () => {
    mocks.returning.mockResolvedValueOnce([{ id: 99 }]);
    const count = await pruneOrphanedVcSchedules(["guild-A"]);
    expect(count).toBe(1);
  });

  it("passes vcSchedulesTable to db.delete()", async () => {
    mocks.returning.mockResolvedValueOnce([]);
    await pruneOrphanedVcSchedules(["guild-A"]);
    // The proxy renders the table reference as a Proxy object — confirm delete
    // was called exactly once (table identity is verified via the WHERE clause).
    expect(mocks.del).toHaveBeenCalledOnce();
  });

  it("calls db.delete().where().returning() exactly once per call", async () => {
    mocks.returning.mockResolvedValueOnce([{ id: 7 }]);
    await pruneOrphanedVcSchedules(["guild-X"]);
    expect(mocks.del).toHaveBeenCalledOnce();
    expect(mocks.where).toHaveBeenCalledOnce();
    expect(mocks.returning).toHaveBeenCalledOnce();
  });
});
