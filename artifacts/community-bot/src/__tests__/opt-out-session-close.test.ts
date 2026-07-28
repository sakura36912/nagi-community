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
import { closeOpenSessionsForUser, setVcPrivacyOptOut } from "../lib/community.js";
import { handlePrivacyGlobalOptoutKeep, handlePrivacyOptoutKeep } from "../commands/index.js";

// ─── Fake discord.js ButtonInteraction ───────────────────────────────────────
function makeInteraction(userId: string, guildId?: string) {
  return {
    user: { id: userId },
    guildId: guildId ?? null,
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
    const [tableArg] = mocks.update.mock.calls[0] as unknown as [Record<string, string>];
    expect(tableArg["userId"]).toBe("sessions.userId");
  });

  it("stamps leftAt with the current time (a Date, not null)", async () => {
    mocks.returning.mockResolvedValueOnce([{ id: 5 }]);
    const before = Date.now();
    await closeOpenSessionsForUser("user-xyz");
    const after = Date.now();

    const [setPayload] = mocks.set.mock.calls[0] as unknown as [{ leftAt: Date }];
    expect(setPayload.leftAt).toBeInstanceOf(Date);
    expect(setPayload.leftAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(setPayload.leftAt.getTime()).toBeLessThanOrEqual(after);
  });

  it("filters with AND( eq(userId), isNull(leftAt) ) so only open sessions are closed", async () => {
    mocks.returning.mockResolvedValueOnce([]);
    await closeOpenSessionsForUser("user-filter-test");

    const [whereArg] = mocks.where.mock.calls[0] as unknown as [
      { op: string; args: { op: string }[] }
    ];
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
    const [setPayload] = mocks.set.mock.calls[0] as unknown as [{ leftAt: Date }];
    expect(setPayload.leftAt).toBeInstanceOf(Date);
  });

  it("also persists the global opt-out flag (insert path)", async () => {
    mocks.returning.mockResolvedValueOnce([]);
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);

    const interaction = makeInteraction("user-keep-2");
    await handlePrivacyGlobalOptoutKeep(interaction as never);

    // db.insert() must have been called (by setVcGlobalPrivacyOptOut)
    expect(mocks.insert).toHaveBeenCalled();
    const [valuesArg] = mocks.values.mock.calls[0] as unknown as [
      { userId: string; optedOut: boolean }
    ];
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

describe('handlePrivacyOptoutKeep – "keep data" per-guild opt-out path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // setVcPrivacyOptOut executes: insert (opt-out flag) then update (closeSession).
  // Mock ordering must match that call sequence.

  it("closes any open VC session for the user in that guild", async () => {
    // insert (opt-out flag) completes first
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);
    // update (closeSession) finds and stamps one open session
    mocks.returning.mockResolvedValueOnce([{ id: 20 }]);

    const interaction = makeInteraction("user-pgkeep-1", "guild-A");
    await handlePrivacyOptoutKeep(interaction as never);

    // db.update() must have been called (by closeSession)
    expect(mocks.update).toHaveBeenCalled();
    // The set() payload must include a leftAt Date
    const [setPayload] = mocks.set.mock.calls[0] as unknown as [{ leftAt: Date }];
    expect(setPayload.leftAt).toBeInstanceOf(Date);
  });

  it("also persists the per-guild opt-out flag (insert path)", async () => {
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);
    mocks.returning.mockResolvedValueOnce([]);

    const interaction = makeInteraction("user-pgkeep-2", "guild-B");
    await handlePrivacyOptoutKeep(interaction as never);

    // db.insert() must have been called (by setVcPrivacyOptOut)
    expect(mocks.insert).toHaveBeenCalled();
    const [valuesArg] = mocks.values.mock.calls[0] as unknown as [
      { guildId: string; userId: string; optedOut: boolean }
    ];
    expect(valuesArg.guildId).toBe("guild-B");
    expect(valuesArg.userId).toBe("user-pgkeep-2");
    expect(valuesArg.optedOut).toBe(true);
  });

  it("replies to the interaction after both operations complete", async () => {
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);
    mocks.returning.mockResolvedValueOnce([{ id: 21 }]);

    const interaction = makeInteraction("user-pgkeep-3", "guild-C");
    await handlePrivacyOptoutKeep(interaction as never);

    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ components: [] }),
    );
  });

  it("does NOT delete session rows (keep-data path leaves history intact)", async () => {
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);
    mocks.returning.mockResolvedValueOnce([]);

    const interaction = makeInteraction("user-pgkeep-4", "guild-D");
    await handlePrivacyOptoutKeep(interaction as never);

    // update (close) is used; no delete (purge) is invoked
    expect(mocks.update).toHaveBeenCalled();
  });

  it("does nothing when guildId is absent (DM context guard)", async () => {
    // interaction with no guildId — handler should return early without touching db
    const interaction = makeInteraction("user-pgkeep-5");
    await handlePrivacyOptoutKeep(interaction as never);

    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
  });

  it("filters the close by guildId so only that guild's session is stamped", async () => {
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);
    mocks.returning.mockResolvedValueOnce([]);

    const interaction = makeInteraction("user-pgkeep-6", "guild-E");
    await handlePrivacyOptoutKeep(interaction as never);

    // The where() call receives an AND with three branches:
    // eq(guildId), eq(userId), isNull(leftAt)
    const [whereArg] = mocks.where.mock.calls[0] as unknown as [
      { op: string; args: { op: string }[] }
    ];
    expect(whereArg.op).toBe("and");
    // At least two eq branches (guildId + userId) and one isNull branch
    expect(whereArg.args.filter((a) => a.op === "eq").length).toBeGreaterThanOrEqual(2);
    expect(whereArg.args.some((a) => a.op === "isNull")).toBe(true);
  });

  it("includes the session-closed note in the embed when a session was open", async () => {
    // insert (opt-out flag), then update (closeSession) finds one open session
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);
    mocks.returning.mockResolvedValueOnce([{ id: 30 }]);

    const interaction = makeInteraction("user-pgkeep-7", "guild-F");
    await handlePrivacyOptoutKeep(interaction as never);

    const [[replyArg]] = interaction.editReply.mock.calls as [[{ embeds: { data: { description?: string } }[] }]];
    const description = replyArg.embeds[0]?.data?.description ?? "";
    expect(description).toContain("進行中のVCセッションを自動的に終了しました");
  });

  it("omits the session-closed note from the embed when no session was open", async () => {
    // insert (opt-out flag), then update (closeSession) finds nothing
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);
    mocks.returning.mockResolvedValueOnce([]);

    const interaction = makeInteraction("user-pgkeep-8", "guild-G");
    await handlePrivacyOptoutKeep(interaction as never);

    const [[replyArg]] = interaction.editReply.mock.calls as [[{ embeds: { data: { description?: string } }[] }]];
    const description = replyArg.embeds[0]?.data?.description ?? "";
    expect(description).not.toContain("進行中のVCセッションを自動的に終了しました");
  });
});

// ─── setVcPrivacyOptOut return value ─────────────────────────────────────────

describe("setVcPrivacyOptOut – return value", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when an open session was closed", async () => {
    // insert (opt-out flag) succeeds, then update (closeSession) finds one row
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);
    mocks.returning.mockResolvedValueOnce([{ id: 99 }]);

    const result = await setVcPrivacyOptOut("guild-rv-1", "user-rv-1", true);
    expect(result).toBe(true);
  });

  it("returns false when no session is open", async () => {
    // insert (opt-out flag) succeeds, then update (closeSession) finds nothing
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);
    mocks.returning.mockResolvedValueOnce([]);

    const result = await setVcPrivacyOptOut("guild-rv-2", "user-rv-2", true);
    expect(result).toBe(false);
  });
});
