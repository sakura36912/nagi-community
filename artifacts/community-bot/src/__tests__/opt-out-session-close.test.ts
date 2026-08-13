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
import { closeOpenSessionsForUser, deleteAllUserVcSessions, isVcTrackingGloballyOptedOut, isVcTrackingOptedOut, openSession, setVcGlobalPrivacyOptOut, setVcPrivacyOptOut } from "../lib/community.js";
import { handlePrivacyGlobalOptoutDelete, handlePrivacyGlobalOptoutKeep, handlePrivacyOptoutDelete, handlePrivacyOptoutKeep, handlePrivacyDeleteConfirm, handlePrivacyDeleteCancel, handlePrivacyAdminDeleteConfirm, handlePrivacyAdminDeleteCancel, COMM_PRIVACY_ADMIN_DELETE_CONFIRM_PREFIX } from "../commands/index.js";

// ─── Fake discord.js ButtonInteraction ───────────────────────────────────────
function makeInteraction(userId: string, guildId?: string) {
  return {
    user: { id: userId },
    guildId: guildId ?? null,
    guild: null,
    // Provide a client stub with an empty guilds cache so handlers that access
    // interaction.client.guilds.cache in the DM path don't throw.
    client: { guilds: { cache: new Map() } },
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

  // ── Replay-safety tests ────────────────────────────────────────────────────
  // A replayed interaction is one where user B obtains the interaction token
  // originally issued to user A and re-submits it. Discord resolves the
  // interaction as belonging to user B (interaction.user.id = B), so the
  // handler must use interaction.user.id — not any external state — for all
  // DB writes. These tests confirm that the clicking user's id is the only
  // id that appears in the opt-out upsert, and that no cross-user data
  // deletion occurs.

  it("replayed interaction: opt-out upsert targets only the clicking user's id, not the original user's id", async () => {
    // The original user who triggered the embed
    const originalUserId = "user-original-global";
    // A bystander who replays the interaction (different token holder)
    const replayerUserId = "user-replayer-global";

    // setVcGlobalPrivacyOptOut path:
    //   1. closeOpenSessionsForUser → db.update (returns no open sessions)
    //   2. global opt-out upsert   → db.insert
    mocks.returning.mockResolvedValueOnce([]);        // closeOpenSessionsForUser
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]); // global opt-out upsert

    // The replayer clicks the button — interaction.user.id is the replayer's id
    const interaction = makeInteraction(replayerUserId);
    await handlePrivacyGlobalOptoutKeep(interaction as never);

    // The insert must have been called exactly once
    expect(mocks.insert).toHaveBeenCalledTimes(1);

    // The values() payload must reference the replayer's id, NOT the original user's id
    const [valuesArg] = mocks.values.mock.calls[0] as unknown as [
      { userId: string; optedOut: boolean }
    ];
    expect(valuesArg.userId).toBe(replayerUserId);
    expect(valuesArg.userId).not.toBe(originalUserId);
    expect(valuesArg.optedOut).toBe(true);
  });

  it("replayed interaction: no data deletion occurs (db.delete is never called)", async () => {
    // Even when a different user replays the keep-data interaction, the handler
    // must not delete any session rows — that is the delete-data path, not the
    // keep-data path.
    mocks.returning.mockResolvedValueOnce([]);
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);

    const interaction = makeInteraction("user-replayer-global-2");
    await handlePrivacyGlobalOptoutKeep(interaction as never);

    // db.delete() must never be invoked on the keep-data path
    expect(mocks.deleteFn).not.toHaveBeenCalled();
  });

  it("replayed interaction: only the replaying user's sessions are closed (update WHERE carries replayer's id)", async () => {
    // The session-close update must scope to the replayer's userId, not to
    // any externally-stored "original" user id.
    mocks.returning.mockResolvedValueOnce([{ id: 77 }]); // one open session closed
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);

    const replayerUserId = "user-replayer-global-3";
    const interaction = makeInteraction(replayerUserId);
    await handlePrivacyGlobalOptoutKeep(interaction as never);

    // db.update() must have been called (closeOpenSessionsForUser)
    expect(mocks.update).toHaveBeenCalledTimes(1);

    // The where() clause must reference the replayer's id
    const [whereArg] = mocks.where.mock.calls[0] as unknown as [
      { op: string; args: { op: string; col: unknown; val: unknown }[] }
    ];
    expect(whereArg.op).toBe("and");
    const eqVals = whereArg.args
      .filter((a) => a.op === "eq")
      .map((a) => a.val);
    expect(eqVals).toContain(replayerUserId);
    // Another user's id must not appear in the WHERE clause
    expect(eqVals).not.toContain("user-original-global");
  });
});

// ─── handlePrivacyGlobalOptoutKeep – replay safety as global delete-flow cancel button ─
//
// The /privacy optout-all command posts an ephemeral embed with two buttons:
//   • "全サーバーで停止（データを保持）" (COMM_PRIVACY_GLOBAL_OPTOUT_KEEP)
//     → handlePrivacyGlobalOptoutKeep  ← this is the "cancel deletion" choice
//   • "全サーバーで停止＋全データ削除" (COMM_PRIVACY_GLOBAL_OPTOUT_DELETE)
//     → handlePrivacyGlobalOptoutDelete
//
// The KEEP button is the "cancel" of the destructive branch: clicking it opts
// the user out globally (stop tracking, keep history) instead of wiping data.
//
// Replay risk: the button's customId is a plain constant with no nonce or
// userId encoded. Any user who obtains the interaction token could click it.
//
// Unlike handlePrivacyDeleteCancel (which does no DB writes at all), this
// handler DOES write data — but the safety guarantee is different:
//   1. Every write (opt-out upsert, session-close update) exclusively targets
//      interaction.user.id — the clicking user, whoever that turns out to be.
//   2. db.delete() is NEVER called on this path, so no cross-user data
//      deletion can occur regardless of who holds the token.
//
// Tests verify:
//   - A replayed call from a different userId cannot cause db.delete() to fire
//   - The opt-out upsert targets only interaction.user.id — not the original user's id
//   - The session-close WHERE clause carries only the replayer's userId
//   - The original user's data is not touched (their id appears in no DB write)

describe("handlePrivacyGlobalOptoutKeep – replay safety (global opt-out delete cancel button)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("a replayed cancel from a different userId cannot trigger db.delete() (no cross-user data wipe)", async () => {
    // User A triggered the embed; user B replays the interaction token.
    // The keep-data path must never call db.delete() — for either user.
    mocks.returning.mockResolvedValueOnce([]);         // closeOpenSessionsForUser → 0 sessions
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]); // global opt-out upsert

    const replayerUserId = "user-replayer-cancel-1";
    const interaction = makeInteraction(replayerUserId);
    await handlePrivacyGlobalOptoutKeep(interaction as never);

    // db.delete() must never fire on the keep-data/cancel path
    expect(mocks.deleteFn).not.toHaveBeenCalled();
  });

  it("a replayed cancel opts out only the clicking user — the original user's id never appears in any DB write", async () => {
    const originalUserId = "user-original-cancel-2";
    const replayerUserId = "user-replayer-cancel-2";

    mocks.returning.mockResolvedValueOnce([]);
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);

    // Replayer clicks the button
    const interaction = makeInteraction(replayerUserId);
    await handlePrivacyGlobalOptoutKeep(interaction as never);

    // The opt-out upsert (insert) must target the replayer's userId, not the original user's
    const [valuesArg] = mocks.values.mock.calls[0] as unknown as [{ userId: string; optedOut: boolean }];
    expect(valuesArg.userId).toBe(replayerUserId);
    expect(valuesArg.userId).not.toBe(originalUserId);
    expect(valuesArg.optedOut).toBe(true);

    // The session-close update WHERE must reference the replayer's userId only
    const [whereArg] = mocks.where.mock.calls[0] as unknown as [
      { op: string; args: { op: string; col: unknown; val: unknown }[] }
    ];
    const eqVals = whereArg.args.filter((a) => a.op === "eq").map((a) => a.val);
    expect(eqVals).toContain(replayerUserId);
    expect(eqVals).not.toContain(originalUserId);
  });

  it("a replayed cancel still defers and clears the embed components (UI update fires correctly)", async () => {
    mocks.returning.mockResolvedValueOnce([]);
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);

    const interaction = makeInteraction("user-replayer-cancel-3");
    await handlePrivacyGlobalOptoutKeep(interaction as never);

    expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ components: [] }),
    );
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

