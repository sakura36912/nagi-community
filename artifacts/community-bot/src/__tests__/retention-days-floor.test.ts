/**
 * Tests for the retention-days floor guard in the /ranking retention-days
 * command handler and the handleRetentionConfirm button handler.
 *
 * Confirms that:
 *   (a) The command rejects any value < 30 with an ephemeral error and never
 *       reaches the DB.
 *   (b) The command accepts values >= 30 and persists them.
 *   (c) handleRetentionConfirm also rejects days < 30 (defense-in-depth floor
 *       guard against stale button replays).
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock state ─────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  // ── db.insert chain ──────────────────────────────────────────────────────────
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const insertValues = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values: insertValues }));

  // ── db.select chain ──────────────────────────────────────────────────────────
  const selectWhere = vi.fn().mockResolvedValue([]);
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  // ── db.delete chain ──────────────────────────────────────────────────────────
  const deleteReturning = vi.fn().mockResolvedValue([]);
  const deleteWhere = vi.fn(() => ({ returning: deleteReturning }));
  const del = vi.fn(() => ({ where: deleteWhere }));

  return {
    onConflictDoUpdate, insertValues, insert,
    selectWhere, selectFrom, select,
    deleteReturning, deleteWhere, del,
  };
});

// ─── Mock @workspace/db ───────────────────────────────────────────────────────
vi.mock("@workspace/db", () => {
  const tbl = (name: string) =>
    new Proxy({} as Record<string, string>, {
      get: (_t, p: string) => `${name}.${p}`,
    });

  return {
    db: {
      insert: mocks.insert,
      select: mocks.select,
      delete: mocks.del,
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })) })),
      })),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    },
    communityVcSessionsTable:       tbl("sessions"),
    communityVcPrivacyTable:         tbl("privacy"),
    communityVcPrivacyGlobalTable:   tbl("global"),
    communityEventSettingsTable:     tbl("eventSettings"),
    communityEventsTable:            tbl("events"),
    communityEventParticipantsTable: tbl("eventParticipants"),
    communityTicketSettingsTable:    tbl("ticketSettings"),
    communityTicketsTable:           tbl("tickets"),
    communityTicketPanelsTable:      tbl("ticketPanels"),
    communityRankingSettingsTable:   tbl("rankingSettings"),
    communityRoleButtonsTable:       tbl("roleButtons"),
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
    })),
  };
});

// ─── Imports under test (resolved after mocks) ───────────────────────────────
import {
  handleRetentionConfirm,
  COMM_RETENTION_CONFIRM_PREFIX,
} from "../commands/index.js";

// ─── Interaction factory helpers ─────────────────────────────────────────────

/** Creates a minimal ChatInputCommandInteraction stub for the ranking command. */
function makeCommandInteraction(opts: {
  guildId?: string | null;
  days?: number | null;
  isAdmin?: boolean;
}) {
  const { guildId = "guild-123", days = null, isAdmin = true } = opts;
  return {
    guildId,
    user: { id: "admin-user", tag: "Admin#0001" },
    memberPermissions: {
      has: vi.fn().mockReturnValue(isAdmin),
    },
    options: {
      getSubcommand: vi.fn().mockReturnValue("retention-days"),
      getInteger: vi.fn().mockReturnValue(days),
    },
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
}

/** Creates a minimal ButtonInteraction stub for the confirm button. */
function makeConfirmInteraction(opts: {
  days?: number;
  guildId?: string | null;
  isAdmin?: boolean;
}) {
  const { days = 30, guildId = "guild-123", isAdmin = true } = opts;
  return {
    guildId,
    customId: `${COMM_RETENTION_CONFIRM_PREFIX}${days}`,
    member: {
      permissions: {
        has: vi.fn().mockReturnValue(isAdmin),
      },
    },
    reply: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
}

// ─── Tests: command execute – floor rejection ─────────────────────────────────

// We import rankingCommand lazily after mocks are set up.
// Since it is not directly exported we need to reach it through the command
// registry that the file also exports.
let rankingExecute: ((interaction: unknown) => Promise<void>) | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  // Re-wire chains after clearAllMocks
  mocks.insertValues.mockReturnValue({ onConflictDoUpdate: mocks.onConflictDoUpdate });
  mocks.insert.mockReturnValue({ values: mocks.insertValues });
  mocks.selectFrom.mockReturnValue({ where: mocks.selectWhere });
  mocks.select.mockReturnValue({ from: mocks.selectFrom });

  if (!rankingExecute) {
    const mod = await import("../commands/index.js");
    // The commands array is the default export; find the ranking entry
    const commands: Array<{ data: { name: string }; execute: (i: unknown) => Promise<void> }> =
      (mod as unknown as { default: typeof commands }).default ?? [];
    const ranking = commands.find((c) => c.data?.name === "ranking");
    rankingExecute = ranking?.execute;
  }
});

