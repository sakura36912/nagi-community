/**
 * Confirms that the shop-buy VC extend path silently skips the panel refresh
 * when the VC channel no longer exists (not in cache, fetch returns null).
 *
 * Coverage targets:
 *   - handleShopBuyButton: VC extend branch, channel absent → no panel edit,
 *     success reply still sent, no throw.
 *   - applyShopPurchase (via handleShopSelectMenu): same guarantee.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import { PermissionFlagsBits } from "discord.js";

// ─── Hoist mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  getShopItem:                vi.fn(),
  getGuildSettings:           vi.fn(),
  getActivePrivateVcSession:  vi.fn(),
  buyItem:                    vi.fn(),
  addShopItem:                vi.fn(),
  listShopItems:              vi.fn(),
  extendPrivateVcSession:     vi.fn(),
  refundPurchase:             vi.fn(),
  extendOrRepairVcSchedule:   vi.fn(),
  loggerInfo:                 vi.fn(),
  loggerWarn:                 vi.fn(),
  loggerError:                vi.fn(),
}));

vi.mock("../lib/economy.js", () => ({
  // ── Spied functions ─────────────────────────────────────────────────────
  getShopItem:               mocks.getShopItem,
  getGuildSettings:          mocks.getGuildSettings,
  getActivePrivateVcSession: mocks.getActivePrivateVcSession,
  buyItem:                   mocks.buyItem,
  addShopItem:               mocks.addShopItem,
  listShopItems:             mocks.listShopItems,
  extendPrivateVcSession:    mocks.extendPrivateVcSession,
  // ── Constants ────────────────────────────────────────────────────────────
  VC_EXTEND_DURATIONS:       { vc_extend_1d: 86_400_000 },
  DEFAULT_DAILY_AMOUNT:      500,
  NICKNAME_CHANGE_EFFECT:    "nickname_change",
  PRIVATE_VC_EFFECT:         "private_vc",
  PRIVATE_VC_3H_EFFECT:      "private_vc_3h",
  PRIVATE_VC_6H_EFFECT:      "private_vc_6h",
  PRIVATE_VC_9H_EFFECT:      "private_vc_9h",
  PRIVATE_VC_1D_EFFECT:      "private_vc_1d",
  PRIVATE_VC_3D_EFFECT:      "private_vc_3d",
  PRIVATE_VC_1W_EFFECT:      "private_vc_1w",
  PRIVATE_VC_1M_EFFECT:      "private_vc_1m",
  VC_RENAME_EFFECT:          "vc_rename",
  VC_EXTEND_1D_EFFECT:       "vc_extend_1d",
  EVAL_EXTEND_DAYS:          {},
  EVAL_EXTEND_EFFECT:        "eval_extend_1w",
  EVAL_EXTEND_2W_EFFECT:     "eval_extend_2w",
  EVAL_EXTEND_1M_EFFECT:     "eval_extend_1m",
  PERM_ROLE_EFFECT:          "perm_role",
  EVAL_RESURFACE_EFFECT:     "eval_resurface",
  SHOP_LICENSE_EFFECT:       "shop_license",
  TIMED_VC_DURATIONS:        {},
  // ── Stubs (not under test) ───────────────────────────────────────────────
  extendCommunitySheet:      vi.fn(),
  getLatestEvalSheet:        vi.fn(),
  hasUsedEvalExtension:      vi.fn(),
  createEvalSheet:           vi.fn(),
  getEvalSheetSettings:      vi.fn(),
  getSheetVcSeconds:         vi.fn(),
  setShopLicenseConfig:      vi.fn(),
  listShopLicenseConfigs:    vi.fn(),
  getShopLicenseForUser:     vi.fn(),
  recordGroupShopSale:       vi.fn(),
  getGroupShopSalesSummary:  vi.fn(),
  setVcCategoryId:           vi.fn(),
  createOrUpdateCurrency:    vi.fn(),
  createPrivateVcSession:    vi.fn(),
  depositToTreasury:         vi.fn(),
  getTreasuriesByRoles:      vi.fn(),
  giveToCrunchTreasury:      vi.fn(),
  updateShopItemPrice:       vi.fn(),
  updateShopItemRole:        vi.fn(),
  getLeaderboard:            vi.fn(),
  getOrCreateWallet:         vi.fn(),
  getSquadTreasury:          vi.fn(),
  giveCurrency:              vi.fn(),
  listInventory:             vi.fn(),
  listRoleRewards:           vi.fn(),
  listSquadTreasuries:       vi.fn(),
  refundPurchase:            mocks.refundPurchase,
  removeRoleReward:          vi.fn(),
  removeShopItem:            vi.fn(),
  setRewardDayOfMonth:       vi.fn(),
  setRewardInterval:         vi.fn(),
  setRoleReward:             vi.fn(),
  transfer:                  vi.fn(),
  getPrivateVcSessionByChannelId: vi.fn(),
  distributeRoleRewards:     vi.fn(),
  getGuildWalletUserIds:     vi.fn(),
}));

vi.mock("../lib/vcScheduleRepair.js", () => ({
  extendOrRepairVcSchedule: mocks.extendOrRepairVcSchedule,
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info:  mocks.loggerInfo,
    warn:  mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

vi.mock("../lib/sheet.js", () => ({
  applySheetEmbedUpdate:    vi.fn(),
  buildSheetEmbed:          vi.fn(),
  buildSheetThreadName:     vi.fn(),
  findSelfIntro:            vi.fn(),
  refreshSheetEmbedForUser: vi.fn(),
}));

vi.mock("../lib/vc.js", () => ({
  saveSchedule: vi.fn(),
}));

vi.mock("../lib/vcReward.js", () => ({
  getVcPresence:             vi.fn(),
  getTodayChestVcSeconds:    vi.fn(),
  getTodayChestOpensCount:   vi.fn(),
  hasTodayChestOpened:       vi.fn(),
  markChestOpenedToday:      vi.fn(),
  incrementChestOpensToday:  vi.fn(),
  addChestVcSeconds:         vi.fn(),
}));

vi.mock("../lib/chestTracker.js", () => ({
  getCurrentTavernSeconds: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  upsertTimedRoleGrant: vi.fn(),
  db:                   {},
  vcSessionLogsTable:   {},
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────
import {
  buildVcPanelMessage,
  buildLuxuryVcKickSelector,
  collectFreeRoomAccessRoleIds,
  commands,
  getChestOpenProgress,
  getPrivateVcRoomCategory,
  handleShopBuyButton,
  handleVcPanelAddBtn,
  hasLuxuryVcBlockedRole,
  handleShopSelectMenu,
  isBlockedFromLuxuryVcAdd,
  isEligibleForLuxuryVcAdd,
  isFreeRoomCategory,
  kickPrivateVcMember,
  refreshPrivateVcPanelMessage,
  SHOP_BUY_PREFIX,
  SHOP_SELECT_ID,
} from "../commands/index.js";

// ─── Constants ────────────────────────────────────────────────────────────────
const GUILD_ID    = "guild-001";
const USER_ID     = "user-111";
const BOT_ID      = "bot-999";
const CHANNEL_ID  = "ch-555";
const SESSION_ID  = 5;
const ITEM_ID     = 10;
const ONE_DAY_MS  = 24 * 60 * 60 * 1000;

const EXPIRES_AT  = new Date("2099-07-01T12:00:00Z");
const EXTENDED_AT = new Date("2099-07-02T12:00:00Z");

describe("treasure chest hourly carry-over", () => {
  it("carries over 30 minutes after opening at 1 hour 30 minutes", () => {
    const progress = getChestOpenProgress(90 * 60, 0);

    expect(progress.canOpen).toBe(true);
    expect(progress.nextCheckpointSeconds).toBe(60 * 60);
    expect(progress.elapsedSeconds - 60 * 60).toBe(30 * 60);
  });

  it("keeps 1 hour 30 minutes available after opening once at 2 hours 30 minutes", () => {
    const firstOpen = getChestOpenProgress(150 * 60, 0);
    const secondOpen = getChestOpenProgress(150 * 60, firstOpen.nextCheckpointSeconds);

    expect(firstOpen.nextCheckpointSeconds).toBe(60 * 60);
    expect(secondOpen.canOpen).toBe(true);
    expect(secondOpen.elapsedSeconds).toBe(90 * 60);
    expect(secondOpen.nextCheckpointSeconds).toBe(2 * 60 * 60);
  });
});

describe("island shop category", () => {
  const shopCommand = commands.find((command) => command.data.name === "shop")!;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers the island category for list, add, and panel", () => {
    const definition = shopCommand.data.toJSON() as {
      options?: Array<{
        name?: string;
        options?: Array<{
          name?: string;
          choices?: Array<{ name?: string; value?: string }>;
        }>;
      }>;
    };

    for (const subcommandName of ["list", "add", "panel"]) {
      const subcommand = definition.options?.find((option) => option.name === subcommandName);
      const categoryOption = subcommand?.options?.find((option) => option.name === "category");
      expect(categoryOption?.choices).toContainEqual({
        name: "🏝️ オチテモータ島ショップ",
        value: "island",
      });
    }
  });

  it("passes the island category to listShopItems for /shop list", async () => {
    const item = {
      id: ITEM_ID,
      guildId: GUILD_ID,
      name: "島の商品",
      description: "島限定",
      price: 500,
      effectType: null,
      category: "island",
      targetRoleId: null,
      sortOrder: 0,
    };
    mocks.listShopItems.mockResolvedValue([item]);
    mocks.getGuildSettings.mockResolvedValue(makeSettings());

    const interaction = {
      guildId: GUILD_ID,
      options: {
        getSubcommand: () => "list",
        getString: () => "island",
      },
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await shopCommand.execute(interaction as never);

    expect(mocks.listShopItems).toHaveBeenCalledWith(GUILD_ID, "island");
    expect(interaction.reply).toHaveBeenCalledOnce();
    expect(interaction.reply.mock.calls[0][0].embeds[0].data.title)
      .toBe("🏝️ オチテモータ島ショップ");
  });

  it("stores island items with the island category for /shop add", async () => {
    const item = {
      id: ITEM_ID,
      guildId: GUILD_ID,
      name: "島の商品",
      description: "島限定",
      price: 500,
      effectType: null,
      category: "island",
      targetRoleId: null,
      sortOrder: 0,
    };
    mocks.addShopItem.mockResolvedValue(item);
    mocks.getGuildSettings.mockResolvedValue(makeSettings());

    const interaction = {
      guildId: GUILD_ID,
      memberPermissions: { has: () => true },
      options: {
        getSubcommand: () => "add",
        getString: (name: string) => ({
          category: "island",
          name: "島の商品",
          description: "島限定",
          effect: null,
        })[name] ?? null,
        getInteger: () => 500,
        getRole: () => null,
      },
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await shopCommand.execute(interaction as never);

    expect(mocks.addShopItem).toHaveBeenCalledWith(
      GUILD_ID,
      "島の商品",
      500,
      "島限定",
      null,
      "island",
      null,
    );
  });

  it("posts an island-only panel for /shop panel", async () => {
    const item = {
      id: ITEM_ID,
      guildId: GUILD_ID,
      name: "島の商品",
      description: "島限定",
      price: 500,
      effectType: null,
      category: "island",
      targetRoleId: null,
      sortOrder: 0,
    };
    mocks.listShopItems.mockResolvedValue([item]);
    mocks.getGuildSettings.mockResolvedValue(makeSettings());

    const interaction = {
      guildId: GUILD_ID,
      memberPermissions: { has: () => true },
      options: {
        getSubcommand: () => "panel",
        getString: () => "island",
      },
      channel: { send: vi.fn().mockResolvedValue(undefined) },
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await shopCommand.execute(interaction as never);

    expect(mocks.listShopItems).toHaveBeenCalledWith(GUILD_ID, "island");
    expect(interaction.channel.send).toHaveBeenCalledOnce();
    expect(interaction.channel.send.mock.calls[0][0].embeds[0].data.title)
      .toBe("🏝️ オチテモータ島ショップ");
  });
});

describe("private VC panel category separation", () => {
  it("limits luxury-room additions to 本船員・漂流者・新入り", () => {
    expect(isEligibleForLuxuryVcAdd(["一般メンバー", "本船員"])).toBe(true);
    expect(isEligibleForLuxuryVcAdd(["一般メンバー", "漂流者"])).toBe(true);
    expect(isEligibleForLuxuryVcAdd(["一般メンバー", "新入り"])).toBe(true);
    expect(isEligibleForLuxuryVcAdd(["一般メンバー"])).toBe(false);
    expect(isEligibleForLuxuryVcAdd(["追放者"])).toBe(false);
    expect(isEligibleForLuxuryVcAdd(["本船員", "追放者"])).toBe(false);
    expect(isEligibleForLuxuryVcAdd(["漂流者", "追放者"])).toBe(false);

    expect(isBlockedFromLuxuryVcAdd(["一般メンバー", "追放者"])).toBe(true);
    expect(isBlockedFromLuxuryVcAdd(["一般メンバー", "本船員"])).toBe(false);
    expect(hasLuxuryVcBlockedRole(["本船員", "追放者"])).toBe(true);
    expect(hasLuxuryVcBlockedRole(["本船員"])).toBe(false);
  });

  it("opens a native searchable member selector without pagination", async () => {
    const interaction = {
      guild: { id: GUILD_ID },
      user: { id: USER_ID },
      client: { user: { id: BOT_ID } },
      customId: `vc:panel:add:${CHANNEL_ID}:${USER_ID}`,
      reply: vi.fn().mockResolvedValue(undefined),
    };

    await handleVcPanelAddBtn(interaction as never);

    const reply = interaction.reply.mock.calls[0]?.[0];
    expect(reply.content).toContain("ニックネームで検索できます");
    expect(reply.components).toHaveLength(1);
    expect(reply.components[0].components[0].toJSON()).toMatchObject({
      type: 5,
      custom_id: `vc:panel:adds:${CHANNEL_ID}:${USER_ID}`,
      min_values: 1,
      max_values: 1,
    });
  });

  it("grants free-room access to the island-resurface role", () => {
    expect(collectFreeRoomAccessRoleIds([
      { id: "captain", name: "追放者" },
      { id: "resurface", name: "オチテモータ島浮上券" },
      { id: "member", name: "一般メンバー" },
    ])).toEqual(["captain", "resurface"]);

    expect(collectFreeRoomAccessRoleIds(
      [{ id: "captain", name: "追放者" }],
      "configured-resurface-role",
    )).toEqual(["captain", "configured-resurface-role"]);
  });

  it("keeps both current and legacy free-room categories out of the luxury-room classification", () => {
    expect(getPrivateVcRoomCategory("island")).toBe("island");
    expect(getPrivateVcRoomCategory("ura")).toBe("ura");
    expect(getPrivateVcRoomCategory("vc")).toBe("vc");
    expect(getPrivateVcRoomCategory("unknown")).toBe("vc");

    expect(isFreeRoomCategory("island")).toBe(true);
    expect(isFreeRoomCategory("ura")).toBe(true);
    expect(isFreeRoomCategory("vc")).toBe(false);
  });

  it("renders distinct panel titles and luxury-only member controls", () => {
    const freeRoomPanel = buildVcPanelMessage("channel-free", "owner", undefined, [], false, true);
    const luxuryPanel = buildVcPanelMessage("channel-luxury", "owner", undefined, [], false, false);
    const populatedLuxuryPanel = buildVcPanelMessage(
      "channel-luxury",
      "owner",
      undefined,
      ["member-a"],
      false,
      false,
    );

    expect(freeRoomPanel.embeds[0]?.data.title).toBe("フリールームコントロールパネル");
    expect(luxuryPanel.embeds[0]?.data.title).toBe("🔒 高級船室 コントロールパネル");
    expect(freeRoomPanel.embeds[0]?.data.description).not.toContain("アクセス中のメンバー");
    expect(luxuryPanel.embeds[0]?.data.description).toContain("アクセス中のメンバー");

    const freeButtonIds = freeRoomPanel.components.flatMap((row) =>
      row.components.map((component) => (component.data as { custom_id?: string }).custom_id),
    );
    const luxuryButtonIds = luxuryPanel.components.flatMap((row) =>
      row.components.map((component) => (component.data as { custom_id?: string }).custom_id),
    );
    expect(freeButtonIds.some((id) => id?.includes(":add:"))).toBe(false);
    expect(freeButtonIds.some((id) => id?.includes(":kick:"))).toBe(false);
    expect(luxuryButtonIds.some((id) => id?.includes(":add:"))).toBe(true);
    expect(luxuryButtonIds.some((id) => id?.includes(":kick:"))).toBe(true);
    expect(
      luxuryPanel.components[0]?.components.find(
        (component) => (component.data as { label?: string }).label === "キック",
      )?.data.disabled,
    ).toBe(true);
    expect(
      populatedLuxuryPanel.components[0]?.components.find(
        (component) => (component.data as { label?: string }).label === "キック",
      )?.data.disabled,
    ).toBe(false);
  });
});

describe("private VC kick", () => {
  function makeKickContext(options?: {
    connected?: boolean;
    manageChannels?: boolean;
    moveMembers?: boolean;
    deleteError?: Error;
    disconnectError?: Error;
  }) {
    const disconnect = options?.disconnectError
      ? vi.fn().mockRejectedValue(options.disconnectError)
      : vi.fn().mockResolvedValue(undefined);
    const member = {
      voice: {
        channelId: options?.connected === false ? null : CHANNEL_ID,
        disconnect,
      },
    };
    const guild = {
      id: GUILD_ID,
      members: {
        me: { id: BOT_ID },
        fetch: vi.fn().mockResolvedValue(member),
      },
    };
    const deleteOverwrite = options?.deleteError
      ? vi.fn().mockRejectedValue(options.deleteError)
      : vi.fn().mockResolvedValue(undefined);
    const channel = {
      id: CHANNEL_ID,
      permissionsFor: vi.fn().mockReturnValue({
        has: (permission: bigint) => {
          if (permission === PermissionFlagsBits.ManageChannels) {
            return options?.manageChannels !== false;
          }
          if (permission === PermissionFlagsBits.MoveMembers) {
            return options?.moveMembers !== false;
          }
          return false;
        },
      }),
      permissionOverwrites: { delete: deleteOverwrite },
    };
    return { channel, deleteOverwrite, disconnect, guild };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not claim success when MoveMembers is missing for a connected member", async () => {
    const { channel, deleteOverwrite, disconnect, guild } = makeKickContext({ moveMembers: false });

    const result = await kickPrivateVcMember(guild as never, channel as never, USER_ID);

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.message).toContain("メンバーを移動");
    expect(deleteOverwrite).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledOnce();
  });

  it("reports permission-overwrite deletion failures", async () => {
    const { channel, deleteOverwrite, disconnect, guild } = makeKickContext({
      connected: false,
      deleteError: new Error("Missing Permissions"),
    });

    const result = await kickPrivateVcMember(guild as never, channel as never, USER_ID);

    expect(result).toMatchObject({ ok: false });
    expect(deleteOverwrite).toHaveBeenCalledWith(USER_ID);
    expect(disconnect).not.toHaveBeenCalled();
    expect(mocks.loggerError).toHaveBeenCalledOnce();
  });

  it("reports voice disconnect failures after access was removed", async () => {
    const { channel, deleteOverwrite, disconnect, guild } = makeKickContext({
      disconnectError: new Error("Missing Permissions"),
    });

    const result = await kickPrivateVcMember(guild as never, channel as never, USER_ID);

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.message).toContain("アクセス権は取り消しました");
    expect(deleteOverwrite).toHaveBeenCalledWith(USER_ID);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(mocks.loggerError).toHaveBeenCalledOnce();
  });

  it("succeeds only after access removal and required voice disconnect both succeed", async () => {
    const { channel, deleteOverwrite, disconnect, guild } = makeKickContext();

    await expect(kickPrivateVcMember(guild as never, channel as never, USER_ID))
      .resolves.toEqual({ ok: true });
    expect(deleteOverwrite).toHaveBeenCalledWith(USER_ID);
    expect(disconnect).toHaveBeenCalledOnce();
  });
});

describe("private VC kick selector", () => {
  function makeSelectorContext(accessIds: string[]) {
    const accessOverwrites = [
      { id: USER_ID, type: 1, allow: { has: () => true } },
      { id: BOT_ID, type: 1, allow: { has: () => true } },
      ...accessIds.map((id) => ({ id, type: 1, allow: { has: () => true } })),
    ];
    const channel = {
      id: CHANNEL_ID,
      permissionOverwrites: { cache: accessOverwrites },
    };
    const members = new Map(
      accessIds.map((id) => [
        id,
        { id, user: { bot: false, username: `user-${id}` }, displayName: `Member ${id}` },
      ]),
    );
    const guild = {
      channels: {
        cache: new Map([[CHANNEL_ID, channel]]),
        fetch: vi.fn(),
      },
      members: {
        fetch: vi.fn((id: string) => Promise.resolve(members.get(id) ?? null)),
      },
    };
    return { channel, guild };
  }

  it("shows only explicit access members and excludes the owner and bot", async () => {
    const { guild } = makeSelectorContext(["member-a", "member-b"]);

    const selector = await buildLuxuryVcKickSelector(
      guild as never,
      CHANNEL_ID,
      USER_ID,
      BOT_ID,
      0,
    );
    const menu = selector.components[0].toJSON().components[0] as {
      options: Array<{ value: string }>;
    };

    expect(selector.content).toContain("1/1");
    expect(menu.options.map((option) => option.value)).toEqual(["member-a", "member-b"]);
    expect(menu.options).not.toContainEqual(expect.objectContaining({ value: USER_ID }));
    expect(menu.options).not.toContainEqual(expect.objectContaining({ value: BOT_ID }));
  });

  it("paginates access members in groups of 25", async () => {
    const accessIds = Array.from({ length: 26 }, (_, index) => `member-${index}`);
    const { guild } = makeSelectorContext(accessIds);

    const firstPage = await buildLuxuryVcKickSelector(
      guild as never,
      CHANNEL_ID,
      USER_ID,
      BOT_ID,
      0,
    );
    const secondPage = await buildLuxuryVcKickSelector(
      guild as never,
      CHANNEL_ID,
      USER_ID,
      BOT_ID,
      1,
    );

    expect(firstPage.content).toContain("1/2");
    expect(firstPage.components).toHaveLength(2);
    expect(firstPage.components[1].toJSON().components).toHaveLength(1);
    expect(secondPage.content).toContain("2/2");
    expect(secondPage.components[1].toJSON().components[0]).toMatchObject({
      label: "前のページ",
    });
    const firstMenu = firstPage.components[0].toJSON().components[0] as {
      options: Array<{ value: string }>;
    };
    const secondMenu = secondPage.components[0].toJSON().components[0] as {
      options: Array<{ value: string }>;
    };
    expect(firstMenu.options).toHaveLength(25);
    expect(secondMenu.options).toHaveLength(1);
    expect(secondMenu.options[0]?.value).toBe("member-9");
  });

  it("shows a clear empty state when no access member remains", async () => {
    const { guild } = makeSelectorContext([]);

    const selector = await buildLuxuryVcKickSelector(
      guild as never,
      CHANNEL_ID,
      USER_ID,
      BOT_ID,
      0,
    );

    expect(selector.content).toContain("アクセス権を持つメンバーはいません");
    expect(selector.components).toEqual([]);
  });
});

describe("private VC access-list refresh", () => {
  function makeAccessOverwrite(id: string) {
    return {
      id,
      type: 1,
      allow: { has: (permission: bigint) => permission === PermissionFlagsBits.ViewChannel },
    };
  }

  function makeMessageCollection(message?: {
    author: { id: string };
    embeds: Array<{ title: string }>;
    edit: ReturnType<typeof vi.fn>;
  }) {
    return {
      find: (predicate: (candidate: typeof message) => boolean) =>
        message && predicate(message) ? message : undefined,
    };
  }

  it("adds the changed member even before the overwrite cache catches up and finds an old panel", async () => {
    const editPanel = vi.fn().mockResolvedValue(undefined);
    const oldPanel = {
      author: { id: BOT_ID },
      embeds: [{ title: "🔒 高級船室 コントロールパネル" }],
      edit: editPanel,
    };
    const fetchMessages = vi.fn().mockResolvedValue(makeMessageCollection(oldPanel));
    const channel = {
      id: CHANNEL_ID,
      permissionOverwrites: {
        cache: [makeAccessOverwrite("existing-member")],
      },
      messages: { fetch: fetchMessages },
    };

    await expect(refreshPrivateVcPanelMessage(channel as never, {
      channelId: CHANNEL_ID,
      ownerId: USER_ID,
      botId: BOT_ID,
      addedMemberId: "new-member",
      streamEnabled: false,
      category: "vc",
    })).resolves.toBe(true);

    expect(fetchMessages).toHaveBeenCalledWith({ limit: 10, after: "0" });
    expect(fetchMessages).toHaveBeenCalledOnce();
    const description = editPanel.mock.calls[0]?.[0].embeds[0].data.description;
    expect(description).toContain("<@existing-member>");
    expect(description).toContain("<@new-member>");
  });

  it("removes the changed member even while the overwrite remains in cache", async () => {
    const editPanel = vi.fn().mockResolvedValue(undefined);
    const panel = {
      author: { id: BOT_ID },
      embeds: [{ title: "🔒 高級船室 コントロールパネル" }],
      edit: editPanel,
    };
    const channel = {
      id: CHANNEL_ID,
      permissionOverwrites: {
        cache: [
          makeAccessOverwrite("remaining-member"),
          makeAccessOverwrite("removed-member"),
        ],
      },
      messages: {
        fetch: vi.fn().mockResolvedValue(makeMessageCollection(panel)),
      },
    };

    await refreshPrivateVcPanelMessage(channel as never, {
      channelId: CHANNEL_ID,
      ownerId: USER_ID,
      botId: BOT_ID,
      removedMemberId: "removed-member",
      streamEnabled: false,
      category: "vc",
    });

    const description = editPanel.mock.calls[0]?.[0].embeds[0].data.description;
    expect(description).toContain("<@remaining-member>");
    expect(description).not.toContain("<@removed-member>");
  });
});

function makeSession() {
  return {
    id:        SESSION_ID,
    guildId:   GUILD_ID,
    channelId: CHANNEL_ID,
    userId:    USER_ID,
    expiresAt: EXPIRES_AT,
    category:  "vc",
  };
}

function makeExtendItem() {
  return {
    id:          ITEM_ID,
    guildId:     GUILD_ID,
    name:        "非公開VC延長（1日）",
    description: "期限を1日延長します。",
    price:       800,
    effectType:  "vc_extend_1d",
    category:    "vc",
    targetRoleId: null,
    sortOrder:   4,
  };
}

function makeSettings() {
  return { currencyName: "ベリー", vcCategoryId: null };
}

/**
 * Build a ButtonInteraction mock for handleShopBuyButton.
 * Channel cache is empty and channels.fetch returns null to simulate
 * a deleted/unavailable VC channel.
 */
