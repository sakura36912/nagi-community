/**
 * Confirms that the 個人ショップ開業券 purchase is gated by role:
 *   - A member with only 島民 is rejected with the correct error message.
 *   - A member with 本船員 passes the check and proceeds to purchase.
 *
 * Both the button handler (handleShopBuyButton) and the select-menu handler
 * (handleShopSelectMenu → applyShopPurchase) are covered.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  getShopItem: vi.fn(),
  getGuildSettings: vi.fn(),
  buyItem: vi.fn(),
  getShopLicenseForUser: vi.fn(),
  listShopLicenseConfigs: vi.fn(),
  refundPurchase: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("../lib/economy.js", () => ({
  // ── Functions under test ───────────────────────────────────────────────────
  getShopItem: mocks.getShopItem,
  getGuildSettings: mocks.getGuildSettings,
  buyItem: mocks.buyItem,
  getShopLicenseForUser: mocks.getShopLicenseForUser,
  listShopLicenseConfigs: mocks.listShopLicenseConfigs,
  refundPurchase: mocks.refundPurchase,
  // ── Constants consumed by commands/index.ts ────────────────────────────────
  DEFAULT_DAILY_AMOUNT: 500,
  NICKNAME_CHANGE_EFFECT: "nickname_change",
  PRIVATE_VC_EFFECT: "private_vc",
  PRIVATE_VC_1D_EFFECT: "private_vc_1d",
  PRIVATE_VC_3D_EFFECT: "private_vc_3d",
  PRIVATE_VC_1W_EFFECT: "private_vc_1w",
  PRIVATE_VC_1M_EFFECT: "private_vc_1m",
  VC_RENAME_EFFECT: "vc_rename",
  VC_EXTEND_1D_EFFECT: "vc_extend_1d",
  EVAL_EXTEND_DAYS: {},
  PERM_ROLE_EFFECT: "perm_role",
  EVAL_RESURFACE_EFFECT: "eval_resurface",
  SHOP_LICENSE_EFFECT: "shop_license",
  TIMED_VC_DURATIONS: {},
  VC_EXTEND_DURATIONS: {},
  // ── Unused stubs ───────────────────────────────────────────────────────────
  extendCommunitySheet: vi.fn(),
  getLatestEvalSheet: vi.fn(),
  addShopItem: vi.fn(),
  createEvalSheet: vi.fn(),
  getEvalSheetSettings: vi.fn(),
  getSheetVcSeconds: vi.fn(),
  setShopLicenseConfig: vi.fn(),
  recordGroupShopSale: vi.fn(),
  getGroupShopSalesSummary: vi.fn(),
  setVcCategoryId: vi.fn(),
  createOrUpdateCurrency: vi.fn(),
  createPrivateVcSession: vi.fn(),
  getActivePrivateVcSession: vi.fn(),
  extendPrivateVcSession: vi.fn(),
  depositToTreasury: vi.fn(),
  getTreasuriesByRoles: vi.fn(),
  giveToCrunchTreasury: vi.fn(),
  updateShopItemPrice: vi.fn(),
  updateShopItemRole: vi.fn(),
  getLeaderboard: vi.fn(),
  getOrCreateWallet: vi.fn(),
  getSquadTreasury: vi.fn(),
  giveCurrency: vi.fn(),
  listInventory: vi.fn(),
  listRoleRewards: vi.fn(),
  listShopItems: vi.fn(),
  listSquadTreasuries: vi.fn(),
  removeRoleReward: vi.fn(),
  removeShopItem: vi.fn(),
  setRewardDayOfMonth: vi.fn(),
  setRewardInterval: vi.fn(),
  setRoleReward: vi.fn(),
  transfer: vi.fn(),
  distributeRoleRewards: vi.fn(),
  getGuildWalletUserIds: vi.fn(),
}));

vi.mock("../lib/vcScheduleRepair.js", () => ({
  extendOrRepairVcSchedule: vi.fn(),
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

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
  getTodayChestVcSeconds: vi.fn(),
  getTodayChestOpensCount: vi.fn(),
  incrementChestOpensToday: vi.fn(),
  addChestVcSeconds: vi.fn(),
}));

vi.mock("../lib/chestTracker.js", () => ({
  getCurrentTavernSeconds: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  upsertTimedRoleGrant: vi.fn(),
  db: {},
  vcSessionLogsTable: {},
}));

vi.mock("drizzle-orm", () => ({
  gte: vi.fn(),
  lt: vi.fn(),
  and: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
  sql: vi.fn(),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────
import {
  handleShopBuyButton,
  handleShopSelectMenu,
  SHOP_BUY_PREFIX,
} from "../commands/index.js";

// ─── Constants ────────────────────────────────────────────────────────────────
const GUILD_ID = "guild-001";
const USER_ID = "user-999";
const ITEM_ID = 10;
const LICENSE_ROLE_ID = "role-license-888";
const SQUAD_ROLE_ID = "role-squad-777";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a shop item with effectType = shop_license */
function makeShopLicenseItem() {
  return {
    id: ITEM_ID,
    guildId: GUILD_ID,
    name: "個人ショップ開業券",
    description: "個人ショップを開業できます。",
    price: 3000,
    effectType: "shop_license",
    category: "group",
    targetRoleId: null,
    sortOrder: 1,
  };
}

