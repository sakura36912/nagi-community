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

// ─── Hoist mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  getShopItem:                vi.fn(),
  getGuildSettings:           vi.fn(),
  getActivePrivateVcSession:  vi.fn(),
  buyItem:                    vi.fn(),
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
  addShopItem:               vi.fn(),
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
  listShopItems:             vi.fn(),
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
  getPrivateVcRoomCategory,
  handleShopBuyButton,
  handleShopSelectMenu,
  isFreeRoomCategory,
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

describe("private VC panel category separation", () => {
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

    expect(freeRoomPanel.embeds[0]?.data.title).toBe("フリールームコントロールパネル");
    expect(luxuryPanel.embeds[0]?.data.title).toBe("🔒 高級船室 コントロールパネル");

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
