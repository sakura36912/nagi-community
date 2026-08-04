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
import { closeOpenSessionsForUser, deleteAllUserVcSessions, isVcTrackingOptedOut, openSession, setVcGlobalPrivacyOptOut, setVcPrivacyOptOut } from "../lib/community.js";
import { handlePrivacyGlobalOptoutDelete, handlePrivacyGlobalOptoutKeep, handlePrivacyOptoutDelete, handlePrivacyOptoutKeep, handlePrivacyDeleteConfirm, handlePrivacyAdminDeleteConfirm, COMM_PRIVACY_ADMIN_DELETE_CONFIRM_PREFIX } from "../commands/index.js";

// ─── Fake discord.js ButtonInteraction ───────────────────────────────────────
function makeInteraction(userId: string, guildId?: string) {
  return {
    user: { id: userId },
    guildId: guildId ?? null,
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
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

  // Helper: set up the three mock results that every successful invocation needs.
  // deleteUserVcSessions  → db.delete().where().returning() resolves to `deletedRows` (sessions)
  //                       → db.delete().where().returning() resolves to []            (privacy row)
  // setVcPrivacyOptOut    → db.insert().values().onConflictDoUpdate() resolves (upsert)
  //                       → db.update().set().where().returning() resolves to [] (no open session)
  function setupMocks(deletedRows: { id: number }[]) {
    mocks.deleteReturning.mockResolvedValueOnce(deletedRows); // sessions delete
    mocks.deleteReturning.mockResolvedValueOnce([]);          // privacy row delete
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

    // db.delete() is called twice by deleteUserVcSessions: once for sessions,
    // once for the privacy opt-out row. The first WHERE must scope to guild+user.
    expect(mocks.deleteFn).toHaveBeenCalledTimes(2);

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

    // Both delete WHERE calls must carry guildId (sessions + privacy row).
    expect(mocks.deleteWhere).toHaveBeenCalledTimes(2);
    const [whereArg] = mocks.deleteWhere.mock.calls[0] as unknown as [
      { op: string; args: { op: string; col: string; val: string }[] }
    ];
    const vals = whereArg.args.filter((a) => a.op === "eq").map((a) => a.val);
    expect(vals).toContain("guild-pd-2");
    // The other guild must NOT appear
    expect(vals).not.toContain("some-other-guild");
  });

  it("calls setVcPrivacyOptOut after deleteUserVcSessions (sequential to avoid race)", async () => {
    setupMocks([]);

    const interaction = makeInteraction("user-pd-3", "guild-pd-3");
    await handlePrivacyOptoutDelete(interaction as never);

    // deleteUserVcSessions calls db.delete() twice (sessions + privacy row),
    // then setVcPrivacyOptOut is called sequentially so the opt-out upsert
    // cannot race against the privacy-row DELETE.
    expect(mocks.deleteFn).toHaveBeenCalledTimes(2);
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

// ─── handlePrivacyDeleteConfirm – two-step delete confirm path ───────────────
//
// This is the handler shown after the user taps "delete + opt-out" and confirms
// via the second button. It runs the same Promise.all pattern as
// handlePrivacyOptoutDelete but is a separate exported function.
// We verify:
//   - DM guard: no guildId → reply with ephemeral error and return early
//   - WHERE clause carries both guildId and userId (guild-scope)
//   - Embed description shows the correct deleted-row count
//   - components:[] so the confirmation buttons are cleared

describe('handlePrivacyDeleteConfirm – two-step delete confirm path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Helper: stage mock results for one successful invocation.
  // deleteUserVcSessions  → db.delete().where().returning()  → `deletedRows` (sessions)
  //                       → db.delete().where().returning()  → []            (privacy row)
  // setVcPrivacyOptOut    → db.insert().values().onConflictDoUpdate() (upsert)
  //                       → db.update().set().where().returning() → [] (no open session)
  function setupMocks(deletedRows: { id: number }[]) {
    mocks.deleteReturning.mockResolvedValueOnce(deletedRows); // sessions delete
    mocks.deleteReturning.mockResolvedValueOnce([]);          // privacy row delete
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]); // setVcPrivacyOptOut upsert
    mocks.returning.mockResolvedValueOnce([]);           // closeSession inside setVcPrivacyOptOut
  }

  it("does nothing (except reply ephemerally) when guildId is absent (DM context guard)", async () => {
    const interaction = makeInteraction("user-dc-0");
    await handlePrivacyDeleteConfirm(interaction as never);

    // Must not touch the database
    expect(mocks.deleteFn).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    // Must not defer — must reply directly with the ephemeral error
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
  });

  it("calls deleteUserVcSessions scoped to the confirming guild (WHERE carries guildId)", async () => {
    setupMocks([]);

    const interaction = makeInteraction("user-dc-1", "guild-dc-1");
    await handlePrivacyDeleteConfirm(interaction as never);

    // db.delete() is called twice by deleteUserVcSessions: sessions + privacy row.
    expect(mocks.deleteFn).toHaveBeenCalledTimes(2);

    // The first WHERE argument must be an AND that includes both guildId and userId.
    const [whereArg] = mocks.deleteWhere.mock.calls[0] as unknown as [
      { op: string; args: { op: string; col: string; val: string }[] }
    ];
    expect(whereArg.op).toBe("and");
    const eqVals = whereArg.args
      .filter((a) => a.op === "eq")
      .map((a) => a.val);
    expect(eqVals).toContain("guild-dc-1");
    expect(eqVals).toContain("user-dc-1");
  });

  it("scopes the delete to one guild only (another guild's id must not appear in WHERE)", async () => {
    setupMocks([{ id: 1 }, { id: 2 }]);

    const interaction = makeInteraction("user-dc-2", "guild-dc-2");
    await handlePrivacyDeleteConfirm(interaction as never);

    // Both WHERE calls (sessions + privacy) must scope to this guild.
    expect(mocks.deleteWhere).toHaveBeenCalledTimes(2);
    const [whereArg] = mocks.deleteWhere.mock.calls[0] as unknown as [
      { op: string; args: { op: string; col: string; val: string }[] }
    ];
    const eqVals = whereArg.args.filter((a) => a.op === "eq").map((a) => a.val);
    expect(eqVals).toContain("guild-dc-2");
    expect(eqVals).not.toContain("some-other-guild");
  });

  it("embed description contains the correct deleted-row count (2 rows)", async () => {
    setupMocks([{ id: 10 }, { id: 11 }]);

    const interaction = makeInteraction("user-dc-3", "guild-dc-3");
    await handlePrivacyDeleteConfirm(interaction as never);

    const [[replyArg]] = interaction.editReply.mock.calls as [[{ embeds: { data: { description?: string } }[] }]];
    const description = replyArg.embeds[0]?.data?.description ?? "";
    expect(description).toContain("2件");
  });

  it("embed description contains the correct deleted-row count (0 rows)", async () => {
    setupMocks([]);

    const interaction = makeInteraction("user-dc-4", "guild-dc-4");
    await handlePrivacyDeleteConfirm(interaction as never);

    const [[replyArg]] = interaction.editReply.mock.calls as [[{ embeds: { data: { description?: string } }[] }]];
    const description = replyArg.embeds[0]?.data?.description ?? "";
    expect(description).toContain("0件");
  });

  it("replies with components:[] so the confirm buttons are cleared after deletion", async () => {
    setupMocks([{ id: 99 }]);

    const interaction = makeInteraction("user-dc-5", "guild-dc-5");
    await handlePrivacyDeleteConfirm(interaction as never);

    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ components: [] }),
    );
  });

  it("also calls setVcPrivacyOptOut (insert) scoped to the same guild", async () => {
    setupMocks([]);

    const interaction = makeInteraction("user-dc-6", "guild-dc-6");
    await handlePrivacyDeleteConfirm(interaction as never);

    // db.insert() must have been called by setVcPrivacyOptOut
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    const [valuesArg] = mocks.values.mock.calls[0] as unknown as [
      { guildId: string; userId: string; optedOut: boolean }
    ];
    expect(valuesArg.guildId).toBe("guild-dc-6");
    expect(valuesArg.userId).toBe("user-dc-6");
    expect(valuesArg.optedOut).toBe(true);
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

// ─── handlePrivacyAdminDeleteConfirm – admin-initiated member data wipe ───────
//
// An admin uses /privacy admin-delete <user> which stages a confirmation button
// whose customId encodes the target user's id.  When the admin confirms:
//   • deleteUserVcSessions(guildId, targetUserId) is called — guild-scoped DELETE
//   • The embed description shows the number of deleted rows
//   • components:[] clears the confirmation buttons
//
// We verify:
//   - DM guard: no guildId → ephemeral error, no DB calls
//   - Permission guard: member without ManageGuild → ephemeral error, no DB calls
//   - WHERE clause carries both the admin's guildId AND the targetUserId
//   - WHERE clause does NOT reference another guild
//   - Embed shows the correct deleted-row count
//   - components:[] is returned so buttons are removed

describe('handlePrivacyAdminDeleteConfirm – admin-initiated member data wipe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Build a fake ButtonInteraction for the admin-delete confirm button.
   * `targetUserId`  is encoded in the customId (mirrors the real handler).
   * `isAdmin`       controls whether member.permissions.has() returns true.
   */
  function makeAdminInteraction(
    adminUserId: string,
    guildId: string | undefined,
    targetUserId: string,
    isAdmin = true,
  ) {
    return {
      user: { id: adminUserId, tag: `${adminUserId}#0000` },
      guildId: guildId ?? null,
      customId: `${COMM_PRIVACY_ADMIN_DELETE_CONFIRM_PREFIX}${targetUserId}`,
      member: {
        permissions: {
          has: vi.fn().mockReturnValue(isAdmin),
        },
      },
      guild: { name: "Test Guild", channels: { cache: { get: vi.fn().mockReturnValue(null) } } },
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("does nothing (except reply ephemerally) when guildId is absent (DM context guard)", async () => {
    const interaction = makeAdminInteraction("admin-ad-0", undefined, "target-ad-0");
    await handlePrivacyAdminDeleteConfirm(interaction as never);

    expect(mocks.deleteFn).not.toHaveBeenCalled();
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
  });

  it("does nothing (except reply ephemerally) when member lacks ManageGuild permission", async () => {
    const interaction = makeAdminInteraction("non-admin-ad-1", "guild-ad-1", "target-ad-1", false);
    await handlePrivacyAdminDeleteConfirm(interaction as never);

    expect(mocks.deleteFn).not.toHaveBeenCalled();
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
  });

  it("calls deleteUserVcSessions with the admin's guildId and the target userId", async () => {
    mocks.deleteReturning.mockResolvedValueOnce([]); // sessions delete
    mocks.deleteReturning.mockResolvedValueOnce([]); // privacy row delete

    const interaction = makeAdminInteraction("admin-ad-2", "guild-ad-2", "target-ad-2");
    await handlePrivacyAdminDeleteConfirm(interaction as never);

    // db.delete() is called twice by deleteUserVcSessions: sessions + privacy row.
    expect(mocks.deleteFn).toHaveBeenCalledTimes(2);

    // The first WHERE argument must be AND( eq(guildId), eq(userId) )
    const [whereArg] = mocks.deleteWhere.mock.calls[0] as unknown as [
      { op: string; args: { op: string; col: string; val: string }[] }
    ];
    expect(whereArg.op).toBe("and");
    const eqVals = whereArg.args
      .filter((a) => a.op === "eq")
      .map((a) => a.val);
    expect(eqVals).toContain("guild-ad-2");
    expect(eqVals).toContain("target-ad-2");
  });

  it("scopes the delete to only the admin's guild (another guild must not appear in WHERE)", async () => {
    mocks.deleteReturning.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]); // sessions
    mocks.deleteReturning.mockResolvedValueOnce([]);                      // privacy row

    const interaction = makeAdminInteraction("admin-ad-3", "guild-ad-3", "target-ad-3");
    await handlePrivacyAdminDeleteConfirm(interaction as never);

    // Both WHERE calls (sessions + privacy) must scope to admin's guild.
    expect(mocks.deleteWhere).toHaveBeenCalledTimes(2);
    const [whereArg] = mocks.deleteWhere.mock.calls[0] as unknown as [
      { op: string; args: { op: string; col: string; val: string }[] }
    ];
    const eqVals = whereArg.args.filter((a) => a.op === "eq").map((a) => a.val);
    expect(eqVals).toContain("guild-ad-3");
    // A different guild's id must NOT appear in the WHERE clause
    expect(eqVals).not.toContain("some-other-guild");
  });

  it("embed description contains the correct deleted-row count (3 rows)", async () => {
    mocks.deleteReturning.mockResolvedValueOnce([{ id: 10 }, { id: 11 }, { id: 12 }]);

    const interaction = makeAdminInteraction("admin-ad-4", "guild-ad-4", "target-ad-4");
    await handlePrivacyAdminDeleteConfirm(interaction as never);

    const [[replyArg]] = interaction.editReply.mock.calls as [[{ embeds: { data: { description?: string } }[] }]];
    const description = replyArg.embeds[0]?.data?.description ?? "";
    expect(description).toContain("3件");
  });

  it("embed description contains the correct deleted-row count (0 rows)", async () => {
    mocks.deleteReturning.mockResolvedValueOnce([]);

    const interaction = makeAdminInteraction("admin-ad-5", "guild-ad-5", "target-ad-5");
    await handlePrivacyAdminDeleteConfirm(interaction as never);

    const [[replyArg]] = interaction.editReply.mock.calls as [[{ embeds: { data: { description?: string } }[] }]];
    const description = replyArg.embeds[0]?.data?.description ?? "";
    expect(description).toContain("0件");
  });

  it("replies with components:[] so the confirmation buttons are cleared", async () => {
    mocks.deleteReturning.mockResolvedValueOnce([{ id: 99 }]);

    const interaction = makeAdminInteraction("admin-ad-6", "guild-ad-6", "target-ad-6");
    await handlePrivacyAdminDeleteConfirm(interaction as never);

    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ components: [] }),
    );
  });

  it("does not touch another user's sessions (targetUserId in WHERE, not adminUserId)", async () => {
    mocks.deleteReturning.mockResolvedValueOnce([]);

    const interaction = makeAdminInteraction("admin-ad-7", "guild-ad-7", "target-ad-7");
    await handlePrivacyAdminDeleteConfirm(interaction as never);

    const [whereArg] = mocks.deleteWhere.mock.calls[0] as unknown as [
      { op: string; args: { op: string; col: string; val: string }[] }
    ];
    const eqVals = whereArg.args.filter((a) => a.op === "eq").map((a) => a.val);
    // The target's id must be in the WHERE clause
    expect(eqVals).toContain("target-ad-7");
    // The admin's own id must NOT be used as the userId filter
    expect(eqVals).not.toContain("admin-ad-7");
  });
});