function makeSettings() {
  return { currencyName: "ベリー", vcCategoryId: null };
}

/**
 * Build a mock guild `roles.cache` for the given role descriptors.
 * Mimics the discord.js Collection `.some()` method.
 */
function makeGuildRolesCache(roles: Array<{ id: string; name: string }>) {
  return {
    some: (pred: (r: { id: string; name: string }) => boolean) => roles.some(pred),
  };
}

/**
 * Build a mock member whose `roles.cache` contains exactly the provided role IDs.
 * Also exposes `roles.add` as a spy for assertion.
 */
function makeMember(ownedRoleIds: string[]) {
  const set = new Set(ownedRoleIds);
  const rolesAdd = vi.fn().mockResolvedValue(undefined);
  return {
    id: USER_ID,
    roles: {
      cache: {
        has: (id: string) => set.has(id),
        keys: () => set.keys(),
      },
      add: rolesAdd,
    },
    _rolesAdd: rolesAdd, // exposed for assertions
  };
}

/**
 * Build a minimal ButtonInteraction mock for handleShopBuyButton.
 * `guildRoles` controls what guild.roles.cache reports.
 * `member` controls what guild.members.fetch returns.
 */
function makeButtonInteraction(
  member: ReturnType<typeof makeMember>,
  guildRoles: Array<{ id: string; name: string }>,
) {
  return {
    guildId: GUILD_ID,
    customId: `${SHOP_BUY_PREFIX}${ITEM_ID}`,
    user: { id: USER_ID },
    guild: {
      id: GUILD_ID,
      members: {
        me: null,
        cache: { get: vi.fn().mockReturnValue(undefined) },
        fetch: vi.fn().mockResolvedValue(member),
      },
      roles: {
        cache: makeGuildRolesCache(guildRoles),
        everyone: { id: "everyone-role" },
      },
      channels: { cache: new Map(), fetch: vi.fn() },
    },
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    client: { user: { id: "bot-1" } },
  };
}

/**
 * Build a minimal StringSelectMenuInteraction mock for handleShopSelectMenu.
 */