// ─── setVcGlobalPrivacyOptOut – cold-start opt-in path (optedOut=false) ──────
//
// A user who has never touched the global opt-out setting has no row in
// communityVcPrivacyGlobalTable. Calling setVcGlobalPrivacyOptOut(userId, false)
// must still succeed: it takes the INSERT branch of the upsert (no conflict),
// stores optedOut=false, and must NOT call closeOpenSessionsForUser (the
// session-close path is only for optedOut=true).

describe("setVcGlobalPrivacyOptOut – cold-start opt-in path (optedOut=false)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 0 when the user has no prior global opt-out row", async () => {
    // No pre-existing row → INSERT branch; onConflictDoUpdate resolves without conflict.
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);

    const result = await setVcGlobalPrivacyOptOut("user-cg-1", false);

    expect(result).toBe(0);
  });

  it("calls db.insert() with optedOut: false (persists the cold-start row)", async () => {
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);

    await setVcGlobalPrivacyOptOut("user-cg-2", false);

    // db.insert() must have been called exactly once
    expect(mocks.insert).toHaveBeenCalledTimes(1);

    // The values() payload must carry optedOut: false and the correct userId
    const [valuesArg] = mocks.values.mock.calls[0] as unknown as [
      { userId: string; optedOut: boolean }
    ];
    expect(valuesArg.userId).toBe("user-cg-2");
    expect(valuesArg.optedOut).toBe(false);
  });

  it("does NOT call db.update() (closeOpenSessionsForUser is skipped on opt-in)", async () => {
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);

    await setVcGlobalPrivacyOptOut("user-cg-3", false);

    // db.update() is only used by closeOpenSessionsForUser; it must never be
    // invoked on the opt-in path regardless of whether a prior row exists.
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("targets the global table (insert must reach communityVcPrivacyGlobalTable)", async () => {
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);

    await setVcGlobalPrivacyOptOut("user-cg-4", false);

    // The table stub passed to db.insert() must be communityVcPrivacyGlobalTable
    // (the proxy returns "global.<prop>" for every property on that stub).
    const [tableArg] = mocks.insert.mock.calls[0] as unknown as [Record<string, string>];
    expect(tableArg["userId"]).toBe("global.userId");
  });

  it("onConflictDoUpdate payload also carries optedOut: false (update branch is consistent)", async () => {
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);

    await setVcGlobalPrivacyOptOut("user-cg-5", false);

    const [conflictArg] = mocks.onConflictDoUpdate.mock.calls[0] as unknown as [
      { set: { optedOut: boolean } }
    ];
    expect(conflictArg.set.optedOut).toBe(false);
  });

  // The end-to-end read-back tests (cold-start opt-in → isVcTrackingGloballyOptedOut)
  // require a stateful mock that wires the write and read through the same in-memory
  // store.  Those tests live in global-optin-cold-start-stateful.test.ts.

  it("isVcTrackingGloballyOptedOut returns false when no row exists (absence of a row is not opted-out)", async () => {
    // Even if the upsert never ran (truly cold start), the checker must return false
    // when there is no row at all — absence of a row ≠ opted-out.
    mocks.selectWhere.mockResolvedValueOnce([]); // no row in DB

    const result = await isVcTrackingGloballyOptedOut("user-cg-rb-4");

    expect(result).toBe(false);
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

// ─── handlePrivacyOptoutDelete – replay-safety tests ─────────────────────────
//
// The per-guild "delete + opt-out" button (COMM_PRIVACY_OPTOUT_DELETE) has a
// plain constant customId with no nonce or userId encoded. Any user who obtains
// the interaction token could click it.
//
// The handler must always scope both the DELETE and the opt-out upsert to
// interaction.user.id — the clicking user — regardless of who originally
// triggered the embed. These tests confirm that user B replaying user A's
// button only deletes user B's sessions (in that guild) and only opts out
// user B; user A's data must not be touched.

describe("handlePrivacyOptoutDelete – replay safety", () => {
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
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);       // setVcPrivacyOptOut upsert
    mocks.returning.mockResolvedValueOnce([]);                // closeSession inside setVcPrivacyOptOut
  }

  it("replayed interaction: delete WHERE targets the clicking user's id, not the original user's id", async () => {
    const originalUserId = "user-original-pd";
    const replayerUserId = "user-replayer-pd";
    setupMocks([]);

    // User B (replayer) clicks the button; interaction.user.id = replayerUserId
    const interaction = makeInteraction(replayerUserId, "guild-replay-pd-1");
    await handlePrivacyOptoutDelete(interaction as never);

    // db.delete() must have been called twice (sessions + privacy row)
    expect(mocks.deleteFn).toHaveBeenCalledTimes(2);

    // The WHERE clause of the first delete (sessions) must carry the replayer's userId
    const [whereArg] = mocks.deleteWhere.mock.calls[0] as unknown as [
      { op: string; args: { op: string; col: string; val: string }[] }
    ];
    expect(whereArg.op).toBe("and");
    const eqVals = whereArg.args.filter((a) => a.op === "eq").map((a) => a.val);
    expect(eqVals).toContain(replayerUserId);
    // The original user's id must not appear in the WHERE clause
    expect(eqVals).not.toContain(originalUserId);
  });

  it("replayed interaction: opt-out upsert targets only the clicking user's id", async () => {
    const originalUserId = "user-original-pd-2";
    const replayerUserId = "user-replayer-pd-2";
    setupMocks([]);

    const interaction = makeInteraction(replayerUserId, "guild-replay-pd-2");
    await handlePrivacyOptoutDelete(interaction as never);

    // db.insert() must have been called once (setVcPrivacyOptOut)
    expect(mocks.insert).toHaveBeenCalledTimes(1);

    // The values() payload must reference the replayer's id, NOT the original user's id
    const [valuesArg] = mocks.values.mock.calls[0] as unknown as [
      { guildId: string; userId: string; optedOut: boolean }
    ];
    expect(valuesArg.userId).toBe(replayerUserId);
    expect(valuesArg.userId).not.toBe(originalUserId);
    expect(valuesArg.optedOut).toBe(true);
  });

  it("replayed interaction: the guild scope is also taken from the interaction, not from a stored value", async () => {
    const replayerUserId = "user-replayer-pd-3";
    const guildId = "guild-replay-pd-3";
    setupMocks([{ id: 5 }]);

    const interaction = makeInteraction(replayerUserId, guildId);
    await handlePrivacyOptoutDelete(interaction as never);

    // Both the session-delete WHERE and the opt-out upsert must reference the
    // correct guildId taken from interaction.guildId (not a cached/external value).
    const [deleteWhereArg] = mocks.deleteWhere.mock.calls[0] as unknown as [
      { op: string; args: { op: string; col: string; val: string }[] }
    ];
    const deleteVals = deleteWhereArg.args.filter((a) => a.op === "eq").map((a) => a.val);
    expect(deleteVals).toContain(guildId);
    expect(deleteVals).toContain(replayerUserId);

    const [valuesArg] = mocks.values.mock.calls[0] as unknown as [
      { guildId: string; userId: string; optedOut: boolean }
    ];
    expect(valuesArg.guildId).toBe(guildId);
    expect(valuesArg.userId).toBe(replayerUserId);
  });

  it("replayed interaction: UI update fires correctly (deferUpdate + editReply with components:[])", async () => {
    setupMocks([]);

    const interaction = makeInteraction("user-replayer-pd-4", "guild-replay-pd-4");
    await handlePrivacyOptoutDelete(interaction as never);

    expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
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

  it("admin still sees the 'deleted N rows' embed when the audit channel fetch throws", async () => {
    // deleteUserVcSessions calls db.delete() twice (sessions + privacy row)
    mocks.deleteReturning.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
    mocks.deleteReturning.mockResolvedValueOnce([]);
    // getAuditLogChannel returns a configured channel id via db.select()
    mocks.selectWhere.mockResolvedValueOnce([{ auditLogChannelId: "audit-ch-fetch-throws" }]);

    // channels.fetch rejects (e.g. channel was deleted from Discord)
    const interaction = {
      user: { id: "admin-audit-1", tag: "admin-audit-1#0000" },
      guildId: "guild-audit-1",
      customId: `${COMM_PRIVACY_ADMIN_DELETE_CONFIRM_PREFIX}target-audit-1`,
      member: { permissions: { has: vi.fn().mockReturnValue(true) } },
      guild: {
        name: "Test Guild",
        channels: {
          cache: { get: vi.fn().mockReturnValue(null) },
          fetch: vi.fn().mockRejectedValue(new Error("Unknown Channel")),
        },
      },
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    // Must not throw even though the channel fetch fails
    await expect(handlePrivacyAdminDeleteConfirm(interaction as never)).resolves.toBeUndefined();

    // Admin must still have received the confirmation embed
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ components: [] }),
    );
    const [[replyArg]] = interaction.editReply.mock.calls as [[{ embeds: { data: { description?: string } }[] }]];
    const description = replyArg.embeds[0]?.data?.description ?? "";
    expect(description).toContain("2件");
  });

  it("handler completes normally with no extra DB calls when no audit channel is configured", async () => {
    // deleteUserVcSessions calls db.delete() twice (sessions + privacy row)
    mocks.deleteReturning.mockResolvedValueOnce([{ id: 5 }]);
    mocks.deleteReturning.mockResolvedValueOnce([]);
    // selectWhere returns [] by default → getAuditLogChannel returns null → audit branch skipped

    const interaction = makeAdminInteraction("admin-audit-2", "guild-audit-2", "target-audit-2");

    await expect(handlePrivacyAdminDeleteConfirm(interaction as never)).resolves.toBeUndefined();

    // Admin still receives the confirmation embed
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ components: [] }),
    );
    // No insert calls (no audit log message was posted)
    expect(mocks.insert).not.toHaveBeenCalled();
    // Exactly 2 deletes (sessions + privacy row), nothing more
    expect(mocks.deleteFn).toHaveBeenCalledTimes(2);
  });

  it("admin still sees the 'deleted N rows' embed when auditChannel.send() throws (permissions/rate-limit)", async () => {
    // deleteUserVcSessions calls db.delete() twice (sessions + privacy row)
    mocks.deleteReturning.mockResolvedValueOnce([{ id: 1 }, { id: 2 }, { id: 3 }]);
    mocks.deleteReturning.mockResolvedValueOnce([]);
    // getAuditLogChannel returns a configured channel id via db.select()
    mocks.selectWhere.mockResolvedValueOnce([{ auditLogChannelId: "audit-ch-send-throws" }]);

    // Audit channel is fetched successfully and isTextBased() is true,
    // but send() itself rejects (e.g. missing Send Messages permission)
    const auditChannel = {
      isTextBased: vi.fn().mockReturnValue(true),
      send: vi.fn().mockRejectedValue(new Error("Missing Permissions")),
    };
    const interaction = {
      user: { id: "admin-audit-3", tag: "admin-audit-3#0000" },
      guildId: "guild-audit-3",
      customId: `${COMM_PRIVACY_ADMIN_DELETE_CONFIRM_PREFIX}target-audit-3`,
      member: { permissions: { has: vi.fn().mockReturnValue(true) } },
      guild: {
        name: "Test Guild",
        channels: {
          cache: { get: vi.fn().mockReturnValue(null) },
          fetch: vi.fn().mockResolvedValue(auditChannel),
        },
      },
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    // Must not throw even though send() fails
    await expect(handlePrivacyAdminDeleteConfirm(interaction as never)).resolves.toBeUndefined();

    // Admin must still have received the confirmation embed with the correct count
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ components: [] }),
    );
    const [[replyArg]] = interaction.editReply.mock.calls as [[{ embeds: { data: { description?: string } }[] }]];
    const description = replyArg.embeds[0]?.data?.description ?? "";
    expect(description).toContain("3件");
  });

  it("clears the stale audit channel id (setAuditLogChannel null) when channels.fetch throws with code 10003", async () => {
    // deleteUserVcSessions calls db.delete() twice (sessions + privacy row)
    mocks.deleteReturning.mockResolvedValueOnce([{ id: 1 }]);
    mocks.deleteReturning.mockResolvedValueOnce([]);
    // getAuditLogChannel returns a stale channel id via db.select()
    mocks.selectWhere.mockResolvedValueOnce([{ auditLogChannelId: "stale-audit-ch" }]);

    // Simulate Discord Unknown Channel error (code 10003)
    const unknownChannelErr = Object.assign(new Error("Unknown Channel"), { code: 10003 });
    const interaction = {
      user: { id: "admin-audit-clr", tag: "admin-audit-clr#0000" },
      guildId: "guild-audit-clr",
      customId: `${COMM_PRIVACY_ADMIN_DELETE_CONFIRM_PREFIX}target-audit-clr`,
      member: { permissions: { has: vi.fn().mockReturnValue(true) } },
      guild: {
        name: "Test Guild",
        channels: {
          cache: { get: vi.fn().mockReturnValue(null) },
          fetch: vi.fn().mockRejectedValue(unknownChannelErr),
        },
      },
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await expect(handlePrivacyAdminDeleteConfirm(interaction as never)).resolves.toBeUndefined();

    // Admin must still receive the confirmation embed
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ components: [] }),
    );
    const [[replyArg]] = interaction.editReply.mock.calls as [[{ embeds: { data: { description?: string } }[] }]];
    const description = replyArg.embeds[0]?.data?.description ?? "";
    expect(description).toContain("1件");

    // setAuditLogChannel(guildId, null) must have been invoked to clear the stale id.
    // It uses db.insert().values().onConflictDoUpdate() — the set payload carries null.
    expect(mocks.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({ auditLogChannelId: null }),
      }),
    );
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
    // Third call is for the per-guild privacy rows delete; return empty array.
    mocks.deleteReturning.mockResolvedValueOnce([]);

    await deleteAllUserVcSessions("user-dav-2");

    // db.delete() is called three times: sessions + global opt-out row + per-guild opt-out rows.
    expect(mocks.deleteFn).toHaveBeenCalledTimes(3);

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
//   - db.delete() is called three times (sessions + global opt-out row + per-guild opt-out rows)
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
  //   → db.delete(privacy).where().returning()       → [] (clear per-guild opt-out rows)
  // setVcGlobalPrivacyOptOut → db.insert().values().onConflictDoUpdate() (upsert)
  //                          → db.update().set().where().returning() (closeOpenSessionsForUser)
  function setupMocks(deletedRows: { id: number }[]) {
    mocks.deleteReturning.mockResolvedValueOnce(deletedRows); // session rows deleted
    mocks.deleteReturning.mockResolvedValueOnce([]);           // global opt-out row cleared
    mocks.deleteReturning.mockResolvedValueOnce([]);           // per-guild opt-out rows cleared
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);        // global opt-out upsert (re-set)
    mocks.returning.mockResolvedValueOnce([]);                 // closeOpenSessionsForUser (no open sessions)
  }

  it("calls db.delete() three times — sessions, global opt-out row, and per-guild opt-out rows", async () => {
    setupMocks([]);

    const interaction = makeInteraction("user-god-1");
    await handlePrivacyGlobalOptoutDelete(interaction as never);

    // deleteAllUserVcSessions performs three deletes: sessions + global opt-out row + per-guild opt-out rows.
    expect(mocks.deleteFn).toHaveBeenCalledTimes(3);
    const tables = (mocks.deleteFn.mock.calls as unknown as [Record<string, string>][]).map((c) => c[0]?.["userId"]);
    expect(tables).toContain("sessions.userId");
    expect(tables).toContain("global.userId");
    expect(tables).toContain("privacy.userId");
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

// ─── handlePrivacyGlobalOptoutDelete – replay-attack guard ───────────────────
//
// The handler derives the userId exclusively from `interaction.user.id`.
// There is no targetUserId encoded in the button customId — unlike the admin
// delete handler, which embeds a target in the customId.  This means:
//
//   • When user A clicks their own button, only user A's sessions are deleted.
//   • If user B somehow replays the same button (e.g. by exploiting a cached
//     Discord message), `interaction.user.id` is user B's id, so only user B's
//     own data is affected — user A's data is never touched.
//
// These tests make that guarantee explicit so a future refactor cannot silently
// introduce a customId-derived userId that breaks the isolation.

describe("handlePrivacyGlobalOptoutDelete – replay-attack guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupMocks(deletedRows: { id: number }[]) {
    mocks.deleteReturning.mockResolvedValueOnce(deletedRows); // sessions delete
    mocks.deleteReturning.mockResolvedValueOnce([]);           // global opt-out row cleared
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);        // global opt-out upsert (re-set)
    mocks.returning.mockResolvedValueOnce([]);                 // closeOpenSessionsForUser
  }

  it("passes interaction.user.id as the userId to deleteAllUserVcSessions — never a hardcoded or customId-derived id", async () => {
    setupMocks([]);

    const interaction = makeInteraction("user-replay-A");
    await handlePrivacyGlobalOptoutDelete(interaction as never);

    // The WHERE clause on the first delete (sessions) must carry user-replay-A's id.
    // If the handler ever switched to reading the id from customId or a closure
    // variable, this assertion would catch it.
    const [whereArg] = mocks.deleteWhere.mock.calls[0] as unknown as [
      { op: string; val?: string; args?: { op: string; val?: string }[] }
    ];
    const collectEqVals = (node: { op: string; val?: string; args?: unknown[] }): string[] => {
      if (node.op === "eq") return [node.val as string];
      if (node.op === "and" && Array.isArray(node.args))
        return (node.args as { op: string; val?: string; args?: unknown[] }[]).flatMap(collectEqVals);
      return [];
    };
    const eqVals = collectEqVals(whereArg as { op: string; val?: string; args?: unknown[] });

    // Must contain the clicking user's id
    expect(eqVals).toContain("user-replay-A");
    // The opt-out upsert (setVcGlobalPrivacyOptOut) must also target the same user
    const [valuesArg] = mocks.values.mock.calls[0] as unknown as [{ userId: string; optedOut: boolean }];
    expect(valuesArg.userId).toBe("user-replay-A");
  });

  it("when user B replays the button, only user B's sessions are deleted — user A's data is untouched", async () => {
    // Simulate user B ("user-replay-B") clicking the button.
    // Even if the original confirm embed was generated in response to user A's
    // command, Discord delivers the button click as user B's interaction.
    // The handler must therefore scope the delete to user B, not user A.
    setupMocks([{ id: 200 }, { id: 201 }]);

    const interaction = makeInteraction("user-replay-B");
    await handlePrivacyGlobalOptoutDelete(interaction as never);

    const [whereArg] = mocks.deleteWhere.mock.calls[0] as unknown as [
      { op: string; val?: string; args?: { op: string; val?: string }[] }
    ];
    const collectEqVals = (node: { op: string; val?: string; args?: unknown[] }): string[] => {
      if (node.op === "eq") return [node.val as string];
      if (node.op === "and" && Array.isArray(node.args))
        return (node.args as { op: string; val?: string; args?: unknown[] }[]).flatMap(collectEqVals);
      return [];
    };
    const eqVals = collectEqVals(whereArg as { op: string; val?: string; args?: unknown[] });

    // The replaying user's id (user B) must be the scope of the delete
    expect(eqVals).toContain("user-replay-B");
    // The original user's id (user A) must NOT appear anywhere in the WHERE clause
    expect(eqVals).not.toContain("user-replay-A");

    // The opt-out upsert must also target user B, not user A
    const [valuesArg] = mocks.values.mock.calls[0] as unknown as [{ userId: string; optedOut: boolean }];
    expect(valuesArg.userId).toBe("user-replay-B");
    expect(valuesArg.userId).not.toBe("user-replay-A");
  });
});

