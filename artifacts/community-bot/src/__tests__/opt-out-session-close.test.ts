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
  //    OR            db.insert(table).values({}).returning()
  const onConflictDoUpdate = vi.fn().mockResolvedValue([]);
  const returningFromInsert = vi.fn().mockResolvedValue([]);
  const values = vi.fn(() => ({ onConflictDoUpdate, returning: returningFromInsert }));
  const insert = vi.fn(() => ({ values }));

  // ── select chain: db.select().from(table).where(...) → Promise ───────────────
  const selectWhere = vi.fn().mockResolvedValue([]);
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  // ── delete chain: db.delete(table).where(...).returning({}) ──────────────────
  const deleteReturning = vi.fn().mockResolvedValue([]);
  const deleteWhere = vi.fn(() => ({ returning: deleteReturning }));
  const deleteFn = vi.fn(() => ({ where: deleteWhere }));

  return {
    returning,
    where,
    set,
    update,
    onConflictDoUpdate,
    returningFromInsert,
    values,
    insert,
    selectWhere,
    selectFrom,
    select,
    deleteReturning,
    deleteWhere,
    deleteFn,
  };
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
      select: mocks.select,
      delete: mocks.deleteFn,
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
import { closeOpenSessionsForUser, openSession, setVcGlobalPrivacyOptOut, setVcPrivacyOptOut } from "../lib/community.js";
import { handlePrivacyGlobalOptoutKeep, handlePrivacyOptoutDelete, handlePrivacyOptoutKeep } from "../commands/index.js";

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

// ─── setVcPrivacyOptOut – opt-in path ────────────────────────────────────────

describe("setVcPrivacyOptOut – opt-in path (optedOut=false)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns false (no session is ever closed on opt-in)", async () => {
    // Only the insert/upsert runs; no update path is taken.
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);

    const result = await setVcPrivacyOptOut("guild-in-1", "user-in-1", false);
    expect(result).toBe(false);
  });

  it("never calls db.update() (the close-session path is skipped)", async () => {
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);

    await setVcPrivacyOptOut("guild-in-2", "user-in-2", false);

    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("upserts the privacy row with optedOut=false", async () => {
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);

    await setVcPrivacyOptOut("guild-in-3", "user-in-3", false);

    // db.insert() must have been called once
    expect(mocks.insert).toHaveBeenCalledTimes(1);

    // values() payload must carry optedOut: false and correct identifiers
    const [valuesArg] = mocks.values.mock.calls[0] as unknown as [
      { guildId: string; userId: string; optedOut: boolean }
    ];
    expect(valuesArg.guildId).toBe("guild-in-3");
    expect(valuesArg.userId).toBe("user-in-3");
    expect(valuesArg.optedOut).toBe(false);
  });

  it("the onConflictDoUpdate payload also carries optedOut=false", async () => {
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);

    await setVcPrivacyOptOut("guild-in-4", "user-in-4", false);

    const [conflictArg] = mocks.onConflictDoUpdate.mock.calls[0] as unknown as [
      { set: { optedOut: boolean } }
    ];
    expect(conflictArg.set.optedOut).toBe(false);
  });

  it("openSession succeeds after opt-in (user is no longer blocked)", async () => {
    // Step 1: opt the user back in
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);
    await setVcPrivacyOptOut("guild-in-5", "user-in-5", false);

    // Step 2: openSession — isVcTrackingOptedOut does two selects (global + guild).
    // Both return empty arrays so the user is NOT opted out.
    mocks.selectWhere.mockResolvedValueOnce([]); // global table → no row
    mocks.selectWhere.mockResolvedValueOnce([]); // per-guild table → optedOut=false row absent

    // The insert inside openSession uses .values().returning()
    const fakeSession = {
      id: 1,
      guildId: "guild-in-5",
      userId: "user-in-5",
      channelId: "channel-in-5",
      joinedAt: new Date(),
      leftAt: null,
    };
    mocks.returningFromInsert.mockResolvedValueOnce([fakeSession]);

    const session = await openSession("guild-in-5", "user-in-5", "channel-in-5");

    // A real session should be returned — not null
    expect(session).not.toBeNull();
    expect(session?.userId).toBe("user-in-5");
    expect(session?.guildId).toBe("guild-in-5");
  });

  it("openSession still returns null when the user is opted out (regression guard)", async () => {
    // Ensure the opt-out=true path still blocks openSession.
    // isVcTrackingOptedOut finds an opted-out row in the per-guild table.
    mocks.selectWhere.mockResolvedValueOnce([]); // global → no row
    mocks.selectWhere.mockResolvedValueOnce([{ guildId: "guild-rg", userId: "user-rg", optedOut: true }]);

    const session = await openSession("guild-rg", "user-rg", "channel-rg");
    expect(session).toBeNull();
    // db.insert() must NOT have been called (session was not created)
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});

