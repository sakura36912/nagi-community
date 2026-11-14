/**
 * Tests for handleTicketCreate, handleTicketOpen, and TICKET_DEFAULTS.
 *
 * Confirms that:
 *   (a) When welcomeEmbedTitle and welcomeMessage are configured in guild
 *       ticket settings, the welcome embed uses those values.
 *   (b) When no custom settings exist the embed falls back to TICKET_DEFAULTS
 *       ("🎫 サポートチケット" / "用件をお書きください。スタッフが対応します。").
 *   (c) Per-panel welcomeEmbedTitle / welcomeMessage override the guild-level
 *       settings when a panelId is supplied and the panel belongs to the same
 *       guild (guild-scoping guard).
 *   (d) A panel row from a different guild is silently ignored — the embed
 *       falls back to guild-level settings (or defaults), never showing
 *       content from a foreign guild's panel.
 *   (e) handleTicketOpen wires the full flow: reads settings, creates a
 *       ticket channel, records the ticket in the DB, and calls channel.send
 *       with an embed that carries the configured title and description.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock state ─────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  // ── db.select chain ──────────────────────────────────────────────────────────
  const selectWhere = vi.fn().mockResolvedValue([]);
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  // ── db.insert chain ──────────────────────────────────────────────────────────
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const onConflictDoNothing = vi.fn().mockResolvedValue([]);
  const insertReturning = vi.fn().mockResolvedValue([{ id: 1, guildId: "g", channelId: "ch-1", userId: "u-1", createdAt: new Date() }]);
  const insertValues = vi.fn(() => ({
    onConflictDoUpdate,
    onConflictDoNothing,
    returning: insertReturning,
  }));
  const insert = vi.fn(() => ({ values: insertValues }));

  // ── db.delete chain ──────────────────────────────────────────────────────────
  const del = vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })) }));

  // ── Captured EmbedBuilder call arguments ─────────────────────────────────────
  const setTitle       = vi.fn().mockReturnThis();
  const setDescription = vi.fn().mockReturnThis();
  const setColor       = vi.fn().mockReturnThis();
  const embedInstance  = { setTitle, setDescription, setColor, data: {} };

  // ── Mock Discord channel (returned by guild.channels.create) ─────────────────
  const channelSend = vi.fn().mockResolvedValue({ id: "msg-1" });
  const mockChannel = { id: "ch-1", send: channelSend };

  // ── Mock guild ───────────────────────────────────────────────────────────────
  const guildChannelsCreate = vi.fn().mockResolvedValue(mockChannel);
  const mockGuild = {
    id: "guild-123",
    channels: { create: guildChannelsCreate },
  };

  return {
    selectWhere, selectFrom, select,
    onConflictDoUpdate, onConflictDoNothing, insertReturning, insertValues, insert,
    del,
    setTitle, setDescription, setColor, embedInstance,
    channelSend, mockChannel,
    guildChannelsCreate, mockGuild,
  };
});

// ─── Mock @workspace/db ───────────────────────────────────────────────────────
vi.mock("@workspace/db", () => {
  const tbl = (name: string) =>
    new Proxy({} as Record<string, string>, {
      get: (_t, p: string) => `${name}.${p}`,
    });

  return {
    PET_RARITIES: ["normal", "rare", "epic", "legend", "mythic"],
    PET_RARITY_NAMES: { normal: "normal", rare: "rare", epic: "epic", legend: "レジェンド", mythic: "ミシック" },
    PET_SETTING_LABELS: { level_cap: "level cap" },
    PROFILE_FIELD_LABELS: { bounty: "bounty" },
    PROFILE_RANK_LABELS: { regular: "regular", vip: "vip", vip_plus: "vip+", special: "special" },
    db: {
      select: mocks.select,
      insert: mocks.insert,
      delete: mocks.del,
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })) })) })),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
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
    EmbedBuilder: vi.fn().mockImplementation(() => mocks.embedInstance),
    ActionRowBuilder: vi.fn().mockImplementation(() => ({
      addComponents: vi.fn().mockReturnThis(),
    })),
    ButtonBuilder: vi.fn().mockImplementation(() => ({
      setCustomId: vi.fn().mockReturnThis(),
      setLabel:    vi.fn().mockReturnThis(),
      setStyle:    vi.fn().mockReturnThis(),
      setDisabled: vi.fn().mockReturnThis(),
    })),
  };
});

// ─── Imports under test (resolved after mocks) ───────────────────────────────
import {
  handleTicketCreate,
  handleTicketOpen,
  TICKET_DEFAULTS,
  COMM_TICKET_CREATE_PREFIX,
} from "../commands/index.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Arrange the db.select mock to return the given ticket settings row
 * for the first select call (getTicketSettings) and nothing for further calls.
 */