function makeShopBuyBtnInteraction() {
  const fetchChannel = vi.fn().mockResolvedValue(null);

  return {
    guildId: GUILD_ID,
    guild: {
      id:      GUILD_ID,
      members: { fetch: vi.fn().mockResolvedValue({ roles: { cache: { keys: () => [] } } }) },
      channels: {
        cache: new Map(),          // empty — channel not in cache
        fetch: fetchChannel,
      },
      roles: { cache: { some: vi.fn().mockReturnValue(false) } },
    },
    user:     { id: USER_ID },
    customId: `${SHOP_BUY_PREFIX}${ITEM_ID}`,
    client:   { user: { id: BOT_ID } },
    reply:      vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply:  vi.fn().mockResolvedValue(undefined),
    // Not a modal-capable interaction, but the path we test never calls showModal
  };
}

/**
 * Build a StringSelectMenuInteraction mock for handleShopSelectMenu.
 * Channel cache is empty and channels.fetch returns null.
 */
function makeShopSelectMenuInteraction() {
  const fetchChannel = vi.fn().mockResolvedValue(null);

  return {
    guildId: GUILD_ID,
    guild: {
      id:      GUILD_ID,
      members: { fetch: vi.fn().mockResolvedValue({ roles: { cache: { keys: () => [], hasAny: vi.fn().mockReturnValue(false) } } }) },
      channels: {
        cache: new Map(),
        fetch: fetchChannel,
      },
      roles: { cache: { some: vi.fn().mockReturnValue(false) } },
    },
    user:   { id: USER_ID },
    customId: SHOP_SELECT_ID,
    values: [String(ITEM_ID)],
    client: { user: { id: BOT_ID } },
    reply:      vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply:  vi.fn().mockResolvedValue(undefined),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// ─── Refund-on-extend-failure tests ──────────────────────────────────────────

describe("handleShopBuyButton — VC extend, extendPrivateVcSession rejects → refund", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.extendOrRepairVcSchedule.mockResolvedValue(null);
    mocks.refundPurchase.mockResolvedValue(undefined);
  });

  it("calls refundPurchase once with the purchased item and sends the failure reply", async () => {
    const interaction = makeShopBuyBtnInteraction();
    const item = makeExtendItem();

    mocks.getShopItem.mockResolvedValue(item);
    mocks.getGuildSettings.mockResolvedValue(makeSettings());
    mocks.getActivePrivateVcSession.mockResolvedValue(makeSession());
    mocks.buyItem.mockResolvedValue({ ok: true, item });
    // The DB extension step fails
    mocks.extendPrivateVcSession.mockRejectedValue(new Error("DB connection lost"));

    // Handler must not throw
    await expect(handleShopBuyButton(interaction as never)).resolves.toBeUndefined();

    // deferReply was called first
    expect(interaction.deferReply).toHaveBeenCalledOnce();

    // buyItem was charged before the failure
    expect(mocks.buyItem).toHaveBeenCalledOnce();
    expect(mocks.buyItem).toHaveBeenCalledWith(GUILD_ID, USER_ID, ITEM_ID, "ベリー");

    // extendPrivateVcSession was attempted
    expect(mocks.extendPrivateVcSession).toHaveBeenCalledOnce();
    expect(mocks.extendPrivateVcSession).toHaveBeenCalledWith(SESSION_ID, ONE_DAY_MS);

    // refundPurchase must be called exactly once with the item that was charged
    expect(mocks.refundPurchase).toHaveBeenCalledOnce();
    expect(mocks.refundPurchase).toHaveBeenCalledWith(GUILD_ID, USER_ID, item);

    // Failure reply must contain the expected message
    expect(interaction.editReply).toHaveBeenCalledOnce();
    const reply = interaction.editReply.mock.calls[0][0] as string;
    expect(reply).toContain("延長に失敗したため");

    // No success-path work should have run (schedule repair must NOT be called)
    expect(mocks.extendOrRepairVcSchedule).not.toHaveBeenCalled();
  });
});

