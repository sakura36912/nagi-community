/**
 * Tests for the "keep data" global opt-out path.
 *
 * Covers two things:
 *   1. closeOpenSessionsForUser – the DB function that stamps leftAt on open sessions.
 *   2. handlePrivacyGlobalOptoutKeep – the button handler that wires opt-out +
 *      session close together for the "keep data" choice.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock state so both vi.mock factories and test bodies can reference it ─
const mocks = vi.hoisted(() => {
  // ── update chain: db.update(table).set({}).where(...).returning({}) ──────────
  const returning = vi.fn().mockResolvedValue([]);
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));

  // ── insert chain: db.insert(table).values({}).onConflictDoUpdate({}) ─────────
  const onConflictDoUpdate = vi.fn().mockResolvedValue([]);
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values }));

  return { returning, where, set, update, onConflictDoUpdate, values, insert };
});

// ─── Mock @workspace/db ───────────────────────────────────────────────────────
// Provide stub column objects for every table community.ts imports.
// The column names are opaque strings – we only need them to flow through
// drizzle-orm operator calls unmodified so we can assert on the set() payload.
vi.mock("@workspace/db", () => {
  // Helper: proxy that returns "<table>.<column>" for any property access.
  const tbl = (name: string) =>
    new Proxy({} as Record<string, string>, {
      get: (_t, p: string) => `${name}.${p}`,
    });

  return {
    db: {
      update: mocks.update,
      insert: mocks.insert,
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

// ─── Mock drizzle-orm SQL operators ──────────────────────────────────────────
// We only need these to return something serialisable; the actual query is
// never executed (the db itself is mocked).
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  isNull: (col: unknown) => ({ op: "isNull", col }),
  gt: (col: unknown, val: unknown) => ({ op: "gt", col, val }),
  lt: (col: unknown, val: unknown) => ({ op: "lt", col, val }),
  or: (...args: unknown[]) => ({ op: "or", args }),
  asc: (col: unknown) => ({ op: "asc", col }),
  desc: (col: unknown) => ({ op: "desc", col }),
  // Tagged template literal – returns a plain descriptor object.
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({
      op: "sql",
      strings,
      values,
    }),
    { raw: (v: unknown) => ({ op: "sql.raw", v }) },
  ),
}));

// ─── Imports (resolved after all mocks are in place) ─────────────────────────
import { closeOpenSessionsForUser } from "../lib/community.js";
import { handlePrivacyGlobalOptoutKeep } from "../commands/index.js";

// ─── Fake discord.js ButtonInteraction ───────────────────────────────────────
function makeInteraction(userId: string) {
  return {
    user: { id: userId },
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
}

// ─── Test suites ─────────────────────────────────────────────────────────────

describe("closeOpenSessionsForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 0 when the user has no open sessions", async () => {
    mocks.returning.mockResolvedValueOnce([]);
    const count = await closeOpenSessionsForUser("user-123");
    expect(count).toBe(0);
  });

  it("returns the number of sessions that were closed", async () => {
    mocks.returning.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
    const count = await closeOpenSessionsForUser("user-123");
    expect(count).toBe(2);
  });

  it("targets the vc sessions table", async () => {
    mocks.returning.mockResolvedValueOnce([]);
    await closeOpenSessionsForUser("user-abc");

    // db.update() must receive the vc sessions table stub
    const [tableArg] = mocks.update.mock.calls[0] as [Record<string, string>][];
    expect(tableArg["userId"]).toBe("sessions.userId");
  });

  it("stamps leftAt with the current time (a Date, not null)", async () => {
    mocks.returning.mockResolvedValueOnce([{ id: 5 }]);
    const before = Date.now();
    await closeOpenSessionsForUser("user-xyz");
    const after = Date.now();

    const [setPayload] = mocks.set.mock.calls[0] as [{ leftAt: Date }][];
    expect(setPayload.leftAt).toBeInstanceOf(Date);
    expect(setPayload.leftAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(setPayload.leftAt.getTime()).toBeLessThanOrEqual(after);
  });

  it("filters with AND( eq(userId), isNull(leftAt) ) so only open sessions are closed", async () => {
    mocks.returning.mockResolvedValueOnce([]);
    await closeOpenSessionsForUser("user-filter-test");

    const [whereArg] = mocks.where.mock.calls[0] as [
      { op: string; args: { op: string }[] }
    ][];
    // Top-level operator must be AND
    expect(whereArg.op).toBe("and");
    // One branch must be an eq (for the userId)
    expect(whereArg.args.some((a) => a.op === "eq")).toBe(true);
    // One branch must be an isNull (for leftAt IS NULL)
    expect(whereArg.args.some((a) => a.op === "isNull")).toBe(true);
  });
});

describe('handlePrivacyGlobalOptoutKeep – "keep data" global opt-out path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("closes any open VC sessions for the user", async () => {
    // Simulate 1 open session being closed
    mocks.returning.mockResolvedValueOnce([{ id: 10 }]);
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);

    const interaction = makeInteraction("user-keep-1");
    await handlePrivacyGlobalOptoutKeep(interaction as never);

    // db.update() must have been called (by closeOpenSessionsForUser)
    expect(mocks.update).toHaveBeenCalled();
    // The set() payload must include a leftAt Date
    const [setPayload] = mocks.set.mock.calls[0] as [{ leftAt: Date }][];
    expect(setPayload.leftAt).toBeInstanceOf(Date);
  });

  it("also persists the global opt-out flag (insert path)", async () => {
    mocks.returning.mockResolvedValueOnce([]);
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);

    const interaction = makeInteraction("user-keep-2");
    await handlePrivacyGlobalOptoutKeep(interaction as never);

    // db.insert() must have been called (by setVcGlobalPrivacyOptOut)
    expect(mocks.insert).toHaveBeenCalled();
    const [valuesArg] = mocks.values.mock.calls[0] as [
      { userId: string; optedOut: boolean }
    ][];
    expect(valuesArg.userId).toBe("user-keep-2");
    expect(valuesArg.optedOut).toBe(true);
  });

  it("replies to the interaction after both operations complete", async () => {
    mocks.returning.mockResolvedValueOnce([{ id: 3 }, { id: 4 }]);
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);

    const interaction = makeInteraction("user-keep-3");
    await handlePrivacyGlobalOptoutKeep(interaction as never);

    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ components: [] }),
    );
  });

  it("does NOT delete session rows (keep-data path leaves history intact)", async () => {
    // insert() is for the opt-out record; it should NOT call db.delete()
    mocks.returning.mockResolvedValueOnce([]);
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);

    const interaction = makeInteraction("user-keep-4");
    await handlePrivacyGlobalOptoutKeep(interaction as never);

    // The mock db has no delete() method, and we should not have tried to call
    // one — if it did the test would throw "db.delete is not a function".
    // This assertion is implicitly satisfied; add an explicit check on update
    // to confirm only update (close) was used, not a delete (purge).
    expect(mocks.update).toHaveBeenCalled(); // close path
  });
});