function mockTicketSettings(row: Partial<{
  guildId: string;
  staffRoleId: string | null;
  categoryId: string | null;
  channelNamePrefix: string | null;
  welcomeMessage: string | null;
  welcomeEmbedTitle: string | null;
}> | null) {
  mocks.selectWhere.mockResolvedValueOnce(row ? [row] : []);
}

/**
 * Arrange both select calls when a panelId is supplied:
 *   call 1 → getTicketSettings (guild-level)
 *   call 2 → getTicketPanel (panel-level)
 */
function mockTicketSettingsAndPanel(
  settings: Partial<{
    guildId: string;
    welcomeMessage: string | null;
    welcomeEmbedTitle: string | null;
  }> | null,
  panel: Partial<{
    id: number;
    guildId: string;
    welcomeMessage: string | null;
    welcomeEmbedTitle: string | null;
  }> | null,
) {
  mocks.selectWhere.mockResolvedValueOnce(settings ? [settings] : []);
  mocks.selectWhere.mockResolvedValueOnce(panel ? [panel] : []);
}

/**
 * Build a minimal ButtonInteraction stub for handleTicketOpen.
 * panelId=undefined → no suffix (guild-default settings, no panel).
 */
function makeTicketOpenInteraction(opts: {
  guildId?: string;
  panelId?: number | null;
  username?: string;
}) {
  const { guildId = "guild-123", panelId, username = "testuser" } = opts;
  const suffix = panelId != null ? String(panelId) : "";
  return {
    guildId,
    guild: mocks.mockGuild,
    customId: `${COMM_TICKET_CREATE_PREFIX}${suffix}`,
    user: { id: "user-123", username },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply:  vi.fn().mockResolvedValue(undefined),
    reply:      vi.fn().mockResolvedValue(undefined),
  };
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Re-wire mock chains after clearAllMocks
  mocks.selectFrom.mockReturnValue({ where: mocks.selectWhere });
  mocks.select.mockReturnValue({ from: mocks.selectFrom });
  mocks.selectWhere.mockResolvedValue([]);

  mocks.insertValues.mockReturnValue({
    onConflictDoUpdate: mocks.onConflictDoUpdate,
    onConflictDoNothing: mocks.onConflictDoNothing,
    returning: mocks.insertReturning,
  });
  mocks.insert.mockReturnValue({ values: mocks.insertValues });

  // Re-wire the embed instance methods (clearAllMocks resets mockReturnThis)
  mocks.setTitle.mockReturnValue(mocks.embedInstance);
  mocks.setDescription.mockReturnValue(mocks.embedInstance);
  mocks.setColor.mockReturnValue(mocks.embedInstance);

  // Re-wire channel create / send
  mocks.channelSend.mockResolvedValue({ id: "msg-1" });
  mocks.guildChannelsCreate.mockResolvedValue(mocks.mockChannel);
});

// ─── Tests: TICKET_DEFAULTS ───────────────────────────────────────────────────

describe("TICKET_DEFAULTS", () => {
  it("exports the expected default embed title", () => {
    expect(TICKET_DEFAULTS.embedTitle).toBe("🎫 サポートチケット");
  });

  it("exports the expected default message", () => {
    expect(TICKET_DEFAULTS.message).toBe("用件をお書きください。スタッフが対応します。");
  });
});

// ─── Tests: handleTicketCreate – defaults ─────────────────────────────────────