describe("handleShopSelectMenu (applyShopPurchase) — VC extend, extendPrivateVcSession rejects → refund", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.extendOrRepairVcSchedule.mockResolvedValue(null);
    mocks.refundPurchase.mockResolvedValue(undefined);
  });

  it("calls refundPurchase once with the purchased item and sends the failure reply", async () => {
    const interaction = makeShopSelectMenuInteraction();
    const item = makeExtendItem();

    mocks.getShopItem.mockResolvedValue(item);
    mocks.getGuildSettings.mockResolvedValue(makeSettings());
    mocks.getActivePrivateVcSession.mockResolvedValue(makeSession());
    mocks.buyItem.mockResolvedValue({ ok: true, item });
    mocks.extendPrivateVcSession.mockRejectedValue(new Error("timeout"));

    await expect(handleShopSelectMenu(interaction as never)).resolves.toBeUndefined();

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(mocks.buyItem).toHaveBeenCalledOnce();
    expect(mocks.extendPrivateVcSession).toHaveBeenCalledOnce();

    // refundPurchase fires once with the correct item
    expect(mocks.refundPurchase).toHaveBeenCalledOnce();
    expect(mocks.refundPurchase).toHaveBeenCalledWith(GUILD_ID, USER_ID, item);

    // Failure reply sent
    expect(interaction.editReply).toHaveBeenCalledOnce();
    const reply = interaction.editReply.mock.calls[0][0] as string;
    expect(reply).toContain("延長に失敗したため");

    // No schedule repair on the failure path
    expect(mocks.extendOrRepairVcSchedule).not.toHaveBeenCalled();
  });
});

