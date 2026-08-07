/**
 * Tests confirming the VC panel "期間延長" button and select-menu handlers
 * work end-to-end:
 *   1. Non-owner clicking "期間延長" gets the "VCオーナーのみ" ephemeral error.
 *   2. Owner click when no active session → "無期限のため期間延長できません".
 *   3. Owner click when session exists but no extend items → "延長券が設定されていません".
 *   4. Owner click with session + extend items → select menu with item names and prices.
 *   5. Non-owner selecting an item gets the "VCオーナーのみ" ephemeral error.
 *   6. Owner selects an item, buyItem succeeds → wallet deducted and panel embed updated.
 *   7. Owner selects an item, buyItem fails (insufficient funds) → error reply, no extension.
 *   8. Panel embed update is best-effort: a failure does not prevent the success reply.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  getPrivateVcSessionByChannelId: vi.fn(),
  listShopItems: vi.fn(),
  getGuildSettings: vi.fn(),
  getShopItem: vi.fn(),
  buyItem: vi.fn(),
  extendPrivateVcSession: vi.fn(),
  extendOrRepairVcSchedule: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("../lib/economy.js", () => ({
  // ── Spied functions (assertions are made against these) ──────────────────
  getPrivateVcSessionByChannelId: mocks.getPrivateVcSessionByChannelId,
  listShopItems:                  mocks.listShopItems,
  getGuildSettings:               mocks.getGuildSettings,
  getShopItem:                    mocks.getShopItem,
  buyItem:                        mocks.buyItem,
  extendPrivateVcSession:         mocks.extendPrivateVcSession,
  // ── Constants re-exported by economy.ts and consumed by commands/index.ts ─
  VC_EXTEND_DURATIONS: { vc_extend_1d: 86_400_000 },
  DEFAULT_DAILY_AMOUNT: 500,
  NICKNAME_CHANGE_EFFECT: "nickname_change",
  PRIVATE_VC_EFFECT:     "private_vc",
  PRIVATE_VC_1D_EFFECT:  "private_vc_1d",
  PRIVATE_VC_3D_EFFECT:  "private_vc_3d",
  PRIVATE_VC_1W_EFFECT:  "private_vc_1w",
  PRIVATE_VC_1M_EFFECT:  "private_vc_1m",
  VC_RENAME_EFFECT:      "vc_rename",
  VC_EXTEND_1D_EFFECT:   "vc_extend_1d",
  EVAL_EXTEND_DAYS:      {},
  PERM_ROLE_EFFECT:      "perm_role",
  EVAL_RESURFACE_EFFECT: "eval_resurface",
  SHOP_LICENSE_EFFECT:   "shop_license",
  TIMED_VC_DURATIONS:    {},
  // ── Stub functions used by other handlers (not under test here) ───────────
  extendCommunitySheet:    vi.fn(),
  getLatestEvalSheet:      vi.fn(),
  addShopItem:             vi.fn(),
  createEvalSheet:         vi.fn(),
  getEvalSheetSettings:    vi.fn(),
  getSheetVcSeconds:       vi.fn(),
  setShopLicenseConfig:    vi.fn(),
  listShopLicenseConfigs:  vi.fn(),
  getShopLicenseForUser:   vi.fn(),
  recordGroupShopSale:     vi.fn(),
  getGroupShopSalesSummary: vi.fn(),
  setVcCategoryId:         vi.fn(),
  createOrUpdateCurrency:  vi.fn(),
  createPrivateVcSession:  vi.fn(),
  getActivePrivateVcSession: vi.fn(),
  depositToTreasury:       vi.fn(),
  getTreasuriesByRoles:    vi.fn(),
  giveToCrunchTreasury:    vi.fn(),
  updateShopItemPrice:     vi.fn(),
  updateShopItemRole:      vi.fn(),
  getLeaderboard:          vi.fn(),
  getOrCreateWallet:       vi.fn(),
  getSquadTreasury:        vi.fn(),
  giveCurrency:            vi.fn(),
  listInventory:           vi.fn(),
  listRoleRewards:         vi.fn(),
  listSquadTreasuries:     vi.fn(),
  refundPurchase:          vi.fn(),
  removeRoleReward:        vi.fn(),
  removeShopItem:          vi.fn(),
  setRewardDayOfMonth:     vi.fn(),
  setRewardInterval:       vi.fn(),
  setRoleReward:           vi.fn(),
  transfer:                vi.fn(),
  distributeRoleRewards:   vi.fn(),
  getGuildWalletUserIds:   vi.fn(),
}));

vi.mock("../lib/vcScheduleRepair.js", () => ({
  extendOrRepairVcSchedule: mocks.extendOrRepairVcSchedule,
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

// Stub out other lib modules that commands/index.ts imports transitively
vi.mock("../lib/sheet.js", () => ({
  applySheetEmbedUpdate: vi.fn(),
  buildSheetEmbed: vi.fn(),
  buildSheetThreadName: vi.fn(),
  findSelfIntro: vi.fn(),
  refreshSheetEmbedForUser: vi.fn(),
}));

vi.mock("../lib/vc.js", () => ({
  saveSchedule: vi.fn(),
}));

vi.mock("../lib/vcReward.js", () => ({
  getVcPresence: vi.fn(),
  getTodayChestVcSeconds: vi.fn(),
  hasTodayChestOpened: vi.fn(),
  markChestOpenedToday: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  upsertTimedRoleGrant: vi.fn(),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────
import {
  handleVcPanelExtendBtn,
  handleVcPanelExtendSel,
  VC_PANEL_BTN_EXTEND,
  VC_PANEL_SEL_EXTEND,
  vcPanelId,
} from "../commands/index.js";

// ─── Constants ────────────────────────────────────────────────────────────────
const CHANNEL_ID  = "ch-999";
const OWNER_ID    = "owner-111";
const OTHER_ID    = "other-222";
const GUILD_ID    = "guild-333";
const BOT_ID      = "bot-444";
const SESSION_ID  = 7;
const ITEM_ID     = 42;
const ONE_DAY_MS  = 24 * 60 * 60 * 1000;

const EXPIRES_AT  = new Date("2099-06-01T12:00:00Z");
const EXTENDED_AT = new Date("2099-06-02T12:00:00Z"); // +1 day

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    userId: OWNER_ID,
    expiresAt: EXPIRES_AT,
    category: "vc",
    ...overrides,
  };
}

function makeExtendItem(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_ID,
    guildId: GUILD_ID,
    name: "非公開VC延長（1日）",
    description: "期限を1日延長します。",
    price: 800,
    effectType: "vc_extend_1d",
    category: "vc",
    targetRoleId: null,
    sortOrder: 4,
    ...overrides,
  };
}

function makeSettings() {
  return { currencyName: "ベリー", vcCategoryId: null };
}

/** Create a collection-like object that has a discord.js-style .find() method */
function makeMessageCollection(messages: Record<string, unknown>[]) {
  const items = messages;
  return {
    find: (predicate: (m: Record<string, unknown>) => boolean) => items.find(predicate),
  };
}