function makeSelectInteraction(
  member: ReturnType<typeof makeMember>,
  guildRoles: Array<{ id: string; name: string }>,
) {
  return {
    guildId: GUILD_ID,
    guild: {
      id: GUILD_ID,
      members: {
        cache: { get: vi.fn().mockReturnValue(undefined) },
        fetch: vi.fn().mockResolvedValue(member),
      },
      roles: {
        cache: makeGuildRolesCache(guildRoles),
        everyone: { id: "everyone-role" },
      },
      channels: { cache: new Map(), fetch: vi.fn() },
    },
    user: { id: USER_ID },
    values: [String(ITEM_ID)],
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    client: { user: { id: "bot-1" } },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("handleShopBuyButton — 個人ショップ開業券 role check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getShopItem.mockResolvedValue(makeShopLicenseItem());
    mocks.getGuildSettings.mockResolvedValue(makeSettings());
  });

  it("島民 (no allowed role) is rejected with the correct error message", async () => {
    // Guild has a 島民 role; member holds only that role
    const shimaRole = { id: "role-shima-001", name: "島民" };
    const member = makeMember([shimaRole.id]);
    const interaction = makeButtonInteraction(member, [shimaRole]);

    await handleShopBuyButton(interaction as never);

    // Must respond with the access-denied message
    expect(interaction.editReply).toHaveBeenCalledOnce();
    const reply = interaction.editReply.mock.calls[0][0] as string;
    expect(reply).toContain("本船員以上のロールを持つメンバーのみ購入できます");

    // buyItem must NOT have been called
    expect(mocks.buyItem).not.toHaveBeenCalled();
  });

  it("本船員 passes the role check and proceeds to purchase", async () => {
    // Guild has a 本船員 role; member holds it, plus a matching squad role
    const honsenRole = { id: "role-honsen-002", name: "本船員" };
    const member = makeMember([honsenRole.id, SQUAD_ROLE_ID]);
    const interaction = makeButtonInteraction(member, [honsenRole]);

    // The purchase flow uses getShopLicenseForUser after the role check
    mocks.buyItem.mockResolvedValue({ ok: true, item: makeShopLicenseItem() });
    mocks.getShopLicenseForUser.mockResolvedValue({
      squadRoleId: SQUAD_ROLE_ID,
      licenseRoleId: LICENSE_ROLE_ID,
    });

    await handleShopBuyButton(interaction as never);

    // The rejection reply must NOT appear
    const replyArg = interaction.editReply.mock.calls[0]?.[0] as string | undefined;
    expect(replyArg).not.toContain("本船員以上のロールを持つメンバーのみ購入できます");

    // buyItem must have been called — role check was passed
    expect(mocks.buyItem).toHaveBeenCalledOnce();
    expect(mocks.buyItem).toHaveBeenCalledWith(GUILD_ID, USER_ID, ITEM_ID, "ベリー");
  });
});

describe("handleShopSelectMenu → applyShopPurchase — 個人ショップ開業券 role check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getShopItem.mockResolvedValue(makeShopLicenseItem());
    mocks.getGuildSettings.mockResolvedValue(makeSettings());
  });

  it("島民 (no allowed role) is rejected with the correct error message", async () => {
    const shimaRole = { id: "role-shima-001", name: "島民" };
    const member = makeMember([shimaRole.id]);
    const interaction = makeSelectInteraction(member, [shimaRole]);

    await handleShopSelectMenu(interaction as never);

    expect(interaction.editReply).toHaveBeenCalledOnce();
    const reply = interaction.editReply.mock.calls[0][0] as string;
    expect(reply).toContain("本船員以上のロールを持つメンバーのみ購入できます");

    expect(mocks.buyItem).not.toHaveBeenCalled();
  });

  it("本船員 passes the role check and proceeds to purchase", async () => {
    const honsenRole = { id: "role-honsen-002", name: "本船員" };
    const member = makeMember([honsenRole.id, SQUAD_ROLE_ID]);
    const interaction = makeSelectInteraction(member, [honsenRole]);

    // applyShopPurchase uses listShopLicenseConfigs (not getShopLicenseForUser)
    mocks.listShopLicenseConfigs.mockResolvedValue([
      { squadRoleId: SQUAD_ROLE_ID, licenseRoleId: LICENSE_ROLE_ID },
    ]);
    mocks.buyItem.mockResolvedValue({ ok: true, item: makeShopLicenseItem() });

    await handleShopSelectMenu(interaction as never);

    const replyArg = interaction.editReply.mock.calls[0]?.[0] as string | undefined;
    expect(replyArg).not.toContain("本船員以上のロールを持つメンバーのみ購入できます");

    expect(mocks.buyItem).toHaveBeenCalledOnce();
    expect(mocks.buyItem).toHaveBeenCalledWith(GUILD_ID, USER_ID, ITEM_ID, "ベリー");
  });
});