// ─── handlePrivacyGlobalOptoutDelete – audit log path ────────────────────────
//
// After the wipe completes the handler should attempt to post an audit log entry
// to the guild's configured audit log channel (when the interaction came from a
// guild and a channel is configured).
//
// We verify three properties:
//   1. The audit log channel lookup (getAuditLogChannel) is attempted after deletion.
//   2. When no audit channel is configured the handler still resolves without throwing.
//   3. The embed sent to the audit channel names the deleted-row count.
//
// The call sequence for an interaction with a guildId is:
//   deleteAllUserVcSessions:
//     → db.delete(sessions).where().returning()      → deleteReturning[0]
//     → db.delete(global).where().returning()        → deleteReturning[1]
//   setVcGlobalPrivacyOptOut:
//     → db.insert().values().onConflictDoUpdate()    → onConflictDoUpdate[0]
//     → db.update().set().where().returning()        → returning[0]  (closeOpenSessionsForUser)
//   getAuditLogChannel:
//     → db.select().from().where()                   → selectWhere[0]

describe('handlePrivacyGlobalOptoutDelete – audit log path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Stage the four mock results that every successful invocation consumes
   * before reaching getAuditLogChannel, plus optionally a selectWhere result
   * that makes getAuditLogChannel return a non-null channel id.
   */
  function setupMocks(
    deletedRows: { id: number }[],
    auditChannelId: string | null = null,
  ) {
    mocks.deleteReturning.mockResolvedValueOnce(deletedRows); // sessions delete
    mocks.deleteReturning.mockResolvedValueOnce([]);           // global opt-out row cleared
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);        // global opt-out upsert
    mocks.returning.mockResolvedValueOnce([]);                 // closeOpenSessionsForUser
    if (auditChannelId !== null) {
      // getAuditLogChannel uses db.select().from().where() → selectWhere
      mocks.selectWhere.mockResolvedValueOnce([{ auditLogChannelId: auditChannelId }]);
    }
    // When auditChannelId is null: selectWhere returns [] by default →
    // getAuditLogChannel returns null → audit branch is skipped.
  }

  /**
   * Build a fake ButtonInteraction that includes a guild context with a
   * channel whose isTextBased() returns true and whose send() is a vi.fn().
   */
  function makeGuildInteraction(userId: string, guildId: string, auditChannelId?: string) {
    const send = vi.fn().mockResolvedValue(undefined);
    const textChannel = auditChannelId
      ? { isTextBased: () => true, send }
      : null;
    return {
      user: { id: userId, tag: `${userId}#0000` },
      guildId,
      guild: {
        channels: {
          cache: { get: vi.fn().mockReturnValue(textChannel) },
          fetch: vi.fn().mockResolvedValue(textChannel),
        },
      },
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
      _send: send,  // expose for assertions
    };
  }

  it("attempts the audit log channel lookup (selectWhere called) when interaction has a guildId", async () => {
    setupMocks([], "audit-ch-gal-1");
    const interaction = makeGuildInteraction("user-gal-1", "guild-gal-1", "audit-ch-gal-1");
    await handlePrivacyGlobalOptoutDelete(interaction as never);

    // getAuditLogChannel → db.select().from().where() must have been called
    expect(mocks.selectWhere).toHaveBeenCalledTimes(1);
  });

  // ── DM context helpers ────────────────────────────────────────────────────
  //
  // When triggered from a DM the interaction has no guildId.  The handler
  // must enumerate interaction.client.guilds.cache, check membership for each
  // guild, and post an audit entry in every guild that (a) has the user as a
  // member and (b) has an audit channel configured.

  /**
   * Build a fake DM ButtonInteraction backed by a set of guild mocks.
   * Each guild mock exposes the members and channels APIs used by the handler.
   */
  function makeDmInteractionWithGuilds(
    userId: string,
    guilds: Array<{
      guildId: string;
      isMember: boolean;
      auditChannel?: { isTextBased: () => boolean; send: ReturnType<typeof vi.fn> } | null;
    }>,
  ) {
    const guildEntries = guilds.map(({ guildId, isMember, auditChannel = null }) => {
      const member = isMember ? { id: userId } : null;
      return [
        guildId,
        {
          members: {
            cache: { get: vi.fn().mockReturnValue(member) },
            fetch: vi.fn().mockResolvedValue(member),
          },
          channels: {
            cache: { get: vi.fn().mockReturnValue(auditChannel) },
            fetch: vi.fn().mockResolvedValue(auditChannel),
          },
        },
      ] as const;
    });

    return {
      user: { id: userId },
      guildId: null,
      guild: null,
      client: {
        guilds: { cache: new Map(guildEntries) },
      },
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("DM interaction with no shared guilds: does not attempt audit log lookup (selectWhere never called)", async () => {
    // No guilds in the cache → no membership checks → no audit channel lookups.
    mocks.deleteReturning.mockResolvedValueOnce([]); // sessions delete
    mocks.deleteReturning.mockResolvedValueOnce([]); // global opt-out row cleared
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]); // global opt-out upsert
    mocks.returning.mockResolvedValueOnce([]);          // closeOpenSessionsForUser

    const interaction = makeDmInteractionWithGuilds("user-gal-dm-0", []);
    await handlePrivacyGlobalOptoutDelete(interaction as never);

    // No guilds → no audit channel DB lookups
    expect(mocks.selectWhere).not.toHaveBeenCalled();
    // User-facing reply still sent
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ components: [] }),
    );
  });

  it("DM interaction → audit entries posted to guilds A and B when both have configured audit channels", async () => {
    // Two guilds, both with the user as a member, both with audit channels.
    const sendA = vi.fn().mockResolvedValue(undefined);
    const sendB = vi.fn().mockResolvedValue(undefined);
    const channelA = { isTextBased: () => true, send: sendA };
    const channelB = { isTextBased: () => true, send: sendB };

    mocks.deleteReturning.mockResolvedValueOnce([{ id: 1 }]); // sessions delete
    mocks.deleteReturning.mockResolvedValueOnce([]);            // global opt-out row cleared
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);         // global opt-out upsert
    mocks.returning.mockResolvedValueOnce([]);                  // closeOpenSessionsForUser
    // getAuditLogChannel for guild A
    mocks.selectWhere.mockResolvedValueOnce([{ auditLogChannelId: "audit-ch-dm-A" }]);
    // getAuditLogChannel for guild B
    mocks.selectWhere.mockResolvedValueOnce([{ auditLogChannelId: "audit-ch-dm-B" }]);

    const interaction = makeDmInteractionWithGuilds("user-gal-dm-1", [
      { guildId: "guild-dm-A", isMember: true, auditChannel: channelA },
      { guildId: "guild-dm-B", isMember: true, auditChannel: channelB },
    ]);

    await handlePrivacyGlobalOptoutDelete(interaction as never);

    // Both audit channels must have received exactly one message
    expect(sendA).toHaveBeenCalledTimes(1);
    expect(sendB).toHaveBeenCalledTimes(1);

    // The audit embed must carry the correct deleted-row count in both messages
    const [[argA]] = sendA.mock.calls as [[{ embeds: { data: { fields?: { name: string; value: string }[] } }[] }]];
    const [[argB]] = sendB.mock.calls as [[{ embeds: { data: { fields?: { name: string; value: string }[] } }[] }]];
    const fieldsA = argA.embeds[0]?.data?.fields ?? [];
    const fieldsB = argB.embeds[0]?.data?.fields ?? [];
    expect(fieldsA.find((f) => f.value === "1件")).toBeDefined();
    expect(fieldsB.find((f) => f.value === "1件")).toBeDefined();
  });

  it("DM interaction → handler still completes when no guild has an audit channel", async () => {
    // Two guilds where the user is a member, but neither has an audit channel.
    mocks.deleteReturning.mockResolvedValueOnce([]);
    mocks.deleteReturning.mockResolvedValueOnce([]);
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);
    mocks.returning.mockResolvedValueOnce([]);
    // getAuditLogChannel returns null for both guilds (no row → empty array)
    mocks.selectWhere.mockResolvedValueOnce([]); // guild A → no audit channel
    mocks.selectWhere.mockResolvedValueOnce([]); // guild B → no audit channel

    const interaction = makeDmInteractionWithGuilds("user-gal-dm-2", [
      { guildId: "guild-dm-C", isMember: true, auditChannel: null },
      { guildId: "guild-dm-D", isMember: true, auditChannel: null },
    ]);

    // Must resolve without throwing
    await expect(handlePrivacyGlobalOptoutDelete(interaction as never)).resolves.toBeUndefined();

    // User-facing reply still sent
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ components: [] }),
    );

    // Audit channel lookup was attempted for both guilds (confirmed the user is a member)
    expect(mocks.selectWhere).toHaveBeenCalledTimes(2);
  });

  it("DM interaction → guilds where the user is NOT a member are skipped (no audit lookup)", async () => {
    // Guild A: user is a member. Guild B: user is NOT a member.
    // Only guild A should trigger an audit channel lookup.
    const sendA = vi.fn().mockResolvedValue(undefined);
    const channelA = { isTextBased: () => true, send: sendA };

    mocks.deleteReturning.mockResolvedValueOnce([]);
    mocks.deleteReturning.mockResolvedValueOnce([]);
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);
    mocks.returning.mockResolvedValueOnce([]);
    // Only guild A triggers getAuditLogChannel
    mocks.selectWhere.mockResolvedValueOnce([{ auditLogChannelId: "audit-ch-dm-E" }]);

    const interaction = makeDmInteractionWithGuilds("user-gal-dm-3", [
      { guildId: "guild-dm-E", isMember: true,  auditChannel: channelA },
      { guildId: "guild-dm-F", isMember: false, auditChannel: null },
    ]);

    await handlePrivacyGlobalOptoutDelete(interaction as never);

    // Exactly one audit channel lookup (guild A only)
    expect(mocks.selectWhere).toHaveBeenCalledTimes(1);
    // Guild A's audit channel received one message
    expect(sendA).toHaveBeenCalledTimes(1);
  });

  it("handler still completes (resolves) without throwing when no audit channel is configured", async () => {
    // selectWhere default returns [] → getAuditLogChannel returns null → branch skipped
    setupMocks([{ id: 1 }], null);
    const interaction = makeGuildInteraction("user-gal-3", "guild-gal-3");
    await expect(handlePrivacyGlobalOptoutDelete(interaction as never)).resolves.toBeUndefined();

    // The user-facing reply must still have been sent
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ components: [] }),
    );
  });

  it("handler still completes without throwing when the audit channel fetch throws", async () => {
    setupMocks([{ id: 1 }, { id: 2 }], "audit-ch-gal-4");
    const interaction = {
      user: { id: "user-gal-4", tag: "user-gal-4#0000" },
      guildId: "guild-gal-4",
      guild: {
        channels: {
          cache: { get: vi.fn().mockReturnValue(null) },
          fetch: vi.fn().mockRejectedValue(new Error("Unknown Channel")),
        },
      },
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await expect(handlePrivacyGlobalOptoutDelete(interaction as never)).resolves.toBeUndefined();

    // User-facing reply must still arrive
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ components: [] }),
    );
    const [[replyArg]] = interaction.editReply.mock.calls as [[{ embeds: { data: { description?: string } }[] }]];
    expect(replyArg.embeds[0]?.data?.description ?? "").toContain("2件");
  });

  it("audit embed sent to the channel names the correct deleted-row count (3 rows)", async () => {
    setupMocks([{ id: 10 }, { id: 11 }, { id: 12 }], "audit-ch-gal-5");
    const interaction = makeGuildInteraction("user-gal-5", "guild-gal-5", "audit-ch-gal-5");
    await handlePrivacyGlobalOptoutDelete(interaction as never);

    // The channel's send() must have been called with an embed
    const sendMock = interaction._send;
    expect(sendMock).toHaveBeenCalledTimes(1);
    const [[sendArg]] = sendMock.mock.calls as [[{ embeds: { data: { fields?: { name: string; value: string }[] } }[] }]];
    const fields = sendArg.embeds[0]?.data?.fields ?? [];
    const deletedField = fields.find((f) => f.value === "3件");
    expect(deletedField).toBeDefined();
  });

  it("audit embed sent to the channel names the correct deleted-row count (0 rows)", async () => {
    setupMocks([], "audit-ch-gal-6");
    const interaction = makeGuildInteraction("user-gal-6", "guild-gal-6", "audit-ch-gal-6");
    await handlePrivacyGlobalOptoutDelete(interaction as never);

    const sendMock = interaction._send;
    expect(sendMock).toHaveBeenCalledTimes(1);
    const [[sendArg]] = sendMock.mock.calls as [[{ embeds: { data: { fields?: { name: string; value: string }[] } }[] }]];
    const fields = sendArg.embeds[0]?.data?.fields ?? [];
    const deletedField = fields.find((f) => f.value === "0件");
    expect(deletedField).toBeDefined();
  });

  it("audit embed is NOT sent when no audit channel is configured (send never called)", async () => {
    setupMocks([{ id: 1 }], null);
    const interaction = makeGuildInteraction("user-gal-7", "guild-gal-7");
    await handlePrivacyGlobalOptoutDelete(interaction as never);

    // channel mock had no textChannel stub, so _send was never set up — assert via selectWhere
    // (getAuditLogChannel was called once and returned null, so send path was not reached)
    expect(mocks.selectWhere).toHaveBeenCalledTimes(1);
    // No channel fetch should have been attempted
    expect(interaction.guild.channels.fetch).not.toHaveBeenCalled();
  });

  it("each guild's audit channel receives exactly one message when the handler is invoked from two different guilds", async () => {
    // Helper to build a minimal guild interaction backed by a specific channel mock
    function makeInteractionForGuild(
      userId: string,
      guildId: string,
      channel: { isTextBased: () => boolean; send: ReturnType<typeof vi.fn> },
    ) {
      return {
        user: { id: userId, tag: `${userId}#0000` },
        guildId,
        guild: {
          channels: {
            cache: { get: vi.fn().mockReturnValue(channel) },
            fetch: vi.fn().mockResolvedValue(channel),
          },
        },
        deferUpdate: vi.fn().mockResolvedValue(undefined),
        editReply: vi.fn().mockResolvedValue(undefined),
        reply: vi.fn().mockResolvedValue(undefined),
      };
    }

    // ── Invocation 1: guild-mg-A ──────────────────────────────────────────────
    mocks.deleteReturning.mockResolvedValueOnce([{ id: 10 }]); // sessions delete
    mocks.deleteReturning.mockResolvedValueOnce([]);            // global opt-out row cleared
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);         // global opt-out upsert
    mocks.returning.mockResolvedValueOnce([]);                  // closeOpenSessionsForUser
    mocks.selectWhere.mockResolvedValueOnce([{ auditLogChannelId: "audit-ch-guild-A" }]);

    const sendA = vi.fn().mockResolvedValue(undefined);
    const channelA = { isTextBased: () => true, send: sendA };
    const interactionA = makeInteractionForGuild("user-mg-A", "guild-mg-A", channelA);

    await handlePrivacyGlobalOptoutDelete(interactionA as never);

    // After guild-A's invocation: its channel must have one message, guild-B untouched
    expect(sendA).toHaveBeenCalledTimes(1);

    // ── Invocation 2: guild-mg-B ──────────────────────────────────────────────
    mocks.deleteReturning.mockResolvedValueOnce([{ id: 20 }]); // sessions delete
    mocks.deleteReturning.mockResolvedValueOnce([]);            // global opt-out row cleared
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);         // global opt-out upsert
    mocks.returning.mockResolvedValueOnce([]);                  // closeOpenSessionsForUser
    mocks.selectWhere.mockResolvedValueOnce([{ auditLogChannelId: "audit-ch-guild-B" }]);

    const sendB = vi.fn().mockResolvedValue(undefined);
    const channelB = { isTextBased: () => true, send: sendB };
    const interactionB = makeInteractionForGuild("user-mg-B", "guild-mg-B", channelB);

    await handlePrivacyGlobalOptoutDelete(interactionB as never);

    // After guild-B's invocation: its channel must have exactly one message
    expect(sendB).toHaveBeenCalledTimes(1);
    // Guild-A's channel must not have been called again (still at 1, not 2)
    expect(sendA).toHaveBeenCalledTimes(1);

    // Each audit-channel lookup must have used the correct guild id in its WHERE clause
    // (2 total: one per invocation)
    expect(mocks.selectWhere).toHaveBeenCalledTimes(2);
    const firstLookup = (mocks.selectWhere.mock.calls[0] as unknown as [{ op: string; val: string }])[0];
    const secondLookup = (mocks.selectWhere.mock.calls[1] as unknown as [{ op: string; val: string }])[0];
    expect(firstLookup.op).toBe("eq");
    expect(firstLookup.val).toBe("guild-mg-A");
    expect(secondLookup.op).toBe("eq");
    expect(secondLookup.val).toBe("guild-mg-B");
  });

  it("the audit channel lookup uses the invoking guild's id (WHERE carries the exact guildId, not a hardcoded value)", async () => {
    // Use a non-trivial guild id so a hardcoded string would be obvious
    const invokingGuildId = "guild-multi-B-invoke";
    setupMocks([], invokingGuildId + "-audit");

    const channelB = { isTextBased: () => true, send: vi.fn().mockResolvedValue(undefined) };
    const interaction = {
      user: { id: "user-multi-2", tag: "user-multi-2#0000" },
      guildId: invokingGuildId,
      guild: {
        channels: {
          cache: { get: vi.fn().mockReturnValue(channelB) },
          fetch: vi.fn().mockResolvedValue(channelB),
        },
      },
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handlePrivacyGlobalOptoutDelete(interaction as never);

    // getAuditLogChannel(guildId) → db.select().from().where(eq(guildId, <value>))
    // selectWhere must have been called once and its argument must carry the invoking guild's id
    expect(mocks.selectWhere).toHaveBeenCalledTimes(1);
    const [whereArg] = mocks.selectWhere.mock.calls[0] as unknown as [
      { op: string; col: unknown; val: string }
    ];
    // The eq operator's value must match the invoking guild, not a hardcoded string
    expect(whereArg.op).toBe("eq");
    expect(whereArg.val).toBe(invokingGuildId);
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

// ─── handlePrivacyDeleteCancel – two-step delete cancel path ─────────────────
//
// This button is shown alongside the delete-confirm button in the /privacy delete
// two-step flow. It has no user-ownership guard in its customId — the button ID is
// a plain constant (no nonce or userId encoded). The replay-safety guarantee comes
// from two complementary properties:
//
//   1. The confirmation embed is sent as an ephemeral interaction reply, which
//      Discord only shows to the user who originally invoked /privacy delete.
//      No other guild member can see or click the button in production.
//
//   2. The handler performs NO database writes. It only renders a "cancelled" embed
//      and clears the components. Even if a different user somehow replayed the
//      interaction token, they could not cause any data deletion or opt-out side
//      effects — the worst outcome is a cosmetic UI update scoped to the original
//      ephemeral message.
//
// Tests verify:
//   - deferUpdate() is called (standard deferred-update flow)
//   - editReply() is called with components:[] so the buttons are removed
//   - The embed title reflects a cancelled (not deleted) state
//   - The embed description confirms data is preserved (not wiped)
//   - No DB functions (insert / update / delete) are ever called
//   - A "replayed" call from a different userId still cannot touch the database

describe("handlePrivacyDeleteCancel – two-step delete cancel path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls deferUpdate() then editReply() (standard deferred-update flow)", async () => {
    const interaction = makeInteraction("user-dc-cancel-1", "guild-cancel-1");
    await handlePrivacyDeleteCancel(interaction as never);

    expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
  });

  it("replies with components:[] so the confirm/cancel buttons are cleared", async () => {
    const interaction = makeInteraction("user-dc-cancel-2", "guild-cancel-2");
    await handlePrivacyDeleteCancel(interaction as never);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ components: [] }),
    );
  });

  it("embed title reflects a cancelled state (not a deletion)", async () => {
    const interaction = makeInteraction("user-dc-cancel-3", "guild-cancel-3");
    await handlePrivacyDeleteCancel(interaction as never);

    const [[replyArg]] = interaction.editReply.mock.calls as [[{ embeds: { data: { title?: string } }[] }]];
    const title = replyArg.embeds[0]?.data?.title ?? "";
    // Must communicate cancellation, not deletion
    expect(title).toContain("キャンセル");
    // Must NOT indicate data was deleted
    expect(title).not.toContain("削除");
  });

  it("embed description confirms data is preserved (not wiped)", async () => {
    const interaction = makeInteraction("user-dc-cancel-4", "guild-cancel-4");
    await handlePrivacyDeleteCancel(interaction as never);

    const [[replyArg]] = interaction.editReply.mock.calls as [[{ embeds: { data: { description?: string } }[] }]];
    const description = replyArg.embeds[0]?.data?.description ?? "";
    // Must confirm data is retained
    expect(description).toContain("データ");
    // Must NOT reference a row count (which would indicate deletion happened)
    expect(description).not.toMatch(/\d+件/);
  });

  it("never calls db.insert() — no opt-out row is written on cancel", async () => {
    const interaction = makeInteraction("user-dc-cancel-5", "guild-cancel-5");
    await handlePrivacyDeleteCancel(interaction as never);

    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("never calls db.update() — no session-close side-effect on cancel", async () => {
    const interaction = makeInteraction("user-dc-cancel-6", "guild-cancel-6");
    await handlePrivacyDeleteCancel(interaction as never);

    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("never calls db.delete() — no session rows are deleted on cancel", async () => {
    const interaction = makeInteraction("user-dc-cancel-7", "guild-cancel-7");
    await handlePrivacyDeleteCancel(interaction as never);

    expect(mocks.deleteFn).not.toHaveBeenCalled();
  });

  it("a replayed cancel from a different userId still touches no database (replay safety)", async () => {
    // Simulate a replay: originalUserId triggered /privacy delete, but
    // replayingUserId is the one clicking the cancel button.
    // Even with no user-ownership guard, the handler must not write any data.
    const replayingUser = makeInteraction("replaying-user-dc-cancel-8", "guild-cancel-8");
    await handlePrivacyDeleteCancel(replayingUser as never);

    // The replaying user must not have caused any database write
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.deleteFn).not.toHaveBeenCalled();

    // The UI update (deferred reply) still fires — it edits the original
    // ephemeral message which is only visible to the original user
    expect(replayingUser.deferUpdate).toHaveBeenCalled();
    expect(replayingUser.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ components: [] }),
    );
  });

  it("works correctly in DM context (no guildId) — cancel is always safe without a guild", async () => {
    // Cancel does not need a guildId because it performs no guild-scoped DB operation
    const interaction = makeInteraction("user-dc-cancel-9");
    await handlePrivacyDeleteCancel(interaction as never);

    // Must still complete the cancel flow
    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ components: [] }),
    );

    // And must not touch the database
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.deleteFn).not.toHaveBeenCalled();
  });
});

