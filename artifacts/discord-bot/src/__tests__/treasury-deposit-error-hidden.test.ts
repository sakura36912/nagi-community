/**
 * Confirms that a DB/runtime error thrown by depositToTreasury is hidden from
 * the Discord user — the interaction receives only the fixed Japanese string
 * "入金に失敗しました。" — and that the error is forwarded to the logger.
 *
 * Coverage target:
 *   artifacts/discord-bot/src/commands/index.ts — giveCommand execute,
 *   deposit sub-command catch block (~line 1179).
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  depositToTreasury:    vi.fn(),
  getGuildSettings:     vi.fn(),
  getSquadTreasury:     vi.fn(),
  getTreasuriesByRoles: vi.fn(),
  loggerError:          vi.fn(),
  loggerInfo:           vi.fn(),
  loggerWarn:           vi.fn(),
}));

vi.mock("../lib/economy.js", () => ({
  // ── Spied functions ─────────────────────────────────────────────────────
  depositToTreasury:    mocks.depositToTreasury,
  getGuildSettings:     mocks.getGuildSettings,
  getSquadTreasury:     mocks.getSquadTreasury,
  getTreasuriesByRoles: mocks.getTreasuriesByRoles,
  // ── Constants ────────────────────────────────────────────────────────────
  DEFAULT_DAILY_AMOUNT:  500,
  NICKNAME_CHANGE_EFFECT: "nickname_change",
  PRIVATE_VC_EFFECT:      "private_vc",
  PRIVATE_VC_1D_EFFECT:   "private_vc_1d",
  PRIVATE_VC_3D_EFFECT:   "private_vc_3d",
  PRIVATE_VC_1W_EFFECT:   "private_vc_1w",
  PRIVATE_VC_1M_EFFECT:   "private_vc_1m",
  VC_RENAME_EFFECT:       "vc_rename",
  VC_EXTEND_1D_EFFECT:    "vc_extend_1d",
  EVAL_EXTEND_DAYS:       {},
  PERM_ROLE_EFFECT:       "perm_role",
  EVAL_RESURFACE_EFFECT:  "eval_resurface",
  SHOP_LICENSE_EFFECT:    "shop_license",
  TIMED_VC_DURATIONS:     {},
  VC_EXTEND_DURATIONS:    {},
  // ── Stubs (not under test) ───────────────────────────────────────────────
  extendCommunitySheet:       vi.fn(),
  getLatestEvalSheet:         vi.fn(),
  addShopItem:                vi.fn(),
  createEvalSheet:            vi.fn(),
  getEvalSheetSettings:       vi.fn(),
  getSheetVcSeconds:          vi.fn(),
  setShopLicenseConfig:       vi.fn(),
  listShopLicenseConfigs:     vi.fn(),
  getShopLicenseForUser:      vi.fn(),
  recordGroupShopSale:        vi.fn(),
  getGroupShopSalesSummary:   vi.fn(),
  setVcCategoryId:            vi.fn(),
  buyItem:                    vi.fn(),
  createOrUpdateCurrency:     vi.fn(),
  createPrivateVcSession:     vi.fn(),
  giveToCrunchTreasury:       vi.fn(),
  updateShopItemPrice:        vi.fn(),
  updateShopItemRole:         vi.fn(),
  getLeaderboard:             vi.fn(),
  getOrCreateWallet:          vi.fn(),
  giveCurrency:               vi.fn(),
  listInventory:              vi.fn(),
  listRoleRewards:            vi.fn(),
  listShopItems:              vi.fn(),
  listSquadTreasuries:        vi.fn(),
  refundPurchase:             vi.fn(),
  removeRoleReward:           vi.fn(),
  removeShopItem:             vi.fn(),
  setRewardDayOfMonth:        vi.fn(),
  setRewardInterval:          vi.fn(),
  setRoleReward:              vi.fn(),
  transfer:                   vi.fn(),
  getShopItem:                vi.fn(),
  getActivePrivateVcSession:  vi.fn(),
  extendPrivateVcSession:     vi.fn(),
  getPrivateVcSessionByChannelId: vi.fn(),
  getActivePrivateVcSessionsByGuild: vi.fn(),
  distributeRoleRewards:      vi.fn(),
  getGuildWalletUserIds:      vi.fn(),
  setChestTavernChannelNames: vi.fn(),
  setChestLogChannelId:       vi.fn(),
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

vi.mock("../lib/vcScheduleRepair.js", () => ({
  extendOrRepairVcSchedule: vi.fn(),
}));

vi.mock("../lib/vcReward.js", () => ({
  getVcPresence:            vi.fn(),
  getTodayChestVcSeconds:   vi.fn(),
  getTodayChestOpensCount:  vi.fn(),
  getTotalChestVcSeconds:   vi.fn(),
  getTotalChestOpensCount:  vi.fn(),
  hasTodayChestOpened:      vi.fn(),
  markChestOpenedToday:     vi.fn(),
  incrementChestOpensToday: vi.fn(),
  addChestVcSeconds:        vi.fn(),
}));

vi.mock("../lib/chestTracker.js", () => ({
  getCurrentTavernSeconds:  vi.fn(),
  TAVERN_CHANNEL_NAMES:     [],
  getTavernChannelNames:    vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  upsertTimedRoleGrant: vi.fn(),
  db:                   {},
  vcSessionLogsTable:   {},
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────
import { commands } from "../commands/index.js";

// ─── Constants ────────────────────────────────────────────────────────────────
const GUILD_ID    = "guild-111";
const USER_ID     = "user-222";
const TREASURY_ID = 7;
const ROLE_ID     = "role-abc";
const AMOUNT      = 500;

const DB_ERROR_MSG = "connection to server at localhost (127.0.0.1), port 5432 failed: FATAL: too many connections";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTreasury() {
  return {
    id:      TREASURY_ID,
    guildId: GUILD_ID,
    name:    "鬼殺隊金庫",
    roleId:  ROLE_ID,
    balance: 10_000,
  };
}

/**
 * Build a minimal ChatInputCommandInteraction mock for the /give deposit path.
 * The member already holds the treasury's role so the role-guard passes.
 */