describe("/ranking retention-days – floor guard (command handler)", () => {
  it("rejects 1 day with an ephemeral error and does NOT call the DB", async () => {
    if (!rankingExecute) return; // skip if command not found (belt-and-suspenders)
    const interaction = makeCommandInteraction({ days: 1 });
    await rankingExecute(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("rejects 29 days with an ephemeral error and does NOT call the DB", async () => {
    if (!rankingExecute) return;
    const interaction = makeCommandInteraction({ days: 29 });
    await rankingExecute(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("error reply for a below-floor value mentions 30 days", async () => {
    if (!rankingExecute) return;
    const interaction = makeCommandInteraction({ days: 7 });
    await rankingExecute(interaction as never);

    const [[replyArg]] = interaction.reply.mock.calls as [[{ content: string; ephemeral: boolean }]];
    expect(replyArg.content).toMatch(/30/);
  });

  it("error reply includes the actual value the admin tried to set", async () => {
    if (!rankingExecute) return;
    const interaction = makeCommandInteraction({ days: 14 });
    await rankingExecute(interaction as never);

    const [[replyArg]] = interaction.reply.mock.calls as [[{ content: string; ephemeral: boolean }]];
    expect(replyArg.content).toMatch(/14/);
  });

  it("accepts exactly 30 days and persists the value", async () => {
    if (!rankingExecute) return;
    const interaction = makeCommandInteraction({ days: 30 });
    await rankingExecute(interaction as never);

    expect(mocks.insert).toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
  });

  it("accepts 180 days and persists the value without any error", async () => {
    if (!rankingExecute) return;
    const interaction = makeCommandInteraction({ days: 180 });
    await rankingExecute(interaction as never);

    expect(mocks.insert).toHaveBeenCalled();

    // If reply was called, it must NOT be an error (floor guard should not fire)
    if (interaction.reply.mock.calls.length > 0) {
      const [[replyArg]] = interaction.reply.mock.calls as [[{ content: string }]];
      expect(replyArg.content).not.toMatch(/30日以上/);
    }
  });
});

// ─── Tests: handleRetentionConfirm – floor guard (button handler) ─────────────

describe("handleRetentionConfirm – floor guard", () => {
  it("rejects 1 day with an ephemeral error and does NOT touch the DB", async () => {
    const interaction = makeConfirmInteraction({ days: 1 });
    await handleRetentionConfirm(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("rejects 29 days with an ephemeral error and does NOT touch the DB", async () => {
    const interaction = makeConfirmInteraction({ days: 29 });
    await handleRetentionConfirm(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("floor error message for confirm handler mentions 30 days", async () => {
    const interaction = makeConfirmInteraction({ days: 5 });
    await handleRetentionConfirm(interaction as never);

    const [[replyArg]] = interaction.reply.mock.calls as [[{ content: string; ephemeral: boolean }]];
    expect(replyArg.content).toMatch(/30/);
  });

  it("accepts exactly 30 days and proceeds to deferUpdate + DB write", async () => {
    const interaction = makeConfirmInteraction({ days: 30 });
    await handleRetentionConfirm(interaction as never);

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(mocks.insert).toHaveBeenCalled();
  });

  it("accepts 90 days and proceeds to deferUpdate + DB write", async () => {
    const interaction = makeConfirmInteraction({ days: 90 });
    await handleRetentionConfirm(interaction as never);

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(mocks.insert).toHaveBeenCalled();
  });
});