describe("handleTicketCreate – defaults when no settings row exists", () => {
  it("uses the default embed title when no settings row is present", async () => {
    mockTicketSettings(null);
    await handleTicketCreate("guild-123");
    expect(mocks.setTitle).toHaveBeenCalledWith(TICKET_DEFAULTS.embedTitle);
  });

  it("uses the default message when no settings row is present", async () => {
    mockTicketSettings(null);
    await handleTicketCreate("guild-123");
    expect(mocks.setDescription).toHaveBeenCalledWith(TICKET_DEFAULTS.message);
  });

  it("uses the default embed title when the settings row has null welcomeEmbedTitle", async () => {
    mockTicketSettings({ guildId: "guild-123", welcomeEmbedTitle: null, welcomeMessage: null });
    await handleTicketCreate("guild-123");
    expect(mocks.setTitle).toHaveBeenCalledWith(TICKET_DEFAULTS.embedTitle);
  });

  it("uses the default message when the settings row has null welcomeMessage", async () => {
    mockTicketSettings({ guildId: "guild-123", welcomeEmbedTitle: null, welcomeMessage: null });
    await handleTicketCreate("guild-123");
    expect(mocks.setDescription).toHaveBeenCalledWith(TICKET_DEFAULTS.message);
  });
});

// ─── Tests: handleTicketCreate – guild-level custom settings ─────────────────

describe("handleTicketCreate – guild-level custom settings", () => {
  it("uses the configured welcomeEmbedTitle instead of the default", async () => {
    mockTicketSettings({
      guildId: "guild-123",
      welcomeEmbedTitle: "🛠️ カスタムタイトル",
      welcomeMessage: null,
    });
    await handleTicketCreate("guild-123");
    expect(mocks.setTitle).toHaveBeenCalledWith("🛠️ カスタムタイトル");
  });

  it("does NOT use the default embed title when a custom one is configured", async () => {
    mockTicketSettings({
      guildId: "guild-123",
      welcomeEmbedTitle: "🛠️ カスタムタイトル",
      welcomeMessage: null,
    });
    await handleTicketCreate("guild-123");
    expect(mocks.setTitle).not.toHaveBeenCalledWith(TICKET_DEFAULTS.embedTitle);
  });

  it("uses the configured welcomeMessage instead of the default", async () => {
    mockTicketSettings({
      guildId: "guild-123",
      welcomeEmbedTitle: null,
      welcomeMessage: "カスタムメッセージです。",
    });
    await handleTicketCreate("guild-123");
    expect(mocks.setDescription).toHaveBeenCalledWith("カスタムメッセージです。");
  });

  it("does NOT use the default message when a custom one is configured", async () => {
    mockTicketSettings({
      guildId: "guild-123",
      welcomeEmbedTitle: null,
      welcomeMessage: "カスタムメッセージです。",
    });
    await handleTicketCreate("guild-123");
    expect(mocks.setDescription).not.toHaveBeenCalledWith(TICKET_DEFAULTS.message);
  });

  it("uses both custom title and custom message when both are set", async () => {
    mockTicketSettings({
      guildId: "guild-123",
      welcomeEmbedTitle: "🎟️ お問い合わせ",
      welcomeMessage: "ご用件をどうぞ。",
    });
    await handleTicketCreate("guild-123");
    expect(mocks.setTitle).toHaveBeenCalledWith("🎟️ お問い合わせ");
    expect(mocks.setDescription).toHaveBeenCalledWith("ご用件をどうぞ。");
  });
});

// ─── Tests: handleTicketCreate – panel overrides ──────────────────────────────