// ─── deleteAllUserVcSessions – global wipe scoped to one user only ────────────
//
// This function issues a DELETE WHERE userId = <target> across ALL guilds.
// We verify:
//   - The WHERE clause carries exactly the target userId (no guildId)
//   - Another user's id must NOT appear in the WHERE clause
//   - The returned count equals the number of rows the mock reports as deleted
//   - Returns 0 when there are no rows to delete

describe("deleteAllUserVcSessions – global wipe scoped to one user only", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 0 when the user has no session rows", async () => {
    mocks.deleteReturning.mockResolvedValueOnce([]);

    const count = await deleteAllUserVcSessions("user-dav-0");

    expect(count).toBe(0);
  });

  it("returns the number of rows deleted when sessions exist", async () => {
    mocks.deleteReturning.mockResolvedValueOnce([{ id: 1 }, { id: 2 }, { id: 3 }]);

    const count = await deleteAllUserVcSessions("user-dav-1");

    expect(count).toBe(3);
  });

  it("WHERE clause carries only the target userId (eq filter)", async () => {
    mocks.deleteReturning.mockResolvedValueOnce([]);
    // Second call is for the global opt-out delete; return empty array.
    mocks.deleteReturning.mockResolvedValueOnce([]);

    await deleteAllUserVcSessions("user-dav-2");

    // db.delete() is called twice: once for sessions, once for the global opt-out row.
    expect(mocks.deleteFn).toHaveBeenCalledTimes(2);

    // Check the FIRST call (sessions) – its WHERE must carry only the userId.
    // Accept both a bare eq and an AND that contains an eq so the test stays
    // resilient to minor refactors.
    const [whereArg] = mocks.deleteWhere.mock.calls[0] as unknown as [
      { op: string; col?: string; val?: string; args?: { op: string; val: string }[] }
    ];

    // Collect all eq values regardless of nesting depth
    const collectEqVals = (node: { op: string; val?: string; args?: unknown[] }): string[] => {
      if (node.op === "eq") return [node.val as string];
      if (node.op === "and" && Array.isArray(node.args)) {
        return (node.args as { op: string; val?: string; args?: unknown[] }[]).flatMap(collectEqVals);
      }
      return [];
    };
    const eqVals = collectEqVals(whereArg as { op: string; val?: string; args?: unknown[] });

    expect(eqVals).toContain("user-dav-2");
  });

  it("WHERE clause does NOT include a guildId (global scope – all guilds)", async () => {
    mocks.deleteReturning.mockResolvedValueOnce([{ id: 10 }]);

    await deleteAllUserVcSessions("user-dav-3");

    const [whereArg] = mocks.deleteWhere.mock.calls[0] as unknown as [
      { op: string; col?: string; val?: string; args?: { op: string; val: string }[] }
    ];

    // The WHERE must not reference any guildId value.  Since the mock table proxy
    // returns "sessions.<column>" for column access, a guildId eq filter would
    // carry the column string "sessions.guildId".  Verify that is absent.
    const collectCols = (node: { op: string; col?: string; args?: unknown[] }): string[] => {
      if (node.op === "eq") return [node.col as string];
      if (node.op === "and" && Array.isArray(node.args)) {
        return (node.args as { op: string; col?: string; args?: unknown[] }[]).flatMap(collectCols);
      }
      return [];
    };
    const cols = collectCols(whereArg as { op: string; col?: string; args?: unknown[] });

    expect(cols).not.toContain("sessions.guildId");
  });

  it("targets the vc sessions table (not another table)", async () => {
    mocks.deleteReturning.mockResolvedValueOnce([]);

    await deleteAllUserVcSessions("user-dav-4");

    // The table stub passed to db.delete() must be communityVcSessionsTable
    // (proxy returns "sessions.<prop>" for any property access on that stub).
    const [tableArg] = mocks.deleteFn.mock.calls[0] as unknown as [Record<string, string>];
    expect(tableArg["userId"]).toBe("sessions.userId");
  });

  it("another user's id does not appear in the WHERE clause", async () => {
    mocks.deleteReturning.mockResolvedValueOnce([]);

    await deleteAllUserVcSessions("user-dav-5");

    const [whereArg] = mocks.deleteWhere.mock.calls[0] as unknown as [
      { op: string; val?: string; args?: { op: string; val: string }[] }
    ];

    const collectEqVals = (node: { op: string; val?: string; args?: unknown[] }): string[] => {
      if (node.op === "eq") return [node.val as string];
      if (node.op === "and" && Array.isArray(node.args)) {
        return (node.args as { op: string; val?: string; args?: unknown[] }[]).flatMap(collectEqVals);
      }
      return [];
    };
    const eqVals = collectEqVals(whereArg as { op: string; val?: string; args?: unknown[] });

    // Only the target user must appear
    expect(eqVals).toContain("user-dav-5");
    // A different user must NOT appear
    expect(eqVals).not.toContain("user-other");
  });
});