/** Build a mock panel message (as the bot would have posted it). */
function makePanelMsg(botId: string) {
  return {
    author: { id: botId },
    embeds: [{ title: "🔒 非公開VC コントロールパネル" }],
    edit: vi.fn().mockResolvedValue(undefined),
  };
}

/** Build a text channel mock that contains exactly one panel message. */
function makeTextChannel(botId: string) {
  const panel = makePanelMsg(botId);
  return {
    name: "🔒-test-vc",
    messages: {
      fetch: vi.fn().mockResolvedValue(makeMessageCollection([panel])),
    },
    _panel: panel, // expose for assertions
  };
}

/** Build a minimal ButtonInteraction mock for handleVcPanelExtendBtn. */
function makeExtendBtnInteraction(userId: string, textChannel?: ReturnType<typeof makeTextChannel>) {
  const channelsCache = new Map<string, ReturnType<typeof makeTextChannel>>();
  if (textChannel) channelsCache.set(CHANNEL_ID, textChannel);

  return {
    guildId: GUILD_ID,
    guild: {
      id: GUILD_ID,
      channels: {
        cache: channelsCache,
        fetch: vi.fn().mockResolvedValue(textChannel ?? null),
      },
    },
    user: { id: userId },
    customId: vcPanelId(VC_PANEL_BTN_EXTEND, CHANNEL_ID, OWNER_ID),
    client: { user: { id: BOT_ID } },
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
}

/** Build a minimal StringSelectMenuInteraction mock for handleVcPanelExtendSel. */
function makeExtendSelInteraction(userId: string, itemIdStr: string, textChannel?: ReturnType<typeof makeTextChannel>) {
  const channelsCache = new Map<string, ReturnType<typeof makeTextChannel>>();
  if (textChannel) channelsCache.set(CHANNEL_ID, textChannel);

  return {
    guildId: GUILD_ID,
    guild: {
      id: GUILD_ID,
      channels: {
        cache: channelsCache,
        fetch: vi.fn().mockResolvedValue(textChannel ?? null),
      },
    },
    user: { id: userId },
    customId: vcPanelId(VC_PANEL_SEL_EXTEND, CHANNEL_ID, OWNER_ID),
    client: { user: { id: BOT_ID } },
    values: [itemIdStr],
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("handleVcPanelExtendBtn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.extendOrRepairVcSchedule.mockResolvedValue(null);
  });

  it("scenario 1: non-owner gets VCオーナーのみ ephemeral error", async () => {
    const interaction = makeExtendBtnInteraction(OTHER_ID);
    await handleVcPanelExtendBtn(interaction as never);

    expect(interaction.reply).toHaveBeenCalledOnce();
    const call = interaction.reply.mock.calls[0][0] as { content: string; ephemeral: boolean };
    expect(call.content).toContain("VCオーナーのみ");
    expect(call.ephemeral).toBe(true);
    // No economy calls should happen
    expect(mocks.getPrivateVcSessionByChannelId).not.toHaveBeenCalled();
  });

  it("scenario 2: owner with no active session gets 無期限 error", async () => {
    mocks.getPrivateVcSessionByChannelId.mockResolvedValue(null);
    const interaction = makeExtendBtnInteraction(OWNER_ID);
    await handleVcPanelExtendBtn(interaction as never);

    expect(interaction.reply).toHaveBeenCalledOnce();
    const call = interaction.reply.mock.calls[0][0] as { content: string; ephemeral: boolean };
    expect(call.content).toContain("無期限");
    expect(call.ephemeral).toBe(true);
    expect(mocks.listShopItems).not.toHaveBeenCalled();
  });

  it("scenario 3: session exists but no extend items → 延長券が設定されていません error", async () => {
    mocks.getPrivateVcSessionByChannelId.mockResolvedValue(makeSession());
    mocks.listShopItems.mockResolvedValue([]); // no items at all
    const interaction = makeExtendBtnInteraction(OWNER_ID);
    await handleVcPanelExtendBtn(interaction as never);

    expect(interaction.reply).toHaveBeenCalledOnce();
    const call = interaction.reply.mock.calls[0][0] as { content: string; ephemeral: boolean };
    expect(call.content).toContain("延長券が設定されていません");
    expect(call.ephemeral).toBe(true);
  });

  it("scenario 4: session + extend items → select menu shown with item name and price", async () => {
    mocks.getPrivateVcSessionByChannelId.mockResolvedValue(makeSession());
    mocks.listShopItems.mockResolvedValue([makeExtendItem()]);
    mocks.getGuildSettings.mockResolvedValue(makeSettings());
    const interaction = makeExtendBtnInteraction(OWNER_ID);
    await handleVcPanelExtendBtn(interaction as never);

    expect(interaction.reply).toHaveBeenCalledOnce();
    const call = interaction.reply.mock.calls[0][0] as {
      content: string;
      components: unknown[];
      ephemeral: boolean;
    };
    expect(call.ephemeral).toBe(true);
    // The reply must include a select menu component
    expect(call.components).toHaveLength(1);
    // The content prompts the user to pick
    expect(call.content).toContain("延長券");
  });

  it("scenario 4b: VC items that are NOT extend券 are filtered out before showing menu", async () => {
    const nonExtendItem = makeExtendItem({ effectType: "private_vc_1d" }); // creation type, not extend
    const extendItem = makeExtendItem();
    mocks.getPrivateVcSessionByChannelId.mockResolvedValue(makeSession());
    mocks.listShopItems.mockResolvedValue([nonExtendItem, extendItem]);
    mocks.getGuildSettings.mockResolvedValue(makeSettings());
    const interaction = makeExtendBtnInteraction(OWNER_ID);
    await handleVcPanelExtendBtn(interaction as never);

    // Should succeed and show menu (one valid extend item remains)
    expect(interaction.reply).toHaveBeenCalledOnce();
    const call = interaction.reply.mock.calls[0][0] as { components: unknown[]; ephemeral: boolean };
    expect(call.ephemeral).toBe(true);
    expect(call.components).toHaveLength(1);
  });
});

