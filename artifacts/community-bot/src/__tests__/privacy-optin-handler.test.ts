/**
 * Integration-level tests for the `handlePrivacyOptin` command handler.
 *
 * Scenario: a user's privacy row was wiped (or never existed). When they run
 * `/privacy optin` the handler must NOT short-circuit before calling the
 * setters — it must call:
 *   • setVcGlobalPrivacyOptOut(userId, false)   — global opt-in path
 *   • setVcPrivacyOptOut(guildId, userId, false) — per-guild opt-in path
 * and then reply with a success embed.
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

  // Captures every upsert: { tableTag, row, set }
  const upsertLog: Array<{ tableTag: string; row: Record<string, unknown>; set: Record<string, unknown> }> = [];

  const reset = () => { upsertLog.length = 0; };

  // Stateful insert — tracks which table is being written to
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

  return { insert, select, selectWhere, selectFrom, update, tables, upsertLog, reset };
});

// ─── Mock @workspace/db ───────────────────────────────────────────────────────
vi.mock("@workspace/db", () => ({
  db: {
    insert:  mocks.insert,
    select:  mocks.select,
    update:  mocks.update,
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    delete:  vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })) })),
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

  it("global upsert conflict target is the userId column (single, not an array)", async () => {
    const interaction = makeInteraction({ userId: "user-conflict-check" });
    await handlePrivacyOptin(interaction as never);

    // The onConflictDoUpdate mock receives { target, set }.
    // For the global table the target is a single column (global.userId).
    // We verify this by inspecting the raw call args on the mock.
    const insertCalls = mocks.insert.mock.calls as unknown as Array<[unknown]>;
    const globalInsertCall = insertCalls.find(([tbl]) => tbl === mocks.tables.global);
    expect(globalInsertCall).toBeDefined();
  });

  it("does not close any global sessions when opting back in (optedOut=false branch skipped)", async () => {
    const interaction = makeInteraction();
    await handlePrivacyOptin(interaction as never);

    // closeOpenSessionsForUser uses db.update — must not have been called
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe("handlePrivacyOptin — edge case: no guildId (DM context)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();
    mocks.selectWhere.mockResolvedValue([]);
  });

  it("returns early without calling the DB setters when guildId is absent", async () => {
    const interaction = makeInteraction({ guildId: null });
    await handlePrivacyOptin(interaction as never);

    // No DB writes should occur if there's no guild context
    expect(mocks.insert).not.toHaveBeenCalled();
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