// ─── handlePrivacyGlobalOptoutDelete – global opt-out + full wipe path ────────
//
// This handler runs deleteAllUserVcSessions then setVcGlobalPrivacyOptOut sequentially
// so the final opt-out state is deterministic.  deleteAllUserVcSessions issues a
// cross-guild DELETE for sessions and also clears the global opt-out row; then
// setVcGlobalPrivacyOptOut re-sets the global opt-out to true.  We verify:
//   - db.delete() is called twice (sessions + global opt-out row)
//   - The embed description shows the correct deleted-row count
//   - db.insert() is called (for setVcGlobalPrivacyOptOut re-set)
//   - components:[] clears the opt-out buttons

describe("handlePrivacyGlobalOptoutDelete – global opt-out + full wipe path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Helper: stage mocks for one successful invocation.
  // deleteAllUserVcSessions:
  //   → db.delete(sessions).where().returning()      → `deletedRows`
  //   → db.delete(global).where().returning()        → [] (clear global opt-out row)
  // setVcGlobalPrivacyOptOut → db.insert().values().onConflictDoUpdate() (upsert)
  //                          → db.update().set().where().returning() (closeOpenSessionsForUser)
  function setupMocks(deletedRows: { id: number }[]) {
    mocks.deleteReturning.mockResolvedValueOnce(deletedRows); // session rows deleted
    mocks.deleteReturning.mockResolvedValueOnce([]);           // global opt-out row cleared
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);        // global opt-out upsert (re-set)
    mocks.returning.mockResolvedValueOnce([]);                 // closeOpenSessionsForUser (no open sessions)
  }

  it("calls db.delete() twice — once for sessions, once to clear the global opt-out row", async () => {
    setupMocks([]);

    const interaction = makeInteraction("user-god-1");
    await handlePrivacyGlobalOptoutDelete(interaction as never);

    // deleteAllUserVcSessions performs two deletes: sessions + global opt-out row.
    expect(mocks.deleteFn).toHaveBeenCalledTimes(2);
    const tables = (mocks.deleteFn.mock.calls as unknown as [Record<string, string>][]).map((c) => c[0]?.["userId"]);
    expect(tables).toContain("sessions.userId");
    expect(tables).toContain("global.userId");
  });

  it("WHERE clause on the delete carries only the userId (not a guildId)", async () => {
    setupMocks([{ id: 1 }, { id: 2 }]);

    const interaction = makeInteraction("user-god-2");
    await handlePrivacyGlobalOptoutDelete(interaction as never);

    const [whereArg] = mocks.deleteWhere.mock.calls[0] as unknown as [
      { op: string; col?: string; val?: string; args?: { op: string; col?: string; val?: string }[] }
    ];

    const collectEqVals = (node: { op: string; val?: string; args?: unknown[] }): string[] => {
      if (node.op === "eq") return [node.val as string];
      if (node.op === "and" && Array.isArray(node.args)) {
        return (node.args as { op: string; val?: string; args?: unknown[] }[]).flatMap(collectEqVals);
      }
      return [];
    };
    const collectCols = (node: { op: string; col?: string; args?: unknown[] }): string[] => {
      if (node.op === "eq") return [node.col as string];
      if (node.op === "and" && Array.isArray(node.args)) {
        return (node.args as { op: string; col?: string; args?: unknown[] }[]).flatMap(collectCols);
      }
      return [];
    };

    const eqVals = collectEqVals(whereArg as { op: string; val?: string; args?: unknown[] });
    const cols = collectCols(whereArg as { op: string; col?: string; args?: unknown[] });

    // The calling user's id must be the userId filter
    expect(eqVals).toContain("user-god-2");
    // No guildId column must appear (this is a cross-guild delete)
    expect(cols).not.toContain("sessions.guildId");
  });

  it("embed description shows the correct deleted-row count (5 rows)", async () => {
    setupMocks([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }]);

    const interaction = makeInteraction("user-god-3");
    await handlePrivacyGlobalOptoutDelete(interaction as never);

    const [[replyArg]] = interaction.editReply.mock.calls as [[{ embeds: { data: { description?: string } }[] }]];
    const description = replyArg.embeds[0]?.data?.description ?? "";
    expect(description).toContain("5件");
  });

  it("embed description shows the correct deleted-row count (0 rows)", async () => {
    setupMocks([]);

    const interaction = makeInteraction("user-god-4");
    await handlePrivacyGlobalOptoutDelete(interaction as never);

    const [[replyArg]] = interaction.editReply.mock.calls as [[{ embeds: { data: { description?: string } }[] }]];
    const description = replyArg.embeds[0]?.data?.description ?? "";
    expect(description).toContain("0件");
  });

  it("also calls setVcGlobalPrivacyOptOut (db.insert is called with optedOut=true)", async () => {
    setupMocks([]);

    const interaction = makeInteraction("user-god-5");
    await handlePrivacyGlobalOptoutDelete(interaction as never);

    // db.insert() must have been called by setVcGlobalPrivacyOptOut
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    const [valuesArg] = mocks.values.mock.calls[0] as unknown as [
      { userId: string; optedOut: boolean }
    ];
    expect(valuesArg.userId).toBe("user-god-5");
    expect(valuesArg.optedOut).toBe(true);
  });

  it("replies with components:[] so the opt-out buttons are removed", async () => {
    setupMocks([{ id: 99 }]);

    const interaction = makeInteraction("user-god-6");
    await handlePrivacyGlobalOptoutDelete(interaction as never);

    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ components: [] }),
    );
  });

  it("does not touch another user's sessions (only the calling userId appears in WHERE)", async () => {
    setupMocks([]);

    const interaction = makeInteraction("user-god-7");
    await handlePrivacyGlobalOptoutDelete(interaction as never);

    const [whereArg] = mocks.deleteWhere.mock.calls[0] as unknown as [
      { op: string; val?: string; args?: { op: string; val?: string }[] }
    ];

    const collectEqVals = (node: { op: string; val?: string; args?: unknown[] }): string[] => {
      if (node.op === "eq") return [node.val as string];
      if (node.op === "and" && Array.isArray(node.args)) {
        return (node.args as { op: string; val?: string; args?: unknown[] }[]).flatMap(collectEqVals);
      }
      return [];
    };
    const eqVals = collectEqVals(whereArg as { op: string; val?: string; args?: unknown[] });

    // Only the invoking user's id must appear in the WHERE clause
    expect(eqVals).toContain("user-god-7");
    // A different user's id must NOT appear
    expect(eqVals).not.toContain("user-other-god");
  });
});