describe("handleTicketCreate – per-panel overrides", () => {
  it("panel welcomeEmbedTitle overrides the guild-level setting", async () => {
    mockTicketSettingsAndPanel(
      { guildId: "g", welcomeEmbedTitle: "ギルドタイトル", welcomeMessage: null },
      { id: 1, guildId: "g", welcomeEmbedTitle: "パネルタイトル", welcomeMessage: null },
    );
    await handleTicketCreate("g", 1);
    expect(mocks.setTitle).toHaveBeenCalledWith("パネルタイトル");
  });

  it("panel welcomeMessage overrides the guild-level setting", async () => {
    mockTicketSettingsAndPanel(
      { guildId: "g", welcomeEmbedTitle: null, welcomeMessage: "ギルドメッセージ" },
      { id: 1, guildId: "g", welcomeEmbedTitle: null, welcomeMessage: "パネルメッセージ" },
    );
    await handleTicketCreate("g", 1);
    expect(mocks.setDescription).toHaveBeenCalledWith("パネルメッセージ");
  });

  it("falls back to guild setting when panel welcomeEmbedTitle is null", async () => {
    mockTicketSettingsAndPanel(
      { guildId: "g", welcomeEmbedTitle: "ギルドタイトル", welcomeMessage: null },
      { id: 1, guildId: "g", welcomeEmbedTitle: null, welcomeMessage: null },
    );
    await handleTicketCreate("g", 1);
    expect(mocks.setTitle).toHaveBeenCalledWith("ギルドタイトル");
  });

  it("falls back to guild setting when panel welcomeMessage is null", async () => {
    mockTicketSettingsAndPanel(
      { guildId: "g", welcomeEmbedTitle: null, welcomeMessage: "ギルドメッセージ" },
      { id: 1, guildId: "g", welcomeEmbedTitle: null, welcomeMessage: null },
    );
    await handleTicketCreate("g", 1);
    expect(mocks.setDescription).toHaveBeenCalledWith("ギルドメッセージ");
  });

  it("falls back to defaults when both panel and guild settings are null", async () => {
    mockTicketSettingsAndPanel(
      { guildId: "g", welcomeEmbedTitle: null, welcomeMessage: null },
      { id: 1, guildId: "g", welcomeEmbedTitle: null, welcomeMessage: null },
    );
    await handleTicketCreate("g", 1);
    expect(mocks.setTitle).toHaveBeenCalledWith(TICKET_DEFAULTS.embedTitle);
    expect(mocks.setDescription).toHaveBeenCalledWith(TICKET_DEFAULTS.message);
  });

  it("does not query the panel table when panelId is omitted", async () => {
    mockTicketSettings(null);
    await handleTicketCreate("guild-no-panel");
    // Called exactly once (for getTicketSettings only)
    expect(mocks.selectWhere).toHaveBeenCalledTimes(1);
  });

  it("queries the panel table when panelId is provided", async () => {
    mockTicketSettingsAndPanel(null, null);
    await handleTicketCreate("g", 99);
    // Called twice: once for getTicketSettings, once for getTicketPanel
    expect(mocks.selectWhere).toHaveBeenCalledTimes(2);
  });
});

// ─── Tests: handleTicketCreate – guild-scoping guard ─────────────────────────

describe("handleTicketCreate – guild-scoping guard (cross-guild panel isolation)", () => {
  it("ignores a panel whose guildId does not match the requesting guild", async () => {
    // Panel belongs to guild-B but the ticket is being opened in guild-A
    mockTicketSettingsAndPanel(
      { guildId: "guild-A", welcomeEmbedTitle: "ギルドAタイトル", welcomeMessage: null },
      { id: 1, guildId: "guild-B", welcomeEmbedTitle: "パネルBタイトル", welcomeMessage: "パネルBメッセージ" },
    );
    await handleTicketCreate("guild-A", 1);
    // Must use guild-A's own title, NOT the foreign panel's title
    expect(mocks.setTitle).toHaveBeenCalledWith("ギルドAタイトル");
    expect(mocks.setTitle).not.toHaveBeenCalledWith("パネルBタイトル");
  });

  it("does not expose a foreign panel's welcomeMessage in the local guild's ticket", async () => {
    mockTicketSettingsAndPanel(
      { guildId: "guild-A", welcomeEmbedTitle: null, welcomeMessage: "ギルドAメッセージ" },
      { id: 2, guildId: "guild-X", welcomeEmbedTitle: null, welcomeMessage: "パネルXメッセージ" },
    );
    await handleTicketCreate("guild-A", 2);
    expect(mocks.setDescription).toHaveBeenCalledWith("ギルドAメッセージ");
    expect(mocks.setDescription).not.toHaveBeenCalledWith("パネルXメッセージ");
  });

  it("falls back all the way to TICKET_DEFAULTS when foreign panel and no guild settings", async () => {
    // Panel from guild-B, no settings row for guild-A
    mockTicketSettingsAndPanel(
      null,
      { id: 3, guildId: "guild-B", welcomeEmbedTitle: "B専用タイトル", welcomeMessage: "B専用メッセージ" },
    );
    await handleTicketCreate("guild-A", 3);
    expect(mocks.setTitle).toHaveBeenCalledWith(TICKET_DEFAULTS.embedTitle);
    expect(mocks.setDescription).toHaveBeenCalledWith(TICKET_DEFAULTS.message);
  });

  it("applies a same-guild panel's overrides correctly (baseline positive case)", async () => {
    mockTicketSettingsAndPanel(
      { guildId: "guild-A", welcomeEmbedTitle: "ギルドAタイトル", welcomeMessage: null },
      { id: 4, guildId: "guild-A", welcomeEmbedTitle: "パネルAタイトル", welcomeMessage: "パネルAメッセージ" },
    );
    await handleTicketCreate("guild-A", 4);
    expect(mocks.setTitle).toHaveBeenCalledWith("パネルAタイトル");
    expect(mocks.setDescription).toHaveBeenCalledWith("パネルAメッセージ");
  });
});