describe("handleVcPanelExtendSel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.extendOrRepairVcSchedule.mockResolvedValue(null);
  });

  it("scenario 5: non-owner selecting item gets VCオーナーのみ ephemeral error", async () => {
    const interaction = makeExtendSelInteraction(OTHER_ID, String(ITEM_ID));
    await handleVcPanelExtendSel(interaction as never);

    expect(interaction.reply).toHaveBeenCalledOnce();
    const call = interaction.reply.mock.calls[0][0] as { content: string; ephemeral: boolean };
    expect(call.content).toContain("VCオーナーのみ");
    expect(call.ephemeral).toBe(true);
    expect(mocks.buyItem).not.toHaveBeenCalled();
  });

  it("scenario 6: owner selects item → buyItem deducts wallet, panel embed updated, success reply shown", async () => {
    const textChannel = makeTextChannel(BOT_ID);
    const interaction = makeExtendSelInteraction(OWNER_ID, String(ITEM_ID), textChannel);

    const session = makeSession();
    mocks.getPrivateVcSessionByChannelId.mockResolvedValue(session);
    mocks.getShopItem.mockResolvedValue(makeExtendItem());
    mocks.getGuildSettings.mockResolvedValue(makeSettings());
    mocks.buyItem.mockResolvedValue({ ok: true, item: makeExtendItem() });
    mocks.extendPrivateVcSession.mockResolvedValue({ ...session, expiresAt: EXTENDED_AT });

    await handleVcPanelExtendSel(interaction as never);

    // deferReply must be called before any DB work
    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(interaction.deferReply.mock.calls[0][0]).toMatchObject({ ephemeral: true });

    // buyItem must be called with the right item and currency
    expect(mocks.buyItem).toHaveBeenCalledOnce();
    expect(mocks.buyItem).toHaveBeenCalledWith(GUILD_ID, OWNER_ID, ITEM_ID, "ベリー");

    // extendPrivateVcSession must be called with the session id and +1 day duration
    expect(mocks.extendPrivateVcSession).toHaveBeenCalledOnce();
    expect(mocks.extendPrivateVcSession).toHaveBeenCalledWith(SESSION_ID, ONE_DAY_MS);

    // The schedule row must be updated via extendOrRepairVcSchedule
    expect(mocks.extendOrRepairVcSchedule).toHaveBeenCalledOnce();

    // The panel embed must be edited with the new expiry
    expect(textChannel.messages.fetch).toHaveBeenCalled();
    expect(textChannel._panel.edit).toHaveBeenCalledOnce();
    // The edit payload embed description must include the new timestamp
    const editArg = textChannel._panel.edit.mock.calls[0][0] as {
      embeds: Array<{ toJSON?: () => { description?: string }; data?: { description?: string } }>;
    };
    // EmbedBuilder serializes via .toJSON() — extract description from the built embed
    const embedData = editArg.embeds[0];
    const description: string =
      (typeof (embedData as { toJSON?: () => { description?: string } }).toJSON === "function"
        ? (embedData as { toJSON: () => { description?: string } }).toJSON().description
        : (embedData as { data?: { description?: string } }).data?.description) ?? "";
    const expectedTs = Math.floor(EXTENDED_AT.getTime() / 1000);
    expect(description).toContain(String(expectedTs));

    // Success reply must mention the item name
    expect(interaction.editReply).toHaveBeenCalledOnce();
    const reply = interaction.editReply.mock.calls[0][0] as string;
    expect(reply).toContain("非公開VC延長（1日）");
    expect(reply).toContain("延長されました");
  });

  it("scenario 7: buyItem fails (insufficient funds) → error reply, extendPrivateVcSession not called", async () => {
    const interaction = makeExtendSelInteraction(OWNER_ID, String(ITEM_ID));

    mocks.getPrivateVcSessionByChannelId.mockResolvedValue(makeSession());
    mocks.getShopItem.mockResolvedValue(makeExtendItem());
    mocks.getGuildSettings.mockResolvedValue(makeSettings());
    mocks.buyItem.mockResolvedValue({ ok: false, reason: "残高が不足しています(所持: 100ベリー)。" });

    await handleVcPanelExtendSel(interaction as never);

    expect(mocks.buyItem).toHaveBeenCalledOnce();
    expect(mocks.extendPrivateVcSession).not.toHaveBeenCalled();
    expect(mocks.extendOrRepairVcSchedule).not.toHaveBeenCalled();

    expect(interaction.editReply).toHaveBeenCalledOnce();
    const reply = interaction.editReply.mock.calls[0][0] as string;
    expect(reply).toContain("残高が不足");
  });

  it("scenario 8: panel embed update failure does not prevent success reply", async () => {
    // Channel is NOT in cache and fetch returns null → panel update silently skipped
    const interaction = makeExtendSelInteraction(OWNER_ID, String(ITEM_ID)); // no textChannel arg

    const session = makeSession();
    mocks.getPrivateVcSessionByChannelId.mockResolvedValue(session);
    mocks.getShopItem.mockResolvedValue(makeExtendItem());
    mocks.getGuildSettings.mockResolvedValue(makeSettings());
    mocks.buyItem.mockResolvedValue({ ok: true, item: makeExtendItem() });
    mocks.extendPrivateVcSession.mockResolvedValue({ ...session, expiresAt: EXTENDED_AT });

    // Should not throw even though the channel is unavailable
    await expect(handleVcPanelExtendSel(interaction as never)).resolves.toBeUndefined();

    // Success reply must still be sent
    expect(interaction.editReply).toHaveBeenCalledOnce();
    const reply = interaction.editReply.mock.calls[0][0] as string;
    expect(reply).toContain("非公開VC延長（1日）");
    expect(reply).toContain("延長されました");
  });
});