// ─── No-active-session guard tests ───────────────────────────────────────────

describe("handleShopBuyButton — VC extend, no active session → skip extension entirely", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replies with the no-session error and never calls buyItem or extendPrivateVcSession", async () => {
    const interaction = makeShopBuyBtnInteraction();
    const item = makeExtendItem();

    mocks.getShopItem.mockResolvedValue(item);
    mocks.getGuildSettings.mockResolvedValue(makeSettings());
    // No active session for this user
    mocks.getActivePrivateVcSession.mockResolvedValue(null);

    await expect(handleShopBuyButton(interaction as never)).resolves.toBeUndefined();

    // deferReply was called first (item is not nickname/vc-rename type)
    expect(interaction.deferReply).toHaveBeenCalledOnce();

    // buyItem must NOT be called — user is not charged
    expect(mocks.buyItem).not.toHaveBeenCalled();

    // extendPrivateVcSession must NOT be called
    expect(mocks.extendPrivateVcSession).not.toHaveBeenCalled();

    // An error reply must be sent containing the no-session message
    expect(interaction.editReply).toHaveBeenCalledOnce();
    const reply = interaction.editReply.mock.calls[0][0] as string;
    expect(reply).toContain("有効な高級船室がありません");
  });
});

describe("handleShopSelectMenu (applyShopPurchase) — VC extend, no active session → skip extension entirely", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replies with the no-session error and never calls buyItem or extendPrivateVcSession", async () => {
    const interaction = makeShopSelectMenuInteraction();
    const item = makeExtendItem();

    mocks.getShopItem.mockResolvedValue(item);
    mocks.getGuildSettings.mockResolvedValue(makeSettings());
    // No active session for this user
    mocks.getActivePrivateVcSession.mockResolvedValue(null);

    await expect(handleShopSelectMenu(interaction as never)).resolves.toBeUndefined();

    // deferReply was called first
    expect(interaction.deferReply).toHaveBeenCalledOnce();

    // buyItem must NOT be called — user is not charged
    expect(mocks.buyItem).not.toHaveBeenCalled();

    // extendPrivateVcSession must NOT be called
    expect(mocks.extendPrivateVcSession).not.toHaveBeenCalled();

    // An error reply must be sent containing the no-session message
    expect(interaction.editReply).toHaveBeenCalledOnce();
    const reply = interaction.editReply.mock.calls[0][0] as string;
    expect(reply).toContain("有効な高級船室がありません");
  });
});