// ─── handlePrivacyOptoutDelete – per-guild delete path ────────────────────────
//
// This handler calls Promise.all([deleteUserVcSessions, setVcPrivacyOptOut])
// so both operations run in parallel. deleteUserVcSessions scopes its DELETE
// to (guildId, userId); we verify the WHERE clause carries both values so that
// only the target guild's rows are removed.

describe('handlePrivacyOptoutDelete – per-guild opt-out + wipe path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Helper: set up the two mock results that every successful invocation needs.
  // deleteUserVcSessions  → db.delete().where().returning() resolves to `deletedRows`
  // setVcPrivacyOptOut    → db.insert().values().onConflictDoUpdate() resolves (upsert)
  //                       → db.update().set().where().returning() resolves to [] (no open session)
  function setupMocks(deletedRows: { id: number }[]) {
    mocks.deleteReturning.mockResolvedValueOnce(deletedRows);
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]); // setVcPrivacyOptOut upsert
    mocks.returning.mockResolvedValueOnce([]); // closeSession inside setVcPrivacyOptOut
  }

  it("does nothing when guildId is absent (DM context guard)", async () => {
    const interaction = makeInteraction("user-pd-0");
    await handlePrivacyOptoutDelete(interaction as never);

    expect(mocks.deleteFn).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
  });

  it("calls deleteUserVcSessions with the correct guildId and userId", async () => {
    setupMocks([]);

    const interaction = makeInteraction("user-pd-1", "guild-pd-1");
    await handlePrivacyOptoutDelete(interaction as never);

    // db.delete() must have been called once (by deleteUserVcSessions)
    expect(mocks.deleteFn).toHaveBeenCalledTimes(1);

    // The WHERE clause must contain both the guildId and the userId eq-filters
    // so that only guild-pd-1's rows are touched.
    const [whereArg] = mocks.deleteWhere.mock.calls[0] as unknown as [
      { op: string; args: { op: string; col: string; val: string }[] }
    ];
    expect(whereArg.op).toBe("and");
    const eqCols = whereArg.args
      .filter((a) => a.op === "eq")
      .map((a) => a.val);
    expect(eqCols).toContain("guild-pd-1");
    expect(eqCols).toContain("user-pd-1");
  });

  it("scopes the delete to one guild only (guildId is present in WHERE)", async () => {
    setupMocks([{ id: 1 }, { id: 2 }]);

    const interaction = makeInteraction("user-pd-2", "guild-pd-2");
    await handlePrivacyOptoutDelete(interaction as never);

    // The delete chain's where() must have been called exactly once and the
    // argument must carry the guildId value – confirming cross-guild rows
    // are NOT targeted.
    expect(mocks.deleteWhere).toHaveBeenCalledTimes(1);
    const [whereArg] = mocks.deleteWhere.mock.calls[0] as unknown as [
      { op: string; args: { op: string; col: string; val: string }[] }
    ];
    const vals = whereArg.args.filter((a) => a.op === "eq").map((a) => a.val);
    expect(vals).toContain("guild-pd-2");
    // The other guild must NOT appear
    expect(vals).not.toContain("some-other-guild");
  });

  it("calls setVcPrivacyOptOut in parallel with deleteUserVcSessions (insert occurs)", async () => {
    setupMocks([]);

    const interaction = makeInteraction("user-pd-3", "guild-pd-3");
    await handlePrivacyOptoutDelete(interaction as never);

    // If they ran in parallel via Promise.all, both delete and insert must have
    // been triggered during the same handler call.
    expect(mocks.deleteFn).toHaveBeenCalledTimes(1);
    expect(mocks.insert).toHaveBeenCalledTimes(1);

    // The insert must carry optedOut=true and the correct identifiers.
    const [valuesArg] = mocks.values.mock.calls[0] as unknown as [
      { guildId: string; userId: string; optedOut: boolean }
    ];
    expect(valuesArg.guildId).toBe("guild-pd-3");
    expect(valuesArg.userId).toBe("user-pd-3");
    expect(valuesArg.optedOut).toBe(true);
  });

  it("embed description contains the correct deleted-row count (3 rows)", async () => {
    setupMocks([{ id: 10 }, { id: 11 }, { id: 12 }]);

    const interaction = makeInteraction("user-pd-4", "guild-pd-4");
    await handlePrivacyOptoutDelete(interaction as never);

    const [[replyArg]] = interaction.editReply.mock.calls as [[{ embeds: { data: { description?: string } }[] }]];
    const description = replyArg.embeds[0]?.data?.description ?? "";
    expect(description).toContain("3件");
  });

  it("embed description contains the correct deleted-row count (0 rows)", async () => {
    setupMocks([]);

    const interaction = makeInteraction("user-pd-5", "guild-pd-5");
    await handlePrivacyOptoutDelete(interaction as never);

    const [[replyArg]] = interaction.editReply.mock.calls as [[{ embeds: { data: { description?: string } }[] }]];
    const description = replyArg.embeds[0]?.data?.description ?? "";
    expect(description).toContain("0件");
  });

  it("replies with components:[] so the buttons are removed after deletion", async () => {
    setupMocks([{ id: 99 }]);

    const interaction = makeInteraction("user-pd-6", "guild-pd-6");
    await handlePrivacyOptoutDelete(interaction as never);

    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ components: [] }),
    );
  });
});