// ─── Tests: handleTicketOpen – full flow integration ─────────────────────────

describe("handleTicketOpen – full flow: setup → create → embed sent in channel", () => {
  it("creates a ticket channel and sends the welcome embed with configured custom title", async () => {
    // Admin previously ran /ticket setup with a custom welcome title
    mockTicketSettings({
      guildId: "guild-123",
      welcomeEmbedTitle: "🎫 お問い合わせ窓口",
      welcomeMessage: "担当スタッフが間もなく対応します。",
      categoryId: null,
      staffRoleId: null,
      channelNamePrefix: "ticket",
    });

    const interaction = makeTicketOpenInteraction({ guildId: "guild-123" });
    await handleTicketOpen(interaction as never);

    // The welcome embed must use the custom title
    expect(mocks.setTitle).toHaveBeenCalledWith("🎫 お問い合わせ窓口");
    // …and the custom message
    expect(mocks.setDescription).toHaveBeenCalledWith("担当スタッフが間もなく対応します。");
    // The embed must have been sent into the new channel
    expect(mocks.channelSend).toHaveBeenCalledWith(
      expect.objectContaining({ embeds: expect.arrayContaining([mocks.embedInstance]) }),
    );
  });

  it("sends the default embed when no custom settings have been configured", async () => {
    mockTicketSettings(null); // no settings row → use defaults

    const interaction = makeTicketOpenInteraction({ guildId: "guild-123" });
    await handleTicketOpen(interaction as never);

    expect(mocks.setTitle).toHaveBeenCalledWith(TICKET_DEFAULTS.embedTitle);
    expect(mocks.setDescription).toHaveBeenCalledWith(TICKET_DEFAULTS.message);
    expect(mocks.channelSend).toHaveBeenCalledWith(
      expect.objectContaining({ embeds: expect.arrayContaining([mocks.embedInstance]) }),
    );
  });

  it("does NOT send the default title when a custom title is configured", async () => {
    mockTicketSettings({
      guildId: "guild-123",
      welcomeEmbedTitle: "カスタムタイトル",
      welcomeMessage: null,
      categoryId: null,
      staffRoleId: null,
    });

    const interaction = makeTicketOpenInteraction({ guildId: "guild-123" });
    await handleTicketOpen(interaction as never);

    expect(mocks.setTitle).not.toHaveBeenCalledWith(TICKET_DEFAULTS.embedTitle);
  });

  it("creates the ticket channel via guild.channels.create", async () => {
    mockTicketSettings(null);

    const interaction = makeTicketOpenInteraction({ guildId: "guild-123" });
    await handleTicketOpen(interaction as never);

    expect(mocks.guildChannelsCreate).toHaveBeenCalledTimes(1);
  });

  it("records the ticket in the DB by calling createTicket (insert)", async () => {
    mockTicketSettings(null);

    const interaction = makeTicketOpenInteraction({ guildId: "guild-123" });
    await handleTicketOpen(interaction as never);

    // createTicket does db.insert(...).values(...).returning()
    expect(mocks.insert).toHaveBeenCalled();
    expect(mocks.insertValues).toHaveBeenCalled();
  });

  it("replies ephemerally to confirm the ticket channel was created", async () => {
    mockTicketSettings(null);

    const interaction = makeTicketOpenInteraction({ guildId: "guild-123" });
    await handleTicketOpen(interaction as never);

    expect(interaction.deferReply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("ch-1"),
    );
  });

  it("rejects the interaction with an ephemeral error when guildId is missing", async () => {
    const interaction = {
      guildId: null,
      guild: null,
      customId: `${COMM_TICKET_CREATE_PREFIX}`,
      user: { id: "u", username: "u" },
      reply: vi.fn().mockResolvedValue(undefined),
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
    };
    await handleTicketOpen(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    expect(mocks.channelSend).not.toHaveBeenCalled();
  });
});