describe("handleShopBuyButton — VC extend, channel absent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.extendOrRepairVcSchedule.mockResolvedValue(null);
  });

  it("completes without throwing, sends success reply, skips panel edit when channel is null", async () => {
    const interaction = makeShopBuyBtnInteraction();

    mocks.getShopItem.mockResolvedValue(makeExtendItem());
    mocks.getGuildSettings.mockResolvedValue(makeSettings());
    mocks.getActivePrivateVcSession.mockResolvedValue(makeSession());
    mocks.buyItem.mockResolvedValue({ ok: true, item: makeExtendItem() });
    mocks.extendPrivateVcSession.mockResolvedValue({ ...makeSession(), expiresAt: EXTENDED_AT });

    // Must not throw even though the channel cannot be resolved
    await expect(handleShopBuyButton(interaction as never)).resolves.toBeUndefined();

    // deferReply must have been called first
    expect(interaction.deferReply).toHaveBeenCalledOnce();

    // buyItem must be called with correct args
    expect(mocks.buyItem).toHaveBeenCalledOnce();
    expect(mocks.buyItem).toHaveBeenCalledWith(GUILD_ID, USER_ID, ITEM_ID, "ベリー");

    // extendPrivateVcSession must be called
    expect(mocks.extendPrivateVcSession).toHaveBeenCalledOnce();
    expect(mocks.extendPrivateVcSession).toHaveBeenCalledWith(SESSION_ID, ONE_DAY_MS);

    // extendOrRepairVcSchedule must still run with channelId as fallback name
    expect(mocks.extendOrRepairVcSchedule).toHaveBeenCalledOnce();
    expect(mocks.extendOrRepairVcSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ fallbackName: CHANNEL_ID }),
    );

    // Success reply must be sent with item name and timestamp
    expect(interaction.editReply).toHaveBeenCalledOnce();
    const reply = interaction.editReply.mock.calls[0][0] as string;
    expect(reply).toContain("非公開VC延長（1日）");
    expect(reply).toContain("延長しました");

    // channels.fetch was attempted (channel was gone), and that is fine
    expect(interaction.guild.channels.fetch).toHaveBeenCalledWith(CHANNEL_ID);

    // No panel messages were fetched (channel object has no messages property)
    // — the guard `textCh && "messages" in textCh` prevented any panel edit attempt.
    // Confirm logger.error was NOT called with a panel-related error (the skip is silent).
    const errorCalls = mocks.loggerError.mock.calls as Array<[string, ...unknown[]]>;
    const panelErrors = errorCalls.filter(([msg]) => typeof msg === "string" && msg.includes("panel"));
    expect(panelErrors).toHaveLength(0);
  });
});

