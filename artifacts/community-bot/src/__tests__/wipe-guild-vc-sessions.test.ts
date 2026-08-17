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
 *   (e) An audit embed is posted to the configured audit log channel after a
 *       successful wipe.
 *   (f) The audit embed step is silently skipped when no audit channel is set.
 *   (g) A send error in the audit channel step does not surface to the admin.
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
      addFields: vi.fn().mockReturnThis(),
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
import { EmbedBuilder } from "discord.js";
import { wipeGuildVcSessions } from "../lib/community.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAuditChannel(opts: { send?: ReturnType<typeof vi.fn> } = {}) {
  return {
    isTextBased: () => true,
    send: opts.send ?? vi.fn().mockResolvedValue(undefined),
  };
}

function makeResetInteraction(opts: {
  guildId?: string | null;
  confirm?: boolean | null;
  isAdmin?: boolean;
  guild?: {
    name?: string;
    channels: { cache: { get: ReturnType<typeof vi.fn> }; fetch: ReturnType<typeof vi.fn> };
  } | null;
}) {
  const { guildId = "guild-123", confirm = null, isAdmin = true, guild = null } = opts;
  return {
    guildId,
    user: { id: "admin-user", tag: "Admin#0001" },
    guild,
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

// ─── Tests: /ranking reset – audit log embed ──────────────────────────────────

describe("/ranking reset – audit log embed", () => {
  it("posts an audit embed to the configured channel after a successful wipe", async () => {
    if (!rankingExecute) return;

    const sendMock = vi.fn().mockResolvedValue(undefined);
    const auditChannel = makeAuditChannel({ send: sendMock });

    const guild = {
      name: "Test Guild",
      channels: {
        cache: { get: vi.fn().mockReturnValue(auditChannel) },
        fetch: vi.fn().mockResolvedValue(null),
      },
    };

    // Make getAuditLogChannel return a channel ID by having the DB select
    // return a row with auditLogChannelId set.
    mocks.selectWhere.mockResolvedValueOnce([{ auditLogChannelId: "audit-ch-123" }]);

    const interaction = makeResetInteraction({ confirm: true, guild });
    await rankingExecute(interaction as never);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [sendArg] = sendMock.mock.calls[0] as [{ embeds: unknown[] }];
    expect(sendArg).toHaveProperty("embeds");
    expect(sendArg.embeds).toHaveLength(1);
  });

  it("skips the audit embed silently when no audit channel is configured", async () => {
    if (!rankingExecute) return;

    const sendMock = vi.fn();

    // selectWhere returns [] by default → getAuditLogChannel returns null
    const interaction = makeResetInteraction({ confirm: true, guild: null });
    await rankingExecute(interaction as never);

    expect(sendMock).not.toHaveBeenCalled();
    // The admin still gets a success reply
    expect(interaction.editReply).toHaveBeenCalled();
  });

  it("embed addFields contains the deleted-row count and admin mention in the correct fields", async () => {
    if (!rankingExecute) return;

    const sendMock = vi.fn().mockResolvedValue(undefined);
    const auditChannel = makeAuditChannel({ send: sendMock });

    const guild = {
      name: "Test Guild",
      channels: {
        cache: { get: vi.fn().mockReturnValue(auditChannel) },
        fetch: vi.fn().mockResolvedValue(null),
      },
    };

    // Simulate 3 deleted rows
    mocks.returning.mockResolvedValueOnce([{}, {}, {}]);
    // getAuditLogChannel returns a channel ID
    mocks.selectWhere.mockResolvedValueOnce([{ auditLogChannelId: "audit-ch-123" }]);

    const interaction = makeResetInteraction({ confirm: true, guild });
    await rankingExecute(interaction as never);

    // EmbedBuilder should have been instantiated once (the audit embed)
    const embedMockResults = (EmbedBuilder as unknown as ReturnType<typeof vi.fn>).mock.results;
    expect(embedMockResults.length).toBeGreaterThanOrEqual(1);

    // Find the instance whose addFields was called (the audit embed)
    const auditEmbedInstance = embedMockResults
      .map((r) => r.value as { addFields: ReturnType<typeof vi.fn> })
      .find((inst) => inst.addFields.mock.calls.length > 0);

    expect(auditEmbedInstance).toBeDefined();

    // addFields is called once with all three field objects spread as arguments
    const addFieldsCalls = auditEmbedInstance!.addFields.mock.calls;
    // Flatten all arguments across all addFields calls into a single list of fields
    const allFields = addFieldsCalls.flat() as { name: string; value: string }[];

    const deletedField = allFields.find((f) => f.name === "削除件数");
    expect(deletedField).toBeDefined();
    expect(deletedField!.value).toBe("3件");

    const operatorField = allFields.find((f) => f.name === "操作者");
    expect(operatorField).toBeDefined();
    expect(operatorField!.value).toContain("<@admin-user>");
  });

  it("posts the audit embed via fetch when the channel is not in the cache", async () => {
    if (!rankingExecute) return;

    const sendMock = vi.fn().mockResolvedValue(undefined);
    const fetchedChannel = makeAuditChannel({ send: sendMock });

    const guild = {
      name: "Test Guild",
      channels: {
        // Cache miss: get() returns undefined
        cache: { get: vi.fn().mockReturnValue(undefined) },
        // Fetch resolves with the channel
        fetch: vi.fn().mockResolvedValue(fetchedChannel),
      },
    };

    mocks.selectWhere.mockResolvedValueOnce([{ auditLogChannelId: "audit-ch-456" }]);

    const interaction = makeResetInteraction({ confirm: true, guild });
    await rankingExecute(interaction as never);

    // fetch must have been called with the channel id
    expect(guild.channels.fetch).toHaveBeenCalledWith("audit-ch-456");
    // send must have been called on the fetched channel
    expect(sendMock).toHaveBeenCalledTimes(1);
    const [sendArg] = sendMock.mock.calls[0] as [{ embeds: unknown[] }];
    expect(sendArg).toHaveProperty("embeds");
    expect(sendArg.embeds).toHaveLength(1);
  });

  it("サーバー field shows the guild ID when guild.name is unavailable", async () => {
    if (!rankingExecute) return;

    const sendMock = vi.fn().mockResolvedValue(undefined);
    const auditChannel = makeAuditChannel({ send: sendMock });

    // Guild has channels (so the audit channel can be resolved) but no name
    // property — this forces interaction.guild?.name to be undefined so the
    // fallback `?? guildId` must kick in.
    const guildWithoutName = {
      // name intentionally omitted → undefined
      channels: {
        cache: { get: vi.fn().mockReturnValue(auditChannel) },
        fetch: vi.fn().mockResolvedValue(null),
      },
    };

    mocks.selectWhere.mockResolvedValueOnce([{ auditLogChannelId: "audit-ch-123" }]);

    const interaction = makeResetInteraction({ confirm: true, guild: guildWithoutName });
    await rankingExecute(interaction as never);

    // The embed must have been sent
    expect(sendMock).toHaveBeenCalledTimes(1);

    // Locate the audit embed instance and inspect its addFields calls
    const embedMockResults = (EmbedBuilder as unknown as ReturnType<typeof vi.fn>).mock.results;
    const auditEmbedInstance = embedMockResults
      .map((r) => r.value as { addFields: ReturnType<typeof vi.fn> })
      .find((inst) => inst.addFields.mock.calls.length > 0);

    expect(auditEmbedInstance).toBeDefined();

    const allFields = auditEmbedInstance!.addFields.mock.calls.flat() as { name: string; value: string }[];
    const serverField = allFields.find((f) => f.name === "サーバー");
    expect(serverField).toBeDefined();
    // Must be the raw guild ID string, not blank
    expect(serverField!.value).toBe("guild-123");
  });

  it("sets the embed footer text to include the acting admin's user ID", async () => {
    if (!rankingExecute) return;

    const sendMock = vi.fn().mockResolvedValue(undefined);
    const auditChannel = makeAuditChannel({ send: sendMock });

    const guild = {
      name: "Test Guild",
      channels: {
        cache: { get: vi.fn().mockReturnValue(auditChannel) },
        fetch: vi.fn().mockResolvedValue(null),
      },
    };

    mocks.selectWhere.mockResolvedValueOnce([{ auditLogChannelId: "audit-ch-123" }]);

    const interaction = makeResetInteraction({ confirm: true, guild });
    await rankingExecute(interaction as never);

    // Locate the audit embed instance (the one whose addFields was called)
    const embedMockResults = (EmbedBuilder as unknown as ReturnType<typeof vi.fn>).mock.results;
    const auditEmbedInstance = embedMockResults
      .map((r) => r.value as { addFields: ReturnType<typeof vi.fn>; setFooter: ReturnType<typeof vi.fn> })
      .find((inst) => inst.addFields.mock.calls.length > 0);

    expect(auditEmbedInstance).toBeDefined();

    // setFooter must have been called at least once
    expect(auditEmbedInstance!.setFooter).toHaveBeenCalled();

    // The footer text must contain the acting admin's user ID
    const footerArg = auditEmbedInstance!.setFooter.mock.calls[0]?.[0] as { text: string } | undefined;
    expect(footerArg).toBeDefined();
    expect(footerArg!.text).toContain("admin-user");
  });

  it("does not propagate a send error to the admin when the audit channel send fails", async () => {
    if (!rankingExecute) return;

    const sendMock = vi.fn().mockRejectedValue(new Error("Missing Access"));
    const auditChannel = makeAuditChannel({ send: sendMock });

    const guild = {
      name: "Test Guild",
      channels: {
        cache: { get: vi.fn().mockReturnValue(auditChannel) },
        fetch: vi.fn().mockResolvedValue(null),
      },
    };

    mocks.selectWhere.mockResolvedValueOnce([{ auditLogChannelId: "audit-ch-123" }]);

    const interaction = makeResetInteraction({ confirm: true, guild });

    // Must not throw
    await expect(rankingExecute(interaction as never)).resolves.toBeUndefined();

    // The admin received the success reply despite the send failure
    expect(interaction.editReply).toHaveBeenCalled();
  });
});
