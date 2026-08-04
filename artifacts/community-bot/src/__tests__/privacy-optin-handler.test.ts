/**
 * Integration-level tests for the `handlePrivacyOptin` command handler.
 *
 * Scenario: a user's privacy row was wiped (or never existed). When they run
 * `/privacy optin` the handler must NOT short-circuit before calling the
 * setters — it must atomically write:
 *   • global opt-out  → false  (communityVcPrivacyGlobalTable)
 *   • per-guild opt-out → false (communityVcPrivacyTable)
 * both inside a single DB transaction so a partial failure cannot leave the
 * user in a mixed opted-in / opted-out state.
 *
 * These tests exercise the full handler flow (not the DB functions in isolation)
 * so that a bug where the handler reads an absent row as opted-out and returns
 * early is directly caught.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock state ─────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  // Table proxies — created once so identity checks (===) work
  const makeTable = (name: string) =>
    new Proxy({} as Record<string, string>, { get: (_t, p: string) => `${name}.${p}` });

  const tables = {
    global:            makeTable("global"),
    privacy:           makeTable("privacy"),
    sessions:          makeTable("sessions"),
    eventSettings:     makeTable("eventSettings"),
    events:            makeTable("events"),
    eventParticipants: makeTable("eventParticipants"),
    ticketSettings:    makeTable("ticketSettings"),
    tickets:           makeTable("tickets"),
    ticketPanels:      makeTable("ticketPanels"),
    rankingSettings:   makeTable("rankingSettings"),
    roleButtons:       makeTable("roleButtons"),
  };

  // Captures every upsert committed by a successful transaction: { tableTag, row, set }
  const upsertLog: Array<{ tableTag: string; row: Record<string, unknown>; set: Record<string, unknown> }> = [];

  // Staging buffer — flushed to upsertLog on transaction success, discarded on rollback
  const txUpsertBuffer: Array<{ tableTag: string; row: Record<string, unknown>; set: Record<string, unknown> }> = [];

  // Per-test: which table (by tableTag) should reject inside the transaction. null = all succeed.
  const txState: { failTable: string | null } = { failTable: null };

  const reset = () => {
    upsertLog.length = 0;
    txUpsertBuffer.length = 0;
    txState.failTable = null;
  };

  // ── Insert implementation used inside db.transaction callback ─────────────
  // (Not a vi.fn — wraps individual calls in a plain object so vitest won't
  //  confuse them with the top-level db.insert mock.)
  const txInsert = (table: unknown) => ({
    values: vi.fn((row: Record<string, unknown>) => ({
      onConflictDoUpdate: vi.fn(({ set }: { set: Record<string, unknown> }) => {
        const tableTag =
          table === tables.global  ? "global"  :
          table === tables.privacy ? "privacy" : "other";
        if (txState.failTable === tableTag) {
          return Promise.reject(new Error(`DB transient failure — ${tableTag}`));
        }
        txUpsertBuffer.push({ tableTag, row, set });
        return Promise.resolve([]);
      }),
      returning: vi.fn().mockResolvedValue([]),
    })),
  });

  // ── db.transaction mock ───────────────────────────────────────────────────
  // Mirrors real Drizzle behaviour: all tx writes go to a staging buffer;
  // on success they are flushed to upsertLog; on any throw they are discarded.
  const transaction = vi.fn(async (cb: (tx: { insert: typeof txInsert }) => Promise<void>) => {
    txUpsertBuffer.length = 0;
    try {
      await cb({ insert: txInsert });
      // Commit: staged writes become visible
      upsertLog.push(...txUpsertBuffer);
    } catch (err) {
      // Rollback: staged writes are discarded
      throw err;
    } finally {
      txUpsertBuffer.length = 0;
    }
  });

  // ── Stateful insert — used for non-transactional DB calls (select / update) ─
  const insert = vi.fn((table: unknown) => ({
    values: vi.fn((row: Record<string, unknown>) => ({
      onConflictDoUpdate: vi.fn(({ set }: { set: Record<string, unknown> }) => {
        const tableTag =
          table === tables.global  ? "global"  :
          table === tables.privacy ? "privacy" : "other";
        upsertLog.push({ tableTag, row, set });
        return Promise.resolve([]);
      }),
      returning: vi.fn().mockResolvedValue([]),
    })),
  }));

  // select returns [] — simulates absent privacy rows
  const selectWhere = vi.fn().mockResolvedValue([]);
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  // update (used by closeSession / closeOpenSessionsForUser when optedOut=true — must not be called)
  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([]),
      })),
    })),
  }));

  return { insert, select, selectWhere, selectFrom, update, transaction, tables, upsertLog, txState, reset };
});

// ─── Mock @workspace/db ───────────────────────────────────────────────────────
vi.mock("@workspace/db", () => ({
  db: {
    insert:      mocks.insert,
    select:      mocks.select,
    update:      mocks.update,
    transaction: mocks.transaction,
    execute:     vi.fn().mockResolvedValue({ rows: [] }),
    delete:      vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })) })),
  },
  communityVcPrivacyGlobalTable:    mocks.tables.global,
  communityVcPrivacyTable:           mocks.tables.privacy,
  communityVcSessionsTable:          mocks.tables.sessions,
  communityEventSettingsTable:       mocks.tables.eventSettings,
  communityEventsTable:              mocks.tables.events,
  communityEventParticipantsTable:   mocks.tables.eventParticipants,
  communityTicketSettingsTable:      mocks.tables.ticketSettings,
  communityTicketsTable:             mocks.tables.tickets,
  communityTicketPanelsTable:        mocks.tables.ticketPanels,
  communityRankingSettingsTable:     mocks.tables.rankingSettings,
  communityRoleButtonsTable:         mocks.tables.roleButtons,
}));

// ─── Mock drizzle-orm ─────────────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  and:        (...args: unknown[]) => ({ op: "and", args }),
  eq:         (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  isNull:     (col: unknown) => ({ op: "isNull", col }),
  isNotNull:  (col: unknown) => ({ op: "isNotNull", col }),
  gt:         (col: unknown, val: unknown) => ({ op: "gt", col, val }),
  gte:        (col: unknown, val: unknown) => ({ op: "gte", col, val }),
  lt:         (col: unknown, val: unknown) => ({ op: "lt", col, val }),
  lte:        (col: unknown, val: unknown) => ({ op: "lte", col, val }),
  or:         (...args: unknown[]) => ({ op: "or", args }),
  notInArray: (col: unknown, vals: unknown) => ({ op: "notInArray", col, vals }),
  asc:        (col: unknown) => ({ op: "asc", col }),
  desc:       (col: unknown) => ({ op: "desc", col }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: "sql", strings: Array.from(strings), values }),
    { raw: (v: unknown) => ({ op: "sql.raw", v }) },
  ),
}));

// ─── Import after mocks ───────────────────────────────────────────────────────
import { handlePrivacyOptin } from "../commands/index.js";

// ─── Interaction factory ──────────────────────────────────────────────────────
function makeInteraction(opts: { userId?: string; guildId?: string | null } = {}) {
  const { userId = "user-001", guildId = "guild-001" } = opts;
  return {
    user:      { id: userId, tag: "TestUser#0001" },
    guildId,
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply:  vi.fn().mockResolvedValue(undefined),
    reply:      vi.fn().mockResolvedValue(undefined),
    options: {
      getSubcommand: vi.fn().mockReturnValue("optin"),
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("handlePrivacyOptin — per-guild opt-in path (absent row)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();
    // Absent rows: selects return []
    mocks.selectWhere.mockResolvedValue([]);
  });

  it("calls setVcPrivacyOptOut (per-guild upsert) with optedOut=false when the row is absent", async () => {
    const interaction = makeInteraction({ userId: "user-optin", guildId: "guild-001" });
    await handlePrivacyOptin(interaction as never);

    const perGuildUpserts = mocks.upsertLog.filter((u) => u.tableTag === "privacy");
    expect(perGuildUpserts).toHaveLength(1);
    expect(perGuildUpserts[0]!.set.optedOut).toBe(false);
  });

  it("per-guild upsert targets the correct guildId and userId", async () => {
    const interaction = makeInteraction({ userId: "user-abc", guildId: "guild-xyz" });
    await handlePrivacyOptin(interaction as never);

    const perGuildUpserts = mocks.upsertLog.filter((u) => u.tableTag === "privacy");
    expect(perGuildUpserts[0]!.row.guildId).toBe("guild-xyz");
    expect(perGuildUpserts[0]!.row.userId).toBe("user-abc");
  });

  it("does not call db.update (no session close) because optedOut=false skips that branch", async () => {
    const interaction = makeInteraction();
    await handlePrivacyOptin(interaction as never);

    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("calls interaction.editReply with a success embed after opting in from an absent row", async () => {
    const interaction = makeInteraction();
    await handlePrivacyOptin(interaction as never);

    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    const [[replyArg]] = interaction.editReply.mock.calls as [[{ embeds: unknown[] }]];
    expect(Array.isArray(replyArg.embeds)).toBe(true);
    expect(replyArg.embeds).toHaveLength(1);
  });

  it("success embed title signals that tracking has been resumed", async () => {
    const interaction = makeInteraction();
    await handlePrivacyOptin(interaction as never);

    const [[replyArg]] = interaction.editReply.mock.calls as [[{ embeds: { data: { title?: string } }[] }]];
    const title = replyArg.embeds[0]?.data?.title ?? "";
    expect(title).toMatch(/再開/);
  });

  it("does not short-circuit — editReply is called even when no prior privacy row exists", async () => {
    // Absent row: selectWhere returns [] (the default), no row to read
    const interaction = makeInteraction();
    await handlePrivacyOptin(interaction as never);

    // Must reach the success reply, not return early
    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    expect(interaction.reply).not.toHaveBeenCalled();
  });
});

describe("handlePrivacyOptin — global opt-in path (absent row)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();
    mocks.selectWhere.mockResolvedValue([]);
  });

  it("calls setVcGlobalPrivacyOptOut (global upsert) with optedOut=false when the row is absent", async () => {
    const interaction = makeInteraction({ userId: "user-global-optin" });
    await handlePrivacyOptin(interaction as never);

    const globalUpserts = mocks.upsertLog.filter((u) => u.tableTag === "global");
    expect(globalUpserts).toHaveLength(1);
    expect(globalUpserts[0]!.set.optedOut).toBe(false);
  });

  it("global upsert targets the correct userId", async () => {
    const interaction = makeInteraction({ userId: "user-global-999" });
    await handlePrivacyOptin(interaction as never);

    const globalUpserts = mocks.upsertLog.filter((u) => u.tableTag === "global");
    expect(globalUpserts[0]!.row.userId).toBe("user-global-999");
  });

  it("fires both global and per-guild upserts in the same handler call", async () => {
    const interaction = makeInteraction({ userId: "user-both", guildId: "guild-both" });
    await handlePrivacyOptin(interaction as never);

    const globalUpserts  = mocks.upsertLog.filter((u) => u.tableTag === "global");
    const perGuildUpserts = mocks.upsertLog.filter((u) => u.tableTag === "privacy");

    expect(globalUpserts).toHaveLength(1);
    expect(perGuildUpserts).toHaveLength(1);
    expect(globalUpserts[0]!.set.optedOut).toBe(false);
    expect(perGuildUpserts[0]!.set.optedOut).toBe(false);
  });

  it("global upsert is routed through db.transaction (both writes are atomic)", async () => {
    const interaction = makeInteraction({ userId: "user-tx-check" });
    await handlePrivacyOptin(interaction as never);

    // The handler must go through db.transaction, not bare db.insert
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    // The global write is committed (visible in upsertLog) only because the tx succeeded
    const globalUpserts = mocks.upsertLog.filter((u) => u.tableTag === "global");
    expect(globalUpserts).toHaveLength(1);
  });

  it("does not close any global sessions when opting back in (optedOut=false branch skipped)", async () => {
    const interaction = makeInteraction();
    await handlePrivacyOptin(interaction as never);

    // closeOpenSessionsForUser uses db.update — must not have been called
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe("handlePrivacyOptin — partial failure: one setter rejects, state preserved", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset(); // clears upsertLog, txUpsertBuffer, and txState.failTable
    mocks.selectWhere.mockResolvedValue([]);
  });

  // ── global setter fails ────────────────────────────────────────────────────

  it("propagates the error when the global setter rejects (does not swallow it silently)", async () => {
    mocks.txState.failTable = "global";
    const interaction = makeInteraction();
    await expect(handlePrivacyOptin(interaction as never)).rejects.toThrow(
      "DB transient failure — global",
    );
  });

  it("preserves pre-op state when the global setter rejects — no writes are committed", async () => {
    // Simulates: global write fails inside the transaction.
    // The transaction mock discards the staging buffer on throw, so upsertLog stays empty.
    mocks.txState.failTable = "global";
    const interaction = makeInteraction();
    await expect(handlePrivacyOptin(interaction as never)).rejects.toBeDefined();
    expect(mocks.upsertLog).toHaveLength(0);
  });

  it("does not send a success embed when the global setter rejects", async () => {
    mocks.txState.failTable = "global";
    const interaction = makeInteraction();
    await expect(handlePrivacyOptin(interaction as never)).rejects.toBeDefined();
    expect(interaction.editReply).not.toHaveBeenCalledWith(
      expect.objectContaining({ embeds: expect.any(Array) }),
    );
  });

  // ── per-guild setter fails ─────────────────────────────────────────────────

  it("propagates the error when the per-guild setter rejects (does not swallow it silently)", async () => {
    mocks.txState.failTable = "privacy";
    const interaction = makeInteraction();
    await expect(handlePrivacyOptin(interaction as never)).rejects.toThrow(
      "DB transient failure — privacy",
    );
  });

  it("preserves pre-op state when the per-guild setter rejects — the preceding global write is rolled back too", async () => {
    // Simulates: global write succeeds (staged) then per-guild write fails.
    // The transaction rolls back, discarding the already-staged global write.
    // upsertLog must remain empty — a partial update would leave the user in a
    // globally opted-in but per-guild opted-out state.
    mocks.txState.failTable = "privacy";
    const interaction = makeInteraction();
    await expect(handlePrivacyOptin(interaction as never)).rejects.toBeDefined();
    expect(mocks.upsertLog).toHaveLength(0);
  });

  it("does not send a success embed when the per-guild setter rejects", async () => {
    mocks.txState.failTable = "privacy";
    const interaction = makeInteraction();
    await expect(handlePrivacyOptin(interaction as never)).rejects.toBeDefined();
    expect(interaction.editReply).not.toHaveBeenCalledWith(
      expect.objectContaining({ embeds: expect.any(Array) }),
    );
  });
});

describe("handlePrivacyOptin — edge case: no guildId (DM context)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();
    mocks.selectWhere.mockResolvedValue([]);
  });

  it("returns early without calling db.transaction when guildId is absent", async () => {
    const interaction = makeInteraction({ guildId: null });
    await handlePrivacyOptin(interaction as never);

    // No DB writes should occur if there's no guild context
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("calls editReply with an error message (not a success embed) when guildId is absent", async () => {
    const interaction = makeInteraction({ guildId: null });
    await handlePrivacyOptin(interaction as never);

    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    const [[replyArg]] = interaction.editReply.mock.calls as [[unknown]];
    // The response is a plain string error, not an embed object with success title
    expect(typeof replyArg).toBe("string");
  });
});