describe("handleShopSelectMenu (applyShopPurchase) — VC extend, channel absent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.extendOrRepairVcSchedule.mockResolvedValue(null);
  });

  it("completes without throwing, sends success reply, skips panel edit when channel is null", async () => {
    const interaction = makeShopSelectMenuInteraction();

    mocks.getShopItem.mockResolvedValue(makeExtendItem());
    mocks.getGuildSettings.mockResolvedValue(makeSettings());
    mocks.getActivePrivateVcSession.mockResolvedValue(makeSession());
    mocks.buyItem.mockResolvedValue({ ok: true, item: makeExtendItem() });
    mocks.extendPrivateVcSession.mockResolvedValue({ ...makeSession(), expiresAt: EXTENDED_AT });

    // Must not throw even though the channel cannot be resolved
    await expect(handleShopSelectMenu(interaction as never)).resolves.toBeUndefined();

    // deferReply must have been called first
    expect(interaction.deferReply).toHaveBeenCalledOnce();

    // Core extend operations must still run
    expect(mocks.buyItem).toHaveBeenCalledOnce();
    expect(mocks.extendPrivateVcSession).toHaveBeenCalledOnce();

    // Schedule repair must still run with channelId as fallback name
    expect(mocks.extendOrRepairVcSchedule).toHaveBeenCalledOnce();
    expect(mocks.extendOrRepairVcSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ fallbackName: CHANNEL_ID }),
    );

    // Success reply must be sent
    expect(interaction.editReply).toHaveBeenCalledOnce();
    const reply = interaction.editReply.mock.calls[0][0] as string;
    expect(reply).toContain("非公開VC延長（1日）");
    expect(reply).toContain("延長しました");

    // channels.fetch was attempted but returned null
    expect(interaction.guild.channels.fetch).toHaveBeenCalledWith(CHANNEL_ID);

    // Panel update was silently skipped — no panel-related error logged
    const errorCalls = mocks.loggerError.mock.calls as Array<[string, ...unknown[]]>;
    const panelErrors = errorCalls.filter(([msg]) => typeof msg === "string" && msg.includes("panel"));
    expect(panelErrors).toHaveLength(0);
  });
});