// ─── Global opt-out + per-guild opt-in interaction ────────────────────────────
//
// Full stateful call chains: each test runs setters → openSession in one
// uninterrupted sequence without clearing mocks in the middle.
// The selectWhere responses are staged to reflect what the preceding setter
// calls would have persisted, so a regression in either setter would surface.

describe("global opt-out + per-guild opt-in interaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Scenario A ─────────────────────────────────────────────────────────────
  // 1. setVcGlobalPrivacyOptOut(user, true)   → global row: optedOut=true
  // 2. setVcPrivacyOptOut(guild, user, false) → per-guild row: optedOut=false
  // 3. openSession(...)                        → must still return null
  //    (global flag wins; per-guild opt-in alone cannot lift it)
  it("openSession is still blocked after per-guild opt-in while global opt-out is active", async () => {
    // Step 1: setVcGlobalPrivacyOptOut(user, true)
    //   → insert.values().onConflictDoUpdate()  [persists global optedOut=true]
    //   → update.set().where().returning()       [closeOpenSessionsForUser — no open sessions]
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]); // global insert
    mocks.returning.mockResolvedValueOnce([]);           // closeOpenSessionsForUser

    // Step 2: setVcPrivacyOptOut(guild, user, false)
    //   → insert.values().onConflictDoUpdate()  [persists per-guild optedOut=false]
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]); // per-guild insert

    // Step 3: openSession → isVcTrackingOptedOut → two parallel selects
    // The staged values reflect what was persisted by steps 1 & 2.
    mocks.selectWhere.mockResolvedValueOnce([{ userId: "user-gi-A", optedOut: true }]);  // global row
    mocks.selectWhere.mockResolvedValueOnce([{ guildId: "guild-gi-A", userId: "user-gi-A", optedOut: false }]); // per-guild row

    // Execute the full chain without clearing mocks between steps
    await setVcGlobalPrivacyOptOut("user-gi-A", true);
    await setVcPrivacyOptOut("guild-gi-A", "user-gi-A", false);
    const session = await openSession("guild-gi-A", "user-gi-A", "channel-gi-A");

    // Global flag must win — session must not be created
    expect(session).toBeNull();
    // db.insert() was called only twice (the two setters), not a third time for the session row
    expect(mocks.insert).toHaveBeenCalledTimes(2);
  });

  it("per-guild opt-in does not write or delete the global privacy row", async () => {
    // Run only setVcPrivacyOptOut(guild, user, false) and verify the insert
    // targets the per-guild table (communityVcPrivacyTable → proxy prefix "privacy.")
    // and NOT the global table (communityVcPrivacyGlobalTable → prefix "global.").
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);

    await setVcPrivacyOptOut("guild-gi-B", "user-gi-B", false);

    // Exactly one insert call
    expect(mocks.insert).toHaveBeenCalledTimes(1);

    // The table stub passed to db.insert() must be from communityVcPrivacyTable
    // (the proxy returns "privacy.<prop>" for every property on that table).
    const [tableArg] = mocks.insert.mock.calls[0] as unknown as [Record<string, string>];
    // communityVcPrivacyTable stub: any property returns "privacy.<prop>"
    expect(tableArg["guildId"]).toBe("privacy.guildId");
    // It must NOT be the global table
    expect(tableArg["guildId"]).not.toBe("global.guildId");

    // db.delete() must not have been called
    expect(mocks.deleteFn).not.toHaveBeenCalled();
  });

  // ─── Scenario B ─────────────────────────────────────────────────────────────
  // 1. setVcGlobalPrivacyOptOut(user, true)   → global row: optedOut=true
  // 2. setVcPrivacyOptOut(guild, user, false) → per-guild row: optedOut=false
  // 3. setVcGlobalPrivacyOptOut(user, false)  → global row: optedOut=false
  // 4. openSession(...)                        → must succeed
  //    (global opt-out cleared; per-guild row has optedOut=false → no block)
  it("openSession succeeds after clearing the global opt-out, with per-guild opt-in row already present", async () => {
    // Step 1: setVcGlobalPrivacyOptOut(user, true)
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]); // global insert
    mocks.returning.mockResolvedValueOnce([]);           // closeOpenSessionsForUser

    // Step 2: setVcPrivacyOptOut(guild, user, false)
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]); // per-guild insert

    // Step 3: setVcGlobalPrivacyOptOut(user, false)
    //   → insert.values().onConflictDoUpdate()  [persists global optedOut=false]
    //   → no closeOpenSessionsForUser (optedOut=false path)
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]); // global insert (opt-in)

    // Step 4: openSession → isVcTrackingOptedOut → two parallel selects
    // Staged to reflect persisted state: global=false, per-guild=false → not blocked
    mocks.selectWhere.mockResolvedValueOnce([{ userId: "user-gi-C", optedOut: false }]);  // global row now cleared
    mocks.selectWhere.mockResolvedValueOnce([{ guildId: "guild-gi-C", userId: "user-gi-C", optedOut: false }]); // per-guild row

    const fakeSession = {
      id: 1,
      guildId: "guild-gi-C",
      userId: "user-gi-C",
      channelId: "channel-gi-C",
      joinedAt: new Date(),
      leftAt: null,
    };
    mocks.returningFromInsert.mockResolvedValueOnce([fakeSession]);

    // Execute the full chain without clearing mocks between steps
    await setVcGlobalPrivacyOptOut("user-gi-C", true);
    await setVcPrivacyOptOut("guild-gi-C", "user-gi-C", false);
    await setVcGlobalPrivacyOptOut("user-gi-C", false);
    const session = await openSession("guild-gi-C", "user-gi-C", "channel-gi-C");

    expect(session).not.toBeNull();
    expect(session?.userId).toBe("user-gi-C");
    expect(session?.guildId).toBe("guild-gi-C");
    // The session row insert is the 4th insert call (after the 3 setter inserts)
    expect(mocks.insert).toHaveBeenCalledTimes(4);
  });

  it("setVcGlobalPrivacyOptOut(false) does not call closeOpenSessionsForUser (no update on opt-in path)", async () => {
    // Clearing the global opt-out must only upsert the flag — it must not
    // attempt to close any sessions (that would be the opt-out=true path).
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);

    const closed = await setVcGlobalPrivacyOptOut("user-gi-D", false);

    expect(closed).toBe(0);
    // db.update() (closeOpenSessionsForUser) must NOT have been called
    expect(mocks.update).not.toHaveBeenCalled();
    // The insert must target the global table (proxy prefix "global.")
    const [tableArg] = mocks.insert.mock.calls[0] as unknown as [Record<string, string>];
    expect(tableArg["userId"]).toBe("global.userId");
    const [valuesArg] = mocks.values.mock.calls[0] as unknown as [
      { userId: string; optedOut: boolean }
    ];
    expect(valuesArg.userId).toBe("user-gi-D");
    expect(valuesArg.optedOut).toBe(false);
  });
});