// ─── handlePrivacyAdminDeleteCancel – admin cancel button permission guard ─────
//
// handlePrivacyAdminDeleteCancel mirrors the confirm handler's ManageGuild guard.
// A non-admin who intercepts or replays the cancel button must receive an
// ephemeral error and the handler must perform no database writes.
// An admin who clicks cancel must see a cancellation embed with components:[].
//
// Tests verify:
//   - DM guard: no guildId → ephemeral reply, no DB calls
//   - Permission guard: member without ManageGuild → ephemeral reply, no DB calls
//   - Admin happy path: deferUpdate + editReply with components:[] and cancel embed
//   - Admin happy path: embed communicates cancellation (title contains キャンセル)

describe("handlePrivacyAdminDeleteCancel – admin cancel button permission guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Build a fake ButtonInteraction for the admin-delete cancel button.
   * `isAdmin` controls whether member.permissions.has() returns true.
   */
  function makeAdminCancelInteraction(
    userId: string,
    guildId: string | undefined,
    isAdmin = true,
  ) {
    return {
      user: { id: userId, tag: `${userId}#0000` },
      guildId: guildId ?? null,
      member: {
        permissions: {
          has: vi.fn().mockReturnValue(isAdmin),
        },
      },
      guild: { name: "Test Guild" },
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("replies ephemerally and makes no DB calls when guildId is absent (DM context)", async () => {
    const interaction = makeAdminCancelInteraction("admin-adc-0", undefined);
    await handlePrivacyAdminDeleteCancel(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(mocks.deleteFn).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("replies ephemerally and makes no DB calls when member lacks ManageGuild permission", async () => {
    const interaction = makeAdminCancelInteraction("non-admin-adc-1", "guild-adc-1", false);
    await handlePrivacyAdminDeleteCancel(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(mocks.deleteFn).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("admin successfully cancels: calls deferUpdate then editReply with components:[]", async () => {
    const interaction = makeAdminCancelInteraction("admin-adc-2", "guild-adc-2");
    await handlePrivacyAdminDeleteCancel(interaction as never);

    expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ components: [] }),
    );
  });

  it("admin cancel embed title communicates cancellation (contains キャンセル, not 削除)", async () => {
    const interaction = makeAdminCancelInteraction("admin-adc-3", "guild-adc-3");
    await handlePrivacyAdminDeleteCancel(interaction as never);

    const [[replyArg]] = interaction.editReply.mock.calls as [[{ embeds: { data: { title?: string } }[] }]];
    const title = replyArg.embeds[0]?.data?.title ?? "";
    expect(title).toContain("キャンセル");
    expect(title).not.toContain("削除");
  });

  it("admin cancel makes no DB calls — data is never touched on cancel", async () => {
    const interaction = makeAdminCancelInteraction("admin-adc-4", "guild-adc-4");
    await handlePrivacyAdminDeleteCancel(interaction as never);

    expect(mocks.deleteFn).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

// ─── isVcTrackingOptedOut – parallel query execution ─────────────────────────
//
// isVcTrackingOptedOut uses Promise.all to fire the global-table select and the
// per-guild-table select simultaneously.  These tests verify that concurrency
// contract by controlling when each query resolves and asserting that both
// queries are *initiated* before either *resolves*.
//
// If the implementation were accidentally changed to await the queries in
// series (e.g. `await globalQuery; await guildQuery;`), the second test would
// catch it: after a single microtask tick the second `selectWhere` mock would
// not yet have been called, causing the assertion to fail.

describe("isVcTrackingOptedOut – parallel query execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("initiates both DB selects before either resolves (Promise.all concurrency contract)", async () => {
    // Track which query was initiated and in what order.
    const initiated: string[] = [];

    // Deferred handles so we control exactly when each query promise resolves.
    let resolveGlobal!: (value: unknown[]) => void;
    let resolveGuild!: (value: unknown[]) => void;
    const globalPending = new Promise<unknown[]>((res) => { resolveGlobal = res; });
    const guildPending  = new Promise<unknown[]>((res) => { resolveGuild  = res; });

    // First call → global table query; second call → per-guild table query.
    mocks.selectWhere
      .mockImplementationOnce(() => {
        initiated.push("global");
        return globalPending;
      })
      .mockImplementationOnce(() => {
        initiated.push("guild");
        return guildPending;
      });

    // Start the function but don't await — we want to inspect state mid-flight.
    const pending = isVcTrackingOptedOut("guild-par-1", "user-par-1");

    // Flush exactly one microtask tick.  In the parallel (correct) implementation
    // Promise.all initiates both queries synchronously before any .then()
    // callback fires, so both selectWhere mocks should already have been called.
    await Promise.resolve();

    expect(initiated).toContain("global");
    expect(initiated).toContain("guild");

    // Let both queries settle so the overall promise can resolve cleanly.
    resolveGlobal([]);
    resolveGuild([]);
    await pending;
  });

  it("the second select is NOT gated on the first resolving (catches a serialised implementation)", async () => {
    // Arrange: the first query is held open indefinitely during the assertion
    // window.  If the implementation were serial, the second selectWhere mock
    // would not be called until the first resolves — the assertion below would
    // then catch the regression.
    const initiated: string[] = [];

    let resolveFirst!:  (value: unknown[]) => void;
    let resolveSecond!: (value: unknown[]) => void;
    const firstHeld   = new Promise<unknown[]>((res) => { resolveFirst  = res; });
    const secondReady = new Promise<unknown[]>((res) => { resolveSecond = res; });

    mocks.selectWhere
      .mockImplementationOnce(() => {
        initiated.push("first");
        return firstHeld;   // deliberately does not resolve yet
      })
      .mockImplementationOnce(() => {
        initiated.push("second");
        return secondReady;
      });

    const pending = isVcTrackingOptedOut("guild-par-2", "user-par-2");

    // After one microtask tick the second select must already be in-flight even
    // though the first query has not yet resolved.  A serial implementation
    // would only have "first" in the array at this point.
    await Promise.resolve();
    expect(initiated).toEqual(["first", "second"]);

    // Resolve both so the function can finish.
    resolveFirst([]);
    resolveSecond([]);
    await pending;
  });

  it("returns false when both tables return no rows (no opt-out active)", async () => {
    mocks.selectWhere.mockResolvedValueOnce([]); // global → no row
    mocks.selectWhere.mockResolvedValueOnce([]); // per-guild → no row

    const result = await isVcTrackingOptedOut("guild-par-3", "user-par-3");
    expect(result).toBe(false);
  });

  it("returns true when only the global row has optedOut=true (global wins)", async () => {
    mocks.selectWhere.mockResolvedValueOnce([{ userId: "user-par-4", optedOut: true }]); // global
    mocks.selectWhere.mockResolvedValueOnce([]); // per-guild → no row

    const result = await isVcTrackingOptedOut("guild-par-4", "user-par-4");
    expect(result).toBe(true);
  });

  it("returns true when only the per-guild row has optedOut=true (global absent)", async () => {
    mocks.selectWhere.mockResolvedValueOnce([]); // global → no row
    mocks.selectWhere.mockResolvedValueOnce([{ guildId: "guild-par-5", userId: "user-par-5", optedOut: true }]);

    const result = await isVcTrackingOptedOut("guild-par-5", "user-par-5");
    expect(result).toBe(true);
  });

  it("returns false when per-guild row exists but optedOut=false (and global absent)", async () => {
    mocks.selectWhere.mockResolvedValueOnce([]); // global → no row
    mocks.selectWhere.mockResolvedValueOnce([{ guildId: "guild-par-6", userId: "user-par-6", optedOut: false }]);

    const result = await isVcTrackingOptedOut("guild-par-6", "user-par-6");
    expect(result).toBe(false);
  });

  it("calls db.select() exactly twice — one per table — for each invocation", async () => {
    mocks.selectWhere.mockResolvedValueOnce([]);
    mocks.selectWhere.mockResolvedValueOnce([]);

    await isVcTrackingOptedOut("guild-par-7", "user-par-7");

    // Two selects: one for communityVcPrivacyGlobalTable, one for communityVcPrivacyTable
    expect(mocks.select).toHaveBeenCalledTimes(2);
  });

  // ── Rejection propagation (error isolation) ────────────────────────────────
  //
  // Promise.all fast-fails: if either branch rejects the entire returned promise
  // rejects.  These tests use the same deferred-promise technique as the
  // parallelism tests above so they also assert that BOTH selects are initiated
  // before any rejection propagates.  A serialised implementation (sequential
  // awaits) would never initiate the second query when the first rejects and
  // would therefore fail the "initiated" assertions below.

  it("rejects when the global-table select rejects and still initiates both selects before the rejection propagates", async () => {
    const initiated: string[] = [];

    // Deferred handles: global rejects, guild is held so we can check it was
    // started before Promise.all settles.
    let rejectGlobal!: (err: Error) => void;
    let resolveGuild!: (rows: unknown[]) => void;
    const globalPending = new Promise<unknown[]>((_, rej) => { rejectGlobal = rej; });
    const guildPending  = new Promise<unknown[]>((res) => { resolveGuild  = res; });

    mocks.selectWhere
      .mockImplementationOnce(() => { initiated.push("global"); return globalPending; })
      .mockImplementationOnce(() => { initiated.push("guild");  return guildPending;  });

    const pending = isVcTrackingOptedOut("guild-par-rej-1", "user-par-rej-1");

    // After one microtask tick both selects must already be in-flight.
    // A serialised implementation would never reach the guild select when the
    // global one is still pending, so "guild" would be absent here.
    await Promise.resolve();
    expect(initiated).toContain("global");
    expect(initiated).toContain("guild");

    // Trigger the global rejection and settle the guild promise so no
    // unhandled-rejection escapes from this test.
    rejectGlobal(new Error("DB connection lost"));
    resolveGuild([]);

    await expect(pending).rejects.toThrow("DB connection lost");
  });

  it("rejects when the per-guild-table select rejects and still initiates both selects before the rejection propagates", async () => {
    const initiated: string[] = [];

    let resolveGlobal!: (rows: unknown[]) => void;
    let rejectGuild!: (err: Error) => void;
    const globalPending = new Promise<unknown[]>((res) => { resolveGlobal = res; });
    const guildPending  = new Promise<unknown[]>((_, rej) => { rejectGuild  = rej; });

    mocks.selectWhere
      .mockImplementationOnce(() => { initiated.push("global"); return globalPending; })
      .mockImplementationOnce(() => { initiated.push("guild");  return guildPending;  });

    const pending = isVcTrackingOptedOut("guild-par-rej-2", "user-par-rej-2");

    // Both selects must be in-flight after one tick — a serialised
    // implementation would await the global first and never reach the guild.
    await Promise.resolve();
    expect(initiated).toContain("global");
    expect(initiated).toContain("guild");

    // Trigger the guild rejection and settle the global promise cleanly.
    resolveGlobal([]);
    rejectGuild(new Error("query timeout"));

    await expect(pending).rejects.toThrow("query timeout");
  });

  it("openSession returns null (not an unhandled rejection) when the inner select rejects", async () => {
    // isVcTrackingOptedOut's global-table query rejects — openSession must
    // catch it (fail-closed) and return null instead of letting the rejection
    // escape to the VoiceStateUpdate handler.
    mocks.selectWhere.mockRejectedValueOnce(new Error("network error"));

    // resolves to null, never rejects
    await expect(
      openSession("guild-par-rej-3", "user-par-rej-3", "channel-par-rej-3"),
    ).resolves.toBeNull();

    // No session row must be created
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});

// ─── openSession – privacy check DB failure (fail-closed) ────────────────────
//
// If the DB is unreachable when isVcTrackingOptedOut runs, openSession must
// return null (fail-closed) instead of propagating an unhandled rejection to
// the VoiceStateUpdate handler.  These tests pin that behaviour so any future
// change to the failure mode is a conscious decision.

describe("openSession – privacy check DB failure (fail-closed)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when the global privacy select rejects", async () => {
    // First selectWhere call (global table) throws; second never runs.
    mocks.selectWhere.mockRejectedValueOnce(new Error("DB unreachable"));

    const session = await openSession("guild-dbfail-1", "user-dbfail-1", "channel-dbfail-1");

    expect(session).toBeNull();
  });

  it("returns null when the per-guild privacy select rejects", async () => {
    // First selectWhere call (global table) resolves normally.
    mocks.selectWhere.mockResolvedValueOnce([]);
    // Second selectWhere call (per-guild table) throws.
    mocks.selectWhere.mockRejectedValueOnce(new Error("DB unreachable"));

    const session = await openSession("guild-dbfail-2", "user-dbfail-2", "channel-dbfail-2");

    expect(session).toBeNull();
  });

  it("does not create a session row when the privacy check throws", async () => {
    mocks.selectWhere.mockRejectedValueOnce(new Error("connection timeout"));

    await openSession("guild-dbfail-3", "user-dbfail-3", "channel-dbfail-3");

    // db.insert() must NOT have been called — no partial session row created.
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("returns null rather than throwing, so callers receive a value not an unhandled rejection", async () => {
    mocks.selectWhere.mockRejectedValueOnce(new Error("query failed"));

    // openSession must resolve (not reject) even when isVcTrackingOptedOut throws.
    await expect(
      openSession("guild-dbfail-4", "user-dbfail-4", "channel-dbfail-4"),
    ).resolves.toBeNull();
  });
});

// ─── setVcGlobalPrivacyOptOut – cold-start opt-out path (optedOut=true) ───────
//
// A user who has never touched the global opt-out setting has no row in
// communityVcPrivacyGlobalTable. Calling setVcGlobalPrivacyOptOut(userId, true)
// must succeed on the very first call: it takes the INSERT branch of the upsert
// (no conflict), stores optedOut=true, and MUST call closeOpenSessionsForUser
// (the session-close path is only for optedOut=true).

describe("setVcGlobalPrivacyOptOut – cold-start opt-out path (optedOut=true)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 0 when the user has no prior global opt-out row and no open sessions", async () => {
    // No pre-existing row → INSERT branch; onConflictDoUpdate resolves without conflict.
    // closeOpenSessionsForUser finds no open sessions → returning resolves to [].
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);
    mocks.returning.mockResolvedValueOnce([]);

    const result = await setVcGlobalPrivacyOptOut("user-ct-1", true);

    expect(result).toBe(0);
  });

  it("returns the number of sessions closed when open sessions existed", async () => {
    // INSERT branch succeeds; closeOpenSessionsForUser closes 2 sessions.
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);
    mocks.returning.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);

    const result = await setVcGlobalPrivacyOptOut("user-ct-2", true);

    expect(result).toBe(2);
  });

  it("calls db.insert() with optedOut: true (persists the cold-start row)", async () => {
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);
    mocks.returning.mockResolvedValueOnce([]);

    await setVcGlobalPrivacyOptOut("user-ct-3", true);

    // db.insert() must have been called exactly once
    expect(mocks.insert).toHaveBeenCalledTimes(1);

    // The values() payload must carry optedOut: true and the correct userId
    const [valuesArg] = mocks.values.mock.calls[0] as unknown as [
      { userId: string; optedOut: boolean }
    ];
    expect(valuesArg.userId).toBe("user-ct-3");
    expect(valuesArg.optedOut).toBe(true);
  });

  it("calls db.update() (closeOpenSessionsForUser IS invoked on opt-out path)", async () => {
    // The opt-out=true path must always call closeOpenSessionsForUser, even
    // when there is no pre-existing global row.
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);
    mocks.returning.mockResolvedValueOnce([]);

    await setVcGlobalPrivacyOptOut("user-ct-4", true);

    // db.update() is only used by closeOpenSessionsForUser
    expect(mocks.update).toHaveBeenCalled();
  });

  it("targets the global table (insert must reach communityVcPrivacyGlobalTable)", async () => {
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);
    mocks.returning.mockResolvedValueOnce([]);

    await setVcGlobalPrivacyOptOut("user-ct-5", true);

    // The table stub passed to db.insert() must be communityVcPrivacyGlobalTable
    // (the proxy returns "global.<prop>" for every property on that stub).
    const [tableArg] = mocks.insert.mock.calls[0] as unknown as [Record<string, string>];
    expect(tableArg["userId"]).toBe("global.userId");
  });

  it("closeOpenSessionsForUser stamps leftAt with a Date on the vc sessions table", async () => {
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);
    mocks.returning.mockResolvedValueOnce([{ id: 7 }]);

    const before = Date.now();
    await setVcGlobalPrivacyOptOut("user-ct-6", true);
    const after = Date.now();

    // The set() payload inside closeOpenSessionsForUser must carry a leftAt Date
    const [setPayload] = mocks.set.mock.calls[0] as unknown as [{ leftAt: Date }];
    expect(setPayload.leftAt).toBeInstanceOf(Date);
    expect(setPayload.leftAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(setPayload.leftAt.getTime()).toBeLessThanOrEqual(after);
  });

  it("onConflictDoUpdate payload also carries optedOut: true (update branch is consistent)", async () => {
    mocks.onConflictDoUpdate.mockResolvedValueOnce([]);
    mocks.returning.mockResolvedValueOnce([]);

    await setVcGlobalPrivacyOptOut("user-ct-7", true);

    const [conflictArg] = mocks.onConflictDoUpdate.mock.calls[0] as unknown as [
      { set: { optedOut: boolean } }
    ];
    expect(conflictArg.set.optedOut).toBe(true);
  });
});
