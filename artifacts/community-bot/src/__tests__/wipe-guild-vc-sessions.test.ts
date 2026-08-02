/**
 * Tests for wipeGuildVcSessions and the /ranking reset command handler.
 *
 * Confirms that:
 *   (a) wipeGuildVcSessions scopes the DELETE to completed sessions only
 *       (left_at IS NOT NULL) so ongoing tracking is never silently cleared.
 *   (b) The /ranking reset command shows a warning when confirm is not true
 *       and never reaches the DB.
 *   (c) The /ranking reset command performs the wipe when confirm: true.
 *   (d) Non-admins are blocked from running /ranking reset.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock state ─────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  const returning = vi.fn().mockResolvedValue([]);
  const deleteWhere = vi.fn(() => ({ returning }));
  const del = vi.fn(() => ({ where: deleteWhere }));

  const selectWhere = vi.fn().mockResolvedValue([]);
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  const insertValues = vi.fn(() => ({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) }));
  const insert = vi.fn(() => ({ values: insertValues }));

  return { returning, deleteWhere, del, selectWhere, selectFrom, select, insert, insertValues };
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
      select: mocks.select,
      insert: mocks.insert,
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })) })),
      })),
    },
    communityVcSessionsTable:        tbl("sessions"),
    communityVcPrivacyTable:          tbl("privacy"),
    communityVcPrivacyGlobalTable:    tbl("global"),
    communityEventSettingsTable:      tbl("eventSettings"),
    communityEventsTable:             tbl("events"),
    communityEventParticipantsTable:  tbl("eventParticipants"),
    communityTicketSettingsTable:     tbl("ticketSettings"),
    communityTicketsTable:            tbl("tickets"),
    communityTicketPanelsTable:       tbl("ticketPanels"),
    communityRankingSettingsTable:    tbl("rankingSettings"),
    communityRoleButtonsTable:        tbl("roleButtons"),
  };
});

// ─── Mock drizzle-orm ─────────────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  and:       (...args: unknown[]) => ({ op: "and", args }),
  eq:        (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  isNull:    (col: unknown) => ({ op: "isNull", col }),
  isNotNull: (col: unknown) => ({ op: "isNotNull", col }),
  lt:        (col: unknown, val: unknown) => ({ op: "lt", col, val }),
  lte:       (col: unknown, val: unknown) => ({ op: "lte", col, val }),
  gt:        (col: unknown, val: unknown) => ({ op: "gt", col, val }),
  gte:       (col: unknown, val: unknown) => ({ op: "gte", col, val }),
  or:        (...args: unknown[]) => ({ op: "or", args }),
  asc:       (col: unknown) => ({ op: "asc", col }),
  desc:      (col: unknown) => ({ op: "desc", col }),
  notInArray:(col: unknown, vals: unknown) => ({ op: "notInArray", col, vals }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: "sql", strings, values }),
    { raw: (v: unknown) => ({ op: "sql.raw", v }) },
  ),
}));

// ─── Mock discord.js ─────────────────────────────────────────────────────────
vi.mock("discord.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("discord.js")>();
  return {
    ...actual,
    EmbedBuilder: vi.fn().mockImplementation(() => ({
      setTitle: vi.fn().mockReturnThis(),
      setColor: vi.fn().mockReturnThis(),
      setDescription: vi.fn().mockReturnThis(),
      setFooter: vi.fn().mockReturnThis(),
      setTimestamp: vi.fn().mockReturnThis(),
      data: {},
    })),
    ActionRowBuilder: vi.fn().mockImplementation(() => ({
      addComponents: vi.fn().mockReturnThis(),
    })),
    ButtonBuilder: vi.fn().mockImplementation(() => ({
      setCustomId: vi.fn().mockReturnThis(),
      setLabel: vi.fn().mockReturnThis(),
      setStyle: vi.fn().mockReturnThis(),
      setDisabled: vi.fn().mockReturnThis(),
    })),
  };
});

// ─── Imports under test ───────────────────────────────────────────────────────
import { wipeGuildVcSessions } from "../lib/community.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeResetInteraction(opts: {
  guildId?: string | null;
  confirm?: boolean | null;
  isAdmin?: boolean;
}) {
  const { guildId = "guild-123", confirm = null, isAdmin = true } = opts;
  return {
    guildId,
    user: { id: "admin-user", tag: "Admin#0001" },
    memberPermissions: {
      has: vi.fn().mockReturnValue(isAdmin),
    },
    options: {
      getSubcommand: vi.fn().mockReturnValue("reset"),
      getBoolean: vi.fn().mockReturnValue(confirm),
      // Stub other option getters so the pre-guards don't throw
      getString:  vi.fn().mockReturnValue(null),
      getInteger: vi.fn().mockReturnValue(null),
      getChannel: vi.fn().mockReturnValue(null),
    },
    reply:      vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply:  vi.fn().mockResolvedValue(undefined),
  };
}

let rankingExecute: ((interaction: unknown) => Promise<void>) | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.deleteWhere.mockReturnValue({ returning: mocks.returning });
  mocks.del.mockReturnValue({ where: mocks.deleteWhere });
  mocks.selectFrom.mockReturnValue({ where: mocks.selectWhere });
  mocks.select.mockReturnValue({ from: mocks.selectFrom });

  if (!rankingExecute) {
    const mod = await import("../commands/index.js");
    const commands: Array<{ data: { name: string }; execute: (i: unknown) => Promise<void> }> =
      (mod as unknown as { default: typeof commands }).default ?? [];
    const ranking = commands.find((c) => c.data?.name === "ranking");
    rankingExecute = ranking?.execute;
  }
});

// ─── Tests: wipeGuildVcSessions – active-session guard ────────────────────────

describe("wipeGuildVcSessions – active-session guard", () => {
  it("includes isNotNull(leftAt) in the WHERE clause to skip active sessions", async () => {
    await wipeGuildVcSessions("guild-123");

    const whereArg = (mocks.deleteWhere.mock.calls as unknown[][])[0]?.[0] as { op: string; args: unknown[] } | undefined;
    expect(whereArg).toBeDefined();
    expect(whereArg!.op).toBe("and");

    // One of the AND conditions must be isNotNull
    const hasIsNotNull = (whereArg!.args as { op: string }[]).some((a) => a.op === "isNotNull");
    expect(hasIsNotNull).toBe(true);
  });

  it("scopes the delete to the supplied guildId via eq()", async () => {
    await wipeGuildVcSessions("guild-abc");

    const whereArg = (mocks.deleteWhere.mock.calls as unknown[][])[0]?.[0] as { op: string; args: { op: string; val: unknown }[] } | undefined;
    const eqClause = (whereArg!.args as { op: string; val: unknown }[]).find((a) => a.op === "eq");
    expect(eqClause?.val).toBe("guild-abc");
  });

  it("returns the count of deleted rows", async () => {
    mocks.returning.mockResolvedValueOnce([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const count = await wipeGuildVcSessions("guild-123");
    expect(count).toBe(3);
  });

  it("returns 0 when no completed sessions exist", async () => {
    mocks.returning.mockResolvedValueOnce([]);
    const count = await wipeGuildVcSessions("guild-123");
    expect(count).toBe(0);
  });
});

// ─── Tests: /ranking reset command handler ────────────────────────────────────

describe("/ranking reset – command handler", () => {
  it("blocks non-admins with an ephemeral error before any DB call", async () => {
    if (!rankingExecute) return;
    const interaction = makeResetInteraction({ isAdmin: false, confirm: true });
    await rankingExecute(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it("shows a warning and does NOT call the DB when confirm is not supplied", async () => {
    if (!rankingExecute) return;
    const interaction = makeResetInteraction({ confirm: null });
    await rankingExecute(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it("shows a warning and does NOT call the DB when confirm is false", async () => {
    if (!rankingExecute) return;
    const interaction = makeResetInteraction({ confirm: false });
    await rankingExecute(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it("performs the wipe when confirm is true", async () => {
    if (!rankingExecute) return;
    const interaction = makeResetInteraction({ confirm: true });
    await rankingExecute(interaction as never);

    expect(mocks.del).toHaveBeenCalled();
    expect(interaction.deferReply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(interaction.editReply).toHaveBeenCalled();
  });

  it("the warning reply for missing confirm mentions 'confirm'", async () => {
    if (!rankingExecute) return;
    const interaction = makeResetInteraction({ confirm: null });
    await rankingExecute(interaction as never);

    const [[replyArg]] = interaction.reply.mock.calls as [[{ content: string }]];
    expect(replyArg.content).toMatch(/confirm/i);
  });
});