function makeDepositInteraction() {
  // Roles cache: iterator yields ROLE_ID so memberRoleIds.includes(treasury.roleId) === true
  const rolesCache = new Map([[ROLE_ID, {}]]);

  return {
    guildId:           GUILD_ID,
    guild:             { id: GUILD_ID },
    user:              { id: USER_ID },
    memberPermissions: { has: vi.fn().mockReturnValue(false) }, // not admin — doesn't matter for deposit
    member: {
      roles: {
        cache: {
          keys:   () => rolesCache.keys(),
          has:    (id: string) => rolesCache.has(id),
          hasAny: (...ids: string[]) => ids.some((id) => rolesCache.has(id)),
        },
      },
    },
    options: {
      getSubcommand:  vi.fn().mockReturnValue("deposit"),
      getInteger: vi.fn().mockImplementation((name: string, required?: boolean) => {
        if (name === "amount")      return AMOUNT;
        if (name === "treasury_id") return null;   // auto-resolve from roles
        return required ? AMOUNT : null;
      }),
    },
    reply:      vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply:  vi.fn().mockResolvedValue(undefined),
  };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("giveCommand deposit — depositToTreasury throws → generic error shown, raw error hidden", () => {
  const giveCommand = commands.find((c) => c.data.name === "give")!;

  beforeEach(() => {
    vi.clearAllMocks();

    mocks.getGuildSettings.mockResolvedValue({ currencyName: "ベリー", vcCategoryId: null });
    // Auto-resolve path: exactly one treasury matches the member's roles
    mocks.getTreasuriesByRoles.mockResolvedValue([makeTreasury()]);
    // DB layer rejects with a raw error that must NOT reach the user
    mocks.depositToTreasury.mockRejectedValue(new Error(DB_ERROR_MSG));
  });

  it("sends exactly '入金に失敗しました。' and does not include raw error text", async () => {
    const interaction = makeDepositInteraction();

    await expect(giveCommand.execute(interaction as never)).resolves.toBeUndefined();

    // deferReply was called before the DB work
    expect(interaction.deferReply).toHaveBeenCalledOnce();

    // depositToTreasury was attempted
    expect(mocks.depositToTreasury).toHaveBeenCalledOnce();
    expect(mocks.depositToTreasury).toHaveBeenCalledWith(
      GUILD_ID,
      TREASURY_ID,
      USER_ID,
      AMOUNT,
    );

    // editReply was called exactly once with the fixed string
    expect(interaction.editReply).toHaveBeenCalledOnce();
    const reply = interaction.editReply.mock.calls[0][0] as string;
    expect(reply).toBe("入金に失敗しました。");

    // The raw DB error must NOT appear anywhere in the reply
    expect(reply).not.toContain(DB_ERROR_MSG);
    expect(reply).not.toContain("connection");
    expect(reply).not.toContain("FATAL");
  });

  it("logs the error via logger.error", async () => {
    const interaction = makeDepositInteraction();

    await expect(giveCommand.execute(interaction as never)).resolves.toBeUndefined();

    // logger.error must be called at least once and must reference the DB error
    expect(mocks.loggerError).toHaveBeenCalled();
    const [, loggedErr] = mocks.loggerError.mock.calls[0] as [string, unknown];
    expect(loggedErr).toBeInstanceOf(Error);
    expect((loggedErr as Error).message).toBe(DB_ERROR_MSG);
  });
});