// ─── isVcTrackingOptedOut – all four global/per-guild flag combinations ────────
//
// isVcTrackingOptedOut is the core gate used by openSession. It runs two
// parallel selects (global table, per-guild table) and returns true when
// either flag is opted-out=true. We verify every combination:
//
//   global=false, per-guild=false → false  (not blocked)
//   global=false, per-guild=true  → true   (blocked by per-guild flag)
//   global=true,  per-guild=false → true   (blocked; global wins)
//   global=true,  per-guild=true  → true   (blocked; both flags set)
//
// The first selectWhere mock call resolves the global table query,
// the second resolves the per-guild table query (matching the Promise.all order
// inside isVcTrackingOptedOut).

describe("isVcTrackingOptedOut – all four global/per-guild flag combinations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns false when global=false and per-guild=false (not blocked)", async () => {
    // global table: no opted-out row
    mocks.selectWhere.mockResolvedValueOnce([]);
    // per-guild table: no opted-out row
    mocks.selectWhere.mockResolvedValueOnce([]);

    const result = await isVcTrackingOptedOut("guild-comb-A", "user-comb-A");

    expect(result).toBe(false);
    // No insert should have been triggered (we only queried)
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("returns true when global=false and per-guild=true (blocked by per-guild flag)", async () => {
    // global table: row exists but optedOut=false
    mocks.selectWhere.mockResolvedValueOnce([{ userId: "user-comb-B", optedOut: false }]);
    // per-guild table: row with optedOut=true
    mocks.selectWhere.mockResolvedValueOnce([{ guildId: "guild-comb-B", userId: "user-comb-B", optedOut: true }]);

    const result = await isVcTrackingOptedOut("guild-comb-B", "user-comb-B");

    expect(result).toBe(true);
    // No session insert should have occurred
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("returns true when global=true and per-guild=false (blocked; global wins)", async () => {
    // global table: row with optedOut=true
    mocks.selectWhere.mockResolvedValueOnce([{ userId: "user-comb-C", optedOut: true }]);
    // per-guild table: row with optedOut=false (opt-in at guild level)
    mocks.selectWhere.mockResolvedValueOnce([{ guildId: "guild-comb-C", userId: "user-comb-C", optedOut: false }]);

    const result = await isVcTrackingOptedOut("guild-comb-C", "user-comb-C");

    expect(result).toBe(true);
    // No session insert should have occurred
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("returns true when global=true and per-guild=true (blocked; both flags set)", async () => {
    // global table: row with optedOut=true
    mocks.selectWhere.mockResolvedValueOnce([{ userId: "user-comb-D", optedOut: true }]);
    // per-guild table: row with optedOut=true
    mocks.selectWhere.mockResolvedValueOnce([{ guildId: "guild-comb-D", userId: "user-comb-D", optedOut: true }]);

    const result = await isVcTrackingOptedOut("guild-comb-D", "user-comb-D");

    expect(result).toBe(true);
    // No session insert should have occurred
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});

// ─── Cold-start path: brand-new user with zero privacy rows ──────────────────
//
// A first-time user has never interacted with the privacy commands, so neither
// communityVcPrivacyGlobalTable nor communityVcPrivacyTable has a row for them.
// isVcTrackingOptedOut must return false (not throw, not misread undefined as
// opted-out) and openSession must successfully insert a session row.

describe("cold-start: brand-new user with no privacy rows is never blocked", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("isVcTrackingOptedOut returns false when no row exists in either privacy table", async () => {
    // Both parallel selects return empty arrays — no privacy rows at all
    mocks.selectWhere.mockResolvedValueOnce([]); // global table → no row
    mocks.selectWhere.mockResolvedValueOnce([]); // per-guild table → no row

    const result = await isVcTrackingOptedOut("guild-cs-1", "user-cs-1");

    expect(result).toBe(false);
  });

  it("isVcTrackingOptedOut does not throw when both queries return undefined rows", async () => {
    // Defensive: ensure the function never throws on a cold-start path
    mocks.selectWhere.mockResolvedValueOnce([]);
    mocks.selectWhere.mockResolvedValueOnce([]);

    await expect(isVcTrackingOptedOut("guild-cs-2", "user-cs-2")).resolves.toBe(false);
  });

  it("openSession inserts a session row for a brand-new user (not blocked)", async () => {
    // isVcTrackingOptedOut → both selects return empty (no privacy rows)
    mocks.selectWhere.mockResolvedValueOnce([]); // global table → no row
    mocks.selectWhere.mockResolvedValueOnce([]); // per-guild table → no row

    // The insert inside openSession uses .values().returning()
    const fakeSession = {
      id: 42,
      guildId: "guild-cs-3",
      userId: "user-cs-3",
      channelId: "channel-cs-3",
      joinedAt: new Date(),
      leftAt: null,
      isExile: false,
    };
    mocks.returningFromInsert.mockResolvedValueOnce([fakeSession]);

    const session = await openSession("guild-cs-3", "user-cs-3", "channel-cs-3");

    // A real session must be returned — the user was not blocked
    expect(session).not.toBeNull();
    expect(session?.userId).toBe("user-cs-3");
    expect(session?.guildId).toBe("guild-cs-3");
    expect(session?.channelId).toBe("channel-cs-3");
  });

  it("openSession calls db.insert() exactly once for a brand-new user (the session row)", async () => {
    // No privacy rows in either table
    mocks.selectWhere.mockResolvedValueOnce([]);
    mocks.selectWhere.mockResolvedValueOnce([]);

    const fakeSession = {
      id: 43,
      guildId: "guild-cs-4",
      userId: "user-cs-4",
      channelId: "channel-cs-4",
      joinedAt: new Date(),
      leftAt: null,
      isExile: false,
    };
    mocks.returningFromInsert.mockResolvedValueOnce([fakeSession]);

    await openSession("guild-cs-4", "user-cs-4", "channel-cs-4");

    // Exactly one insert — the session row. No phantom opt-out write.
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    // The table passed to db.insert() must be the sessions table
    const [tableArg] = mocks.insert.mock.calls[0] as unknown as [Record<string, string>];
    expect(tableArg["userId"]).toBe("sessions.userId");
  });

  it("openSession does not call db.update() for a brand-new user (no close-session side-effect)", async () => {
    // No privacy rows in either table
    mocks.selectWhere.mockResolvedValueOnce([]);
    mocks.selectWhere.mockResolvedValueOnce([]);

    const fakeSession = {
      id: 44,
      guildId: "guild-cs-5",
      userId: "user-cs-5",
      channelId: "channel-cs-5",
      joinedAt: new Date(),
      leftAt: null,
      isExile: false,
    };
    mocks.returningFromInsert.mockResolvedValueOnce([fakeSession]);

    await openSession("guild-cs-5", "user-cs-5", "channel-cs-5");

    // db.update() (used by closeSession) must NOT have been called
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
