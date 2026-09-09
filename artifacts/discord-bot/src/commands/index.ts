import { applySheetEmbedUpdate, buildSheetEmbed, buildSheetThreadName, findSelfIntro, refreshSheetEmbedForUser } from "../lib/sheet";
import { saveSchedule } from "../lib/vc";
import { extendOrRepairVcSchedule } from "../lib/vcScheduleRepair";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from "discord.js";
import type { ShopItem } from "@workspace/db";
import type { Client, Guild } from "discord.js";
import { logger } from "../lib/logger";
import {
  DEFAULT_DAILY_AMOUNT,
  NICKNAME_CHANGE_EFFECT,
  PRIVATE_VC_EFFECT,
  PRIVATE_VC_3H_EFFECT,
  PRIVATE_VC_6H_EFFECT,
  PRIVATE_VC_9H_EFFECT,
  PRIVATE_VC_1D_EFFECT,
  PRIVATE_VC_3D_EFFECT,
  PRIVATE_VC_1W_EFFECT,
  PRIVATE_VC_1M_EFFECT,
  VC_RENAME_EFFECT,
  TIMED_VC_DURATIONS,
  VC_EXTEND_DURATIONS,
  VC_EXTEND_1D_EFFECT,
  EVAL_EXTEND_DAYS,
  EVAL_EXTEND_EFFECT,
  EVAL_EXTEND_2W_EFFECT,
  EVAL_EXTEND_1M_EFFECT,
  PERM_ROLE_EFFECT,
  EVAL_RESURFACE_EFFECT,
  SHOP_LICENSE_EFFECT,
  extendCommunitySheet,
  hasUsedEvalExtension,
  addShopItem,
  createEvalSheet,
  getEvalSheetSettings,
  getSheetVcSeconds,
  setShopLicenseConfig,
  listShopLicenseConfigs,
  getShopLicenseForUser,
  recordGroupShopSale,
  getGroupShopSalesSummary,
  setVcCategoryId,
  buyItem,
  buyItemQuantity,
  createOrUpdateCurrency,
  createPrivateVcSession,
  getActivePrivateVcSession,
  extendPrivateVcSession,
  depositToTreasury,
  getTreasuriesByRoles,
  giveToCrunchTreasury,
  updateShopItemPrice,
  updateShopItemRole,
  getGuildSettings,
  getLeaderboard,
  getOrCreateWallet,
  getShopItem,
  getSquadTreasury,
  giveCurrency,
  listInventory,
  listRoleRewards,
  listShopItems,
  listSquadTreasuries,
  refundPurchase,
  removeRoleReward,
  removeShopItem,
  setRewardDayOfMonth,
  setRewardInterval,
  setRoleReward,
  setMonthlyRoleDebit,
  clearMonthlyRoleDebit,
  transfer,
  getPrivateVcSessionByChannelId,
  getActivePrivateVcSessionsByGuild,
  distributeRoleRewards,
  getExcludedUserIds,
  SUB_ACCOUNT_ROLE_NAME,
  getGuildWalletUserIds,
} from "../lib/economy";
import {
  getShopForumPanel,
  setShopForumPanelMessage,
  upsertShopForumPanel,
} from "@workspace/db";
import { getTodayChestVcSeconds, getTodayChestOpensCount, incrementChestOpensToday, addChestVcSeconds, getTotalChestVcSeconds, getTotalChestOpensCount, getChestLastOpenVcSeconds, setChestLastOpenVcSeconds, getChestBonusOpens, consumeChestBonusOpen, addChestBonusOpens } from "../lib/vcReward";
import { getCurrentTavernSeconds, getPendingTavernSeconds, isTavernChannel, onTavernJoin, TAVERN_CHANNEL_NAMES, getTavernChannelNames } from "../lib/chestTracker";
import {
  clearTimedRoleGrantFromPurchase,
  markTimedRoleGrantFromPurchase,
} from "../lib/timedRoleAssignments";
import { setChestTavernChannelNames, setChestLogChannelId } from "../lib/economy";
import {
  ADMIN_TIMED_ROLE_EFFECT,
  deleteTimedRoleConfigAndGrants,
  upsertTimedRoleGrant,
  upsertTimedRoleConfig,
  db,
  vcSessionLogsTable,
} from "@workspace/db";
import { gte, lt, and, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { calendarCommand } from "./calendar";
import { chinchiroDiceCommand } from "./chinchiroDice";

interface Command {
  data: { name: string; toJSON: () => unknown };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
  autocomplete?: (interaction: import("discord.js").AutocompleteInteraction) => Promise<void>;
}

/** Fire-and-forget: detect the buyer's squad and record the group-shop sale. */
async function tryRecordGroupSale(
  guild: import("discord.js").Guild,
  guildId: string,
  userId: string,
  item: { id: number; name: string; price: number },
): Promise<void> {
  const member = guild.members.cache.get(userId) ?? await guild.members.fetch(userId).catch(() => null);
  if (!member) return;
  const userRoleIds = [...member.roles.cache.keys()];
  const treasuries = await listSquadTreasuries(guildId);
  const treasury = treasuries.find((t) => userRoleIds.includes(t.roleId));
  if (!treasury) return;
  await recordGroupShopSale(guildId, userId, item, treasury.roleId);
}

function requireGuild(interaction: ChatInputCommandInteraction): string {
  if (!interaction.guildId) {
    throw new Error("このコマンドはサーバー内でのみ使用できます。");
  }
  return interaction.guildId;
}

function requireManageGuild(interaction: ChatInputCommandInteraction): boolean {
  if (!interaction.memberPermissions?.has("Administrator")) {
    return false;
  }
  return true;
}

function formatMs(ms: number): string {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  return `${hours}時間${minutes}分`;
}

export const SHOP_BUY_PREFIX = "shop:buy:";
export const SHOP_SELECT_ID = "shop:select";
export const FORUM_QUANTITY_PREFIX = "shop:forum-quantity:";
export const FORUM_CAST_PREFIX = "shop:forum-cast:";
export const NICKNAME_MODAL_PREFIX = "shop:nickname-modal:";
const NICKNAME_MODAL_INPUT_ID = "nickname";
export const VC_RENAME_MODAL_PREFIX = "shop:vc-rename-modal:";
const VC_RENAME_MODAL_INPUT_ID = "vc-new-name";
const VC_PANEL_TITLE = "🔒 高級船室 コントロールパネル";
const ISLAND_VC_PANEL_TITLE = "フリールームコントロールパネル";
const LEGACY_VC_PANEL_TITLES = new Set([
  "🔒 高級船室 コントロールパネル",
  "🔒 非公開VC コントロールパネル",
  ISLAND_VC_PANEL_TITLE,
]);

/**
 * private_vc_sessions.category values used by the two generations of the
 * free-room shop. "ura" is kept for existing shop items and sessions.
 */
export type PrivateVcRoomCategory = "vc" | "island" | "ura";

export function getPrivateVcRoomCategory(category: string | null | undefined): PrivateVcRoomCategory {
  if (category === "island" || category === "ura") return category;
  return "vc";
}

export function isFreeRoomCategory(category: string | null | undefined): boolean {
  return category === "island" || category === "ura";
}

/** Legacy 裏フリールーム購入者用の共通アクセスチャンネル権限。 */
async function grantUraChannelAccess(guild: Guild, userId: string, channelId: string): Promise<void> {
  try {
    const channel = guild.channels.cache.get(channelId)
      ?? await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !("permissionOverwrites" in channel)) return;
    await channel.permissionOverwrites.edit(userId, { ViewChannel: true });
    logger.info(`[ura] Granted ViewChannel on ${channelId} to user ${userId}`);
  } catch (err) {
    logger.error(`[ura] Failed to grant channel access to ${userId}`, err);
  }
}

function buildNicknameModal(itemId: number): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${NICKNAME_MODAL_PREFIX}${itemId}`)
    .setTitle("新しいニックネーム")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(NICKNAME_MODAL_INPUT_ID)
          .setLabel("新しいニックネーム")
          .setStyle(TextInputStyle.Short)
          .setMinLength(1)
          .setMaxLength(32)
          .setRequired(true),
      ),
    );
}

function buildVcRenameModal(itemId: number): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${VC_RENAME_MODAL_PREFIX}${itemId}`)
    .setTitle("VCの新しい名前")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(VC_RENAME_MODAL_INPUT_ID)
          .setLabel("新しいチャンネル名")
          .setStyle(TextInputStyle.Short)
          .setMinLength(1)
          .setMaxLength(80)
          .setRequired(true),
      ),
    );
}

// Checks whether the bot can actually set this member's nickname before we
// charge anything for it: needs Manage Nicknames, and (per Discord's rules)
// the bot's highest role must outrank the target's highest role, and the
// target must not be the guild owner.
function canSetNickname(guild: Guild, member: GuildMember): boolean {
  const me = guild.members.me;
  if (!me) {
    return false;
  }
  if (!me.permissions.has("ManageNicknames")) {
    return false;
  }
  if (member.id === guild.ownerId) {
    return false;
  }
  return me.roles.highest.position > member.roles.highest.position;
}

async function purchaseAndApplyEffect(
  guildId: string,
  member: GuildMember,
  itemId: number,
  currencyName: string,
  nickname: string,
): Promise<{ ok: true; item: ShopItem } | { ok: false; reason: string }> {
  if (!canSetNickname(member.guild, member)) {
    return {
      ok: false,
      reason: "Botにニックネームを変更する権限がありません(Manage Nicknames権限、またはロールの順序を確認してください)。",
    };
  }

  const result = await buyItem(guildId, member.id, itemId, currencyName);
  if (!result.ok) {
    return result;
  }

  try {
    await member.setNickname(nickname);
  } catch (err) {
    // The effect failed after we already charged — undo the purchase so the
    // user isn't billed for something that didn't happen.
    try {
      await refundPurchase(guildId, member.id, result.item);
    } catch (refundErr) {
      logger.error(
        `Failed to refund ${member.id} for item #${result.item.id} after nickname change failure — user may be charged without effect`,
        refundErr,
      );
      return {
        ok: false,
        reason: "ニックネームの変更と返金の両方に失敗しました。管理者にご連絡ください。",
      };
    }
    return {
      ok: false,
      reason: "ニックネームの変更に失敗したため、購入を取り消し、返金しました。",
    };
  }

  return result;
}

async function purchaseAndCreatePrivateVc(
  guild: Guild,
  member: GuildMember,
  itemId: number,
  currencyName: string,
  durationMs?: number,
  vcCategoryId?: string | null,
  accessRoleIds: string[] = [],
  roomCategory: PrivateVcRoomCategory = "vc",
  accessChannelId?: string | null,
): Promise<{ ok: true; item: ShopItem; channelId: string; expiresAt?: Date } | { ok: false; reason: string }> {
  const me = guild.members.me;
  if (!me?.permissions.has("ManageChannels")) {
    return { ok: false, reason: "BotにManageChannels権限がないため、VCを作成できません。" };
  }

  const result = await buyItem(guild.id, member.id, itemId, currencyName);
  if (!result.ok) return result;

  try {
    const isFreeRoom = isFreeRoomCategory(roomCategory);
    const isIsland = roomCategory === "island";
    const expiresAt = durationMs !== undefined ? new Date(Date.now() + durationMs) : undefined;
    const label = durationMs !== undefined
      ? isIsland
        ? `${durationMs / (60 * 60 * 1000)}時間`
        : (durationMs <= 24 * 60 * 60 * 1000 ? "1日" : durationMs <= 7 * 24 * 60 * 60 * 1000 ? "1週間" : "1ヶ月")
      : "";
    const channelName = label
      ? `${isIsland ? "" : "🔒 "}${member.displayName}(${label})`
      : `${isIsland ? "" : "🔒 "}${member.displayName}`;

    // Resolve the category from cache or fetch it so discord.js can set parent_id correctly.
    const parentCategory = vcCategoryId
      ? (guild.channels.cache.get(vcCategoryId) ?? await guild.channels.fetch(vcCategoryId).catch(() => null))
      : null;
    logger.info(`[privateVC] category=${vcCategoryId ?? "none"} resolved=${parentCategory?.id ?? "null"}`);

    const botId = guild.members.me?.id;
    const channel = await guild.channels.create({
      name: channelName.slice(0, 100),
      type: ChannelType.GuildVoice,
      userLimit: 0,
      ...(parentCategory ? { parent: parentCategory.id } : {}),
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: member.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.Connect,
            PermissionFlagsBits.Speak,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.AttachFiles,
          ],
        },
        ...accessRoleIds
          .filter((roleId) => roleId !== guild.roles.everyone.id && roleId !== member.id)
          .map((roleId) => ({
            id: roleId,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.Connect,
              PermissionFlagsBits.Speak,
              PermissionFlagsBits.SendMessages,
            ],
          })),
        // Bot 自身が ViewChannel を持たないとパネルを送信できないため明示追加
        ...(botId ? [{
          id: botId,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.AttachFiles,
          ],
        }] : []),
      ],
    });

    if (expiresAt) {
      await createPrivateVcSession(guild.id, member.id, channel.id, expiresAt, roomCategory);
      if (roomCategory === "ura" && accessChannelId) {
        await grantUraChannelAccess(guild, member.id, accessChannelId);
      }

      // Register the schedule immediately so the pre-expiry warning DM fires
      // even if the user never renames the VC (renaming will upsert this row).
      try {
        await saveSchedule(guild.id, channel.id, channelName.slice(0, 100), expiresAt, member.id);
      } catch (scheduleErr) {
        // Best-effort — schedule tracking failure does not affect VC creation.
        logger.error("[privateVC] Failed to save VC schedule after creation", scheduleErr);
      }
    }

    // ボイステキストにコントロールパネルを投稿（期限あり・無期限どちらでも）
    // memberIds=[] because the channel was just created — only the owner has access so far.
    channel.send(buildVcPanelMessage(channel.id, member.id, expiresAt, [], undefined, isFreeRoom))
      .catch((err) => logger.error("[privateVC] Failed to send VC panel to text", err));

    return { ok: true, item: result.item, channelId: channel.id, expiresAt };
  } catch (err) {
    try {
      await refundPurchase(guild.id, member.id, result.item);
    } catch (refundErr) {
      logger.error(`Failed to refund ${member.id} after private VC creation failure`, refundErr);
      return { ok: false, reason: "VCの作成と返金の両方に失敗しました。管理者にご連絡ください。" };
    }
    return { ok: false, reason: "VCの作成に失敗したため、購入を取り消し、返金しました。" };
  }
}

const ISLAND_CATEGORY_NAMES = new Set(["オチテモータ島", "🏝️ オチテモータ島"]);
const ISLAND_VC_ACCESS_ROLE_NAMES = ["追放者", "軍師", "訓練官", "見習い訓練官"];
const ISLAND_RESURFACE_ROLE_NAME = "オチテモータ島浮上券";

export function collectFreeRoomAccessRoleIds(
  roles: Iterable<{ id: string; name: string }>,
  resurfaceRoleId?: string | null,
): string[] {
  const accessRoleIds = [...roles]
    .filter((role) =>
      ISLAND_VC_ACCESS_ROLE_NAMES.includes(role.name)
      || role.name === ISLAND_RESURFACE_ROLE_NAME,
    )
    .map((role) => role.id);
  if (resurfaceRoleId) accessRoleIds.push(resurfaceRoleId);
  return [...new Set(accessRoleIds)];
}

async function resolveFreeRoomSettings(
  guild: Guild,
): Promise<{ categoryId: string | null; accessRoleIds: string[] }> {
  const islandCategory = guild.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildCategory
      && ISLAND_CATEGORY_NAMES.has(channel.name),
  ) ?? (await guild.channels.fetch()).find(
    (channel) =>
      channel?.type === ChannelType.GuildCategory
      && ISLAND_CATEGORY_NAMES.has(channel.name),
  );

  const evalResurfaceItem = (await listShopItems(guild.id, "island"))
    .find((shopItem) => shopItem.effectType === EVAL_RESURFACE_EFFECT && shopItem.targetRoleId);
  const accessRoleIds = collectFreeRoomAccessRoleIds(
    guild.roles.cache.values(),
    evalResurfaceItem?.targetRoleId,
  );

  return {
    categoryId: islandCategory?.id ?? null,
    accessRoleIds,
  };
}


function buildShopPanel(items: ShopItem[], currencyName: string, title = "🛒 ショップ", color: number = 0xf5a623) {
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color);

  if (items.length === 0) {
    embed.setDescription("ショップにアイテムはまだありません。");
    return { embeds: [embed], components: [] };
  }

  embed.setDescription(
    items
      .map((i) => `**#${i.id} ${i.name}** — ${i.price.toLocaleString()}${currencyName}${i.description ? `\n${i.description}` : ""}`)
      .join("\n\n"),
  );

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(SHOP_SELECT_ID)
    .setPlaceholder("購入するアイテムを選んでください")
    .addOptions(
      items.slice(0, 25).map((item) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(item.name.slice(0, 100))
          .setValue(String(item.id))
          .setDescription(
            `${item.price.toLocaleString()}${currencyName}${item.description ? ` — ${item.description}` : ""}`.slice(0, 100),
          ),
      ),
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
  return { embeds: [embed], components: [row] };
}

function buildForumShopPanel(itemId: number) {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${SHOP_BUY_PREFIX}${itemId}`)
      .setLabel("購入")
      .setStyle(ButtonStyle.Primary),
  );
  return { components: [row] };
}

function buildForumQuantityPicker(itemId: number) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`${FORUM_QUANTITY_PREFIX}${itemId}`)
    .setPlaceholder("購入個数を選択してください")
    .addOptions(
      Array.from({ length: 25 }, (_, index) => {
        const quantity = index + 1;
        return new StringSelectMenuOptionBuilder()
          .setLabel(`${quantity}個`)
          .setValue(String(quantity));
      }),
    );
  return {
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
  };
}

function buildForumCastPicker(itemId: number, quantity: number) {
  const select = new UserSelectMenuBuilder()
    .setCustomId(`${FORUM_CAST_PREFIX}${itemId}:${quantity}`)
    .setPlaceholder("指定するキャストを選択してください")
    .setMinValues(1)
    .setMaxValues(1);
  return {
    components: [new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(select)],
  };
}

async function getConfiguredForumPanel(
  guildId: string,
  channelId: string,
  itemId: number,
) {
  const panel = await getShopForumPanel(guildId, channelId);
  return panel?.shopItemId === itemId ? panel : null;
}

async function logForumPurchase(
  guild: Guild,
  logChannelId: string,
  buyerId: string,
  castId: string,
  item: ShopItem,
  quantity: number,
  totalPrice: number,
  currencyName: string,
): Promise<boolean> {
  try {
    const logChannel = guild.channels.cache.get(logChannelId)
      ?? await guild.channels.fetch(logChannelId).catch(() => null);
    if (!logChannel?.isTextBased()) {
      logger.warn(`[forum-shop] Configured log channel is not text-based: ${logChannelId}`);
      return false;
    }

    const embed = new EmbedBuilder()
      .setTitle("🛒 フォーラム購入ログ")
      .setColor(0xf5a623)
      .addFields(
        { name: "購入者", value: `<@${buyerId}>`, inline: true },
        { name: "指定のキャスト", value: `<@${castId}>`, inline: true },
        { name: "商品名", value: item.name, inline: false },
        { name: "単価", value: `${item.price.toLocaleString()}${currencyName}`, inline: true },
        { name: "個数", value: `${quantity}個`, inline: true },
        { name: "合計金額", value: `${totalPrice.toLocaleString()}${currencyName}`, inline: true },
      )
      .setTimestamp();

    await logChannel.send({
      embeds: [embed],
      allowedMentions: { users: [buyerId, castId], roles: [] },
    });
    return true;
  } catch (error) {
    logger.warn("[forum-shop] Failed to post purchase log", error);
    return false;
  }
}

const FORUM_SUPPORTED_EFFECTS = new Set([
  PERM_ROLE_EFFECT,
  EVAL_RESURFACE_EFFECT,
  SHOP_LICENSE_EFFECT,
]);

async function completeForumPurchase(
  interaction: UserSelectMenuInteraction,
  itemId: number,
  quantity: number,
  castId: string,
): Promise<void> {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.editReply("この操作はサーバー内でのみ使用できます。");
    return;
  }

  const panel = await getConfiguredForumPanel(interaction.guildId, interaction.channelId, itemId);
  const item = await getShopItem(interaction.guildId, itemId);
  if (!panel || !item || item.category !== "forum") {
    await interaction.editReply("この購入パネルは見つからないか、すでに無効です。");
    return;
  }
  if (!panel.logChannelId) {
    await interaction.editReply("購入ログ先が未設定です。管理者にパネルの再設定を依頼してください。");
    return;
  }
  if (item.effectType && !FORUM_SUPPORTED_EFFECTS.has(item.effectType)) {
    await interaction.editReply("この商品はフォーラム購入フローに対応していない特殊効果が設定されています。");
    return;
  }

  const castMember = await interaction.guild.members.fetch(castId).catch(() => null);
  if (!castMember || castMember.user.bot) {
    await interaction.editReply("指定されたキャストが見つからないか、Botが選択されています。");
    return;
  }

  const settings = await getGuildSettings(interaction.guildId);
  const buyerMember = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);

  if (item.effectType === SHOP_LICENSE_EFFECT && buyerMember && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    const allowedRoles = ["本船員", "航海士", "提督", "大提督"];
    const hasAllowedRole = interaction.guild.roles.cache.some(
      (role) => allowedRoles.includes(role.name) && buyerMember.roles.cache.has(role.id),
    );
    if (!hasAllowedRole) {
      await interaction.editReply("❌ 個人ショップ開業券は本船員以上のロールを持つメンバーのみ購入できます。");
      return;
    }
  }

  const result = await buyItemQuantity(
    interaction.guildId,
    interaction.user.id,
    itemId,
    settings.currencyName,
    quantity,
  );
  if (!result.ok) {
    await interaction.editReply(result.reason);
    return;
  }

  let roleGranted = false;
  try {
    if (item.targetRoleId) {
      const member = buyerMember ?? await interaction.guild.members.fetch(interaction.user.id);
      markAdviceRoleGrantFromPurchase(interaction.guildId, interaction.user.id, item.targetRoleId);
      await member.roles.add(item.targetRoleId);
      roleGranted = true;

      if (item.effectType === EVAL_RESURFACE_EFFECT) {
        markTimedRoleGrantFromPurchase(interaction.guildId, interaction.user.id, item.targetRoleId);
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await upsertTimedRoleGrant(
          interaction.guildId,
          interaction.user.id,
          item.targetRoleId,
          EVAL_RESURFACE_EFFECT,
          expiresAt,
        );
      }
    }

    const logged = await logForumPurchase(
      interaction.guild,
      panel.logChannelId,
      interaction.user.id,
      castId,
      result.item,
      quantity,
      result.totalPrice,
      settings.currencyName,
    );
    await interaction.editReply(
      `✅ 購入を受け付けました。\n指定のキャスト: <@${castId}>\n個数: ${quantity}個\n合計金額: ${result.totalPrice.toLocaleString()}${settings.currencyName}${logged ? "" : "\n⚠️ 購入ログの投稿に失敗しました。管理者に連絡してください。"}`,
    );
  } catch (error) {
    if (roleGranted) {
      logger.error("[forum-shop] Role was granted but finalization failed", error);
    }
    await refundPurchase(interaction.guildId, interaction.user.id, result.item, quantity);
    await interaction.editReply("❌ 購入処理に失敗したため、購入を取り消して返金しました。");
  }
}

export async function handleForumPurchaseQuantity(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const itemId = Number(interaction.customId.slice(FORUM_QUANTITY_PREFIX.length));
  const quantity = Number(interaction.values[0]);
  if (!Number.isInteger(itemId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 25) {
    await interaction.update({ content: "不正な購入個数です。", components: [] });
    return;
  }

  const panel = interaction.guildId
    ? await getConfiguredForumPanel(interaction.guildId, interaction.channelId, itemId)
    : null;
  if (!panel?.logChannelId) {
    await interaction.update({
      content: "この購入パネルは無効か、購入ログ先が未設定です。",
      components: [],
    });
    return;
  }

  await interaction.update({
    content: "指定するキャストを選択してください。",
    ...buildForumCastPicker(itemId, quantity),
  });
}

export async function handleForumPurchaseCast(
  interaction: UserSelectMenuInteraction,
): Promise<void> {
  const payload = interaction.customId.slice(FORUM_CAST_PREFIX.length).split(":");
  const itemId = Number(payload[0]);
  const quantity = Number(payload[1]);
  const castId = interaction.values[0];
  if (
    !Number.isInteger(itemId)
    || !Number.isInteger(quantity)
    || quantity < 1
    || quantity > 25
    || !castId
  ) {
    await interaction.update({ content: "不正な購入情報です。", components: [] });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  await completeForumPurchase(interaction, itemId, quantity, castId);
}

export async function handleShopBuyButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "このボタンはサーバー内でのみ使用できます。", ephemeral: true });
    return;
  }

  const itemId = Number(interaction.customId.slice(SHOP_BUY_PREFIX.length));
  if (!Number.isInteger(itemId)) {
    await interaction.reply({ content: "不正なボタンです。", ephemeral: true });
    return;
  }

  const item = await getShopItem(interaction.guildId, itemId);
  if (!item) {
    await interaction.reply({ content: "そのアイテムは見つかりませんでした。", ephemeral: true });
    return;
  }

  if (item.category === "forum") {
    const panel = await getConfiguredForumPanel(interaction.guildId, interaction.channelId, itemId);
    if (!panel?.logChannelId) {
      await interaction.reply({
        content: "この購入パネルは無効か、購入ログ先が未設定です。管理者にパネルの再設定を依頼してください。",
        ephemeral: true,
      });
      return;
    }
    await interaction.reply({
      content: "購入個数を選択してください。",
      ...buildForumQuantityPicker(itemId),
      ephemeral: true,
    });
    return;
  }

  // Nickname-change / VC-rename items need text input → show modal, no defer.
  if (item.effectType === NICKNAME_CHANGE_EFFECT) {
    await interaction.showModal(buildNicknameModal(item.id));
    return;
  }
  if (item.effectType === VC_RENAME_EFFECT) {
    await interaction.showModal(buildVcRenameModal(item.id));
    return;
  }

  // Defer immediately so DB latency can't blow past Discord's initial
  // response window and fail the interaction.
  await interaction.deferReply({ ephemeral: true });

  const settings = await getGuildSettings(interaction.guildId);

  const vcDuration = TIMED_VC_DURATIONS[item.effectType ?? ""];
  if (item.effectType === PRIVATE_VC_EFFECT || vcDuration !== undefined) {
    const member = await interaction.guild!.members.fetch(interaction.user.id);
    const roomCategory = getPrivateVcRoomCategory(item.category);
    const freeRoomSettings = isFreeRoomCategory(roomCategory)
      ? await resolveFreeRoomSettings(interaction.guild!)
      : { categoryId: null, accessRoleIds: [] };
    const roomCategoryId = roomCategory === "island"
      ? freeRoomSettings.categoryId
      : roomCategory === "ura"
        ? settings.uraCategoryId
        : settings.vcCategoryId;
    const result = await purchaseAndCreatePrivateVc(
      interaction.guild!,
      member,
      itemId,
      settings.currencyName,
      vcDuration,
      roomCategoryId,
      isFreeRoomCategory(roomCategory) ? freeRoomSettings.accessRoleIds : [],
      roomCategory,
      roomCategory === "ura" ? settings.uraChannelId : null,
    );
    if (result.ok) {
      const ts = result.expiresAt ? Math.floor(result.expiresAt.getTime() / 1000) : null;
      const expiry = ts ? `\n期限: <t:${ts}:F>（<t:${ts}:R>に自動削除）` : "";
      const roomLabel = isFreeRoomCategory(roomCategory) ? "フリールーム" : "高級船室";
      await interaction.editReply(`**${result.item.name}**を購入しました! あなた専用の${roomLabel}: <#${result.channelId}>${expiry}`);
    } else {
      await interaction.editReply(result.reason);
    }
    return;
  }

  // Eval-sheet extension券: buy first, then extend the community eval sheet.
  if (item.effectType === EVAL_EXTEND_2W_EFFECT || item.effectType === EVAL_EXTEND_1M_EFFECT) {
    await interaction.editReply("❌ 評価シート延長は1週間のみ利用できます。");
    return;
  }
  const extendDays = EVAL_EXTEND_DAYS[item.effectType ?? ""];
  if (extendDays !== undefined) {
    // ① 評価中ロールを持っていない人は購入不可
    const sheetSettingsForExt = await getEvalSheetSettings(interaction.guildId);
    const triggerRoleIdsForExt = sheetSettingsForExt?.triggerRoleIds?.split(",").map((r) => r.trim()).filter(Boolean) ?? [];
    if (triggerRoleIdsForExt.length > 0) {
      const memberForExt = await interaction.guild!.members.fetch(interaction.user.id);
      if (!memberForExt.roles.cache.hasAny(...triggerRoleIdsForExt)) {
        await interaction.editReply("❌ この商品は評価中のメンバーのみ購入できます。");
        return;
      }
    }
    // ② サーバー内で一人1回のみ購入可（過去の評価シートも含む）
    if (await hasUsedEvalExtension(interaction.guildId, interaction.user.id)) {
      await interaction.editReply("❌ 評価シート延長券は1人1回しか購入できません。");
      return;
    }
    const result = await buyItem(interaction.guildId, interaction.user.id, itemId, settings.currencyName);
    if (!result.ok) { await interaction.editReply(result.reason); return; }
    const extended = await extendCommunitySheet(interaction.guildId, interaction.user.id, extendDays);
    if (extended) {
      const ts = Math.floor(extended.newEndDate.getTime() / 1000);
      await interaction.editReply(
        `✅ **${result.item.name}**を購入しました！\n評価シートの期限を **<t:${ts}:D>** まで延長しました。`,
      );
      applySheetEmbedUpdate(interaction.client, interaction.guildId, extended).catch((err) => logger.error("[sheet] applySheetEmbedUpdate error", err));
    } else {
      await refundPurchase(interaction.guildId, interaction.user.id, result.item);
      await interaction.editReply(
        "❌ 評価シートが見つかりませんでした。購入を取り消し、返金しました。\n管理者に評価シートの作成を依頼してください。",
      );
    }
    return;
  }

  // 永久ロール付与
  if (item.effectType === PERM_ROLE_EFFECT) {
    if (!item.targetRoleId) {
      await interaction.editReply("❌ このアイテムにはロールが設定されていません。管理者に連絡してください。");
      return;
    }
    const result = await buyItem(interaction.guildId, interaction.user.id, itemId, settings.currencyName);
    if (!result.ok) { await interaction.editReply(result.reason); return; }
    let roleGranted = false;
    try {
      const member = await interaction.guild!.members.fetch(interaction.user.id);
      markAdviceRoleGrantFromPurchase(interaction.guildId, interaction.user.id, item.targetRoleId);
      await member.roles.add(item.targetRoleId);
      roleGranted = true;
      await logAdviceTicketPurchase(interaction.guild!, interaction.user.id, result.item, item.targetRoleId);
      // Role is now granted — don't refund if the reply itself fails.
      await interaction.editReply(`✅ **${result.item.name}**を購入しました！ロール <@&${item.targetRoleId}> が付与されました。`)
        .catch((err) => logger.error("[shop] editReply failed after role grant (perm-role)", err));
    } catch {
      if (!roleGranted) {
        await refundPurchase(interaction.guildId, interaction.user.id, result.item);
        await interaction.editReply("❌ ロールの付与に失敗しました。購入を取り消し、返金しました。");
      }
    }
    return;
  }

  // オチテモータ島浮上券
  if (item.effectType === EVAL_RESURFACE_EFFECT) {
    const result = await buyItem(interaction.guildId, interaction.user.id, itemId, settings.currencyName);
    if (!result.ok) { await interaction.editReply(result.reason); return; }
    if (item.targetRoleId) {
      try {
        const member = await interaction.guild!.members.fetch(interaction.user.id);
        markAdviceRoleGrantFromPurchase(interaction.guildId, interaction.user.id, item.targetRoleId);
        markTimedRoleGrantFromPurchase(interaction.guildId, interaction.user.id, item.targetRoleId);
        await member.roles.add(item.targetRoleId);
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await upsertTimedRoleGrant(interaction.guildId, interaction.user.id, item.targetRoleId, EVAL_RESURFACE_EFFECT, expiresAt);
        const expTs = Math.floor(expiresAt.getTime() / 1000);
        await interaction.editReply(`✅ **${result.item.name}**を購入しました！ロール <@&${item.targetRoleId}> が付与されました。（<t:${expTs}:F> に自動解除）`);
      } catch {
        clearTimedRoleGrantFromPurchase(interaction.guildId, interaction.user.id, item.targetRoleId);
        await refundPurchase(interaction.guildId, interaction.user.id, result.item);
        await interaction.editReply("❌ ロールの付与に失敗しました。購入を取り消し、返金しました。");
      }
    } else {
      await interaction.editReply(`✅ **${result.item.name}**を購入しました！`);
    }
    return;
  }

  // 高級船室延長（category="vc"）
  const vcExtendDuration = VC_EXTEND_DURATIONS[item.effectType ?? ""];
  if (vcExtendDuration !== undefined) {
    const session = await getActivePrivateVcSession(interaction.guildId, interaction.user.id, "vc");
    if (!session) {
      await interaction.editReply("❌ 有効な高級船室がありません。先に購入してください。");
      return;
    }
    const result = await buyItem(interaction.guildId, interaction.user.id, itemId, settings.currencyName);
    if (!result.ok) { await interaction.editReply(result.reason); return; }
    try {
      const updated = await extendPrivateVcSession(session.id, vcExtendDuration);
      // Propagate the new deadline to the VC schedule row and re-arm the
      // pre-expiry warning so the scheduler DMs the owner at the right time.
      // Resolve the channel name from the guild cache for use as a fallback
      // schedule name in case extendOrRepairVcSchedule needs to create a new row.
      const chForBtn = interaction.guild!.channels.cache.get(session.channelId)
        ?? await interaction.guild!.channels.fetch(session.channelId).catch(() => null);
      const fallbackNameBtn = chForBtn && "name" in chForBtn && chForBtn.name
        ? chForBtn.name
        : session.channelId;
      await extendOrRepairVcSchedule({
        channelId: session.channelId,
        guildId: interaction.guildId,
        newExpiresAt: updated.expiresAt,
        fallbackName: fallbackNameBtn,
        userId: interaction.user.id,
        logPrefix: "vc-extend",
      });
      // Update the expiry display in the VC's voice-text channel (best-effort).
      try {
        const textCh = chForBtn;
        if (textCh && "messages" in textCh) {
          const msgs = await (textCh as import("discord.js").TextBasedChannel).messages.fetch({ limit: 20 });
          const panelMsg = msgs.find(
            (m) => m.author.id === interaction.client.user?.id
              && (m.embeds[0]?.title === VC_PANEL_TITLE || LEGACY_VC_PANEL_TITLES.has(m.embeds[0]?.title ?? "")),
          );
          if (panelMsg) {
            const memberIds = getVcAccessMemberIds(textCh as import("discord.js").GuildChannel, interaction.user.id, interaction.client.user?.id);
            await panelMsg.edit(buildVcPanelMessage(session.channelId, interaction.user.id, updated.expiresAt, memberIds, undefined, isFreeRoomCategory(session.category)));
          }
        }
      } catch (panelErr) {
        logger.error(`[vc-extend] Failed to update panel message for channel ${session.channelId}`, panelErr);
      }
      const ts = Math.floor(updated.expiresAt.getTime() / 1000);
      await interaction.editReply(`✅ **${result.item.name}**を購入しました！\n高級船室の期限を <t:${ts}:F>（<t:${ts}:R>）まで延長しました。`);
    } catch {
      await refundPurchase(interaction.guildId, interaction.user.id, result.item);
      await interaction.editReply("❌ 延長に失敗したため、購入を取り消し、返金しました。");
    }
    return;
  }

  // 個人ショップ開業券
  if (item.effectType === SHOP_LICENSE_EFFECT) {
    const isAdminForLicense = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
    const memberForLicense = await interaction.guild!.members.fetch(interaction.user.id);
    if (!isAdminForLicense) {
      const allowedRoles = ["本船員", "航海士", "提督", "大提督"];
      const hasAllowedRole = interaction.guild!.roles.cache.some(
        (r) => allowedRoles.includes(r.name) && memberForLicense.roles.cache.has(r.id),
      );
      if (!hasAllowedRole) {
        await interaction.editReply("❌ 個人ショップ開業券は本船員以上のロールを持つメンバーのみ購入できます。");
        return;
      }
    }
    const result = await buyItem(interaction.guildId, interaction.user.id, itemId, settings.currencyName);
    if (!result.ok) { await interaction.editReply(result.reason); return; }
    if (item.targetRoleId) {
      try {
        markAdviceRoleGrantFromPurchase(interaction.guildId, interaction.user.id, item.targetRoleId);
        await memberForLicense.roles.add(item.targetRoleId);
        tryRecordGroupSale(interaction.guild!, interaction.guildId, interaction.user.id, result.item).catch(() => {});
        await interaction.editReply(`✅ **${result.item.name}**を購入しました！ショップ開業ロール <@&${item.targetRoleId}> が付与されました。`)
          .catch((err) => logger.error("[shop] editReply failed after role grant (shop-license)", err));
      } catch {
        await refundPurchase(interaction.guildId, interaction.user.id, result.item);
        await interaction.editReply("❌ ロールの付与に失敗しました。購入を取り消し、返金しました。");
      }
    } else {
      tryRecordGroupSale(interaction.guild!, interaction.guildId, interaction.user.id, result.item).catch(() => {});
      await interaction.editReply(`✅ **${result.item.name}**を購入しました！`);
    }
    return;
  }

  const result = await buyItem(interaction.guildId, interaction.user.id, itemId, settings.currencyName);

  if (result.ok) {
    if (item.targetRoleId) {
      let roleGranted = false;
      try {
        const member = await interaction.guild!.members.fetch(interaction.user.id);
        markAdviceRoleGrantFromPurchase(interaction.guildId, interaction.user.id, item.targetRoleId);
        await member.roles.add(item.targetRoleId);
        roleGranted = true;
        await logAdviceTicketPurchase(interaction.guild!, interaction.user.id, result.item, item.targetRoleId);
        // Role granted — record group sale and reply best-effort.
        if (item.category === "group") tryRecordGroupSale(interaction.guild!, interaction.guildId, interaction.user.id, result.item).catch(() => {});
        await interaction.editReply(`✅ **${result.item.name}**を購入しました！ロール <@&${item.targetRoleId}> が付与されました。`)
          .catch((err) => logger.error("[shop] editReply failed after role grant (generic)", err));
      } catch {
        if (!roleGranted) {
          await refundPurchase(interaction.guildId, interaction.user.id, result.item);
          await interaction.editReply("❌ ロールの付与に失敗しました。購入を取り消し、返金しました。");
        }
      }
    } else {
      await interaction.editReply(`✅ **${result.item.name}**を購入しました！`);
      if (item.category === "group") tryRecordGroupSale(interaction.guild!, interaction.guildId, interaction.user.id, result.item).catch(() => {});
    }
  } else {
    await interaction.editReply(result.reason);
  }
}

// ── セレクトメニュー版ショップ購入ハンドラ ──────────────────────────
// handleShopBuyButton と同じロジックだが StringSelectMenuInteraction を受け取る
async function applyShopPurchase(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  itemId: number,
): Promise<void> {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({ content: "このコンポーネントはサーバー内でのみ使用できます。", ephemeral: true });
    return;
  }

  const item = await getShopItem(interaction.guildId, itemId);
  if (!item) {
    await interaction.reply({ content: "そのアイテムは見つかりませんでした。", ephemeral: true });
    return;
  }

  // モーダルが必要なアイテムは defer せずにモーダルを表示
  if (item.effectType === NICKNAME_CHANGE_EFFECT) {
    await interaction.showModal(buildNicknameModal(item.id));
    return;
  }
  if (item.effectType === VC_RENAME_EFFECT) {
    await interaction.showModal(buildVcRenameModal(item.id));
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const settings = await getGuildSettings(interaction.guildId);

  const vcDuration = TIMED_VC_DURATIONS[item.effectType ?? ""];
  if (item.effectType === PRIVATE_VC_EFFECT || vcDuration !== undefined) {
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const roomCategory = getPrivateVcRoomCategory(item.category);
    const freeRoomSettings = isFreeRoomCategory(roomCategory)
      ? await resolveFreeRoomSettings(interaction.guild)
      : { categoryId: null, accessRoleIds: [] };
    const roomCategoryId = roomCategory === "island"
      ? freeRoomSettings.categoryId
      : roomCategory === "ura"
        ? settings.uraCategoryId
        : settings.vcCategoryId;
    const result = await purchaseAndCreatePrivateVc(
      interaction.guild,
      member,
      itemId,
      settings.currencyName,
      vcDuration,
      roomCategoryId,
      isFreeRoomCategory(roomCategory) ? freeRoomSettings.accessRoleIds : [],
      roomCategory,
      roomCategory === "ura" ? settings.uraChannelId : null,
    );
    if (result.ok) {
      const ts = result.expiresAt ? Math.floor(result.expiresAt.getTime() / 1000) : null;
      const expiry = ts ? `\n期限: <t:${ts}:F>（<t:${ts}:R>に自動削除）` : "";
      const roomLabel = isFreeRoomCategory(roomCategory) ? "フリールーム" : "高級船室";
      await interaction.editReply(`**${result.item.name}**を購入しました! あなた専用の${roomLabel}: <#${result.channelId}>${expiry}`);
    } else {
      await interaction.editReply(result.reason);
    }
    return;
  }

  if (item.effectType === EVAL_EXTEND_2W_EFFECT || item.effectType === EVAL_EXTEND_1M_EFFECT) {
    await interaction.editReply("❌ 評価シート延長は1週間のみ利用できます。");
    return;
  }
  const extendDays = EVAL_EXTEND_DAYS[item.effectType ?? ""];
  if (extendDays !== undefined) {
    const sheetSettingsForExt = await getEvalSheetSettings(interaction.guildId);
    const triggerRoleIdsForExt = sheetSettingsForExt?.triggerRoleIds?.split(",").map((r) => r.trim()).filter(Boolean) ?? [];
    if (triggerRoleIdsForExt.length > 0) {
      const memberForExt = await interaction.guild.members.fetch(interaction.user.id);
      if (!memberForExt.roles.cache.hasAny(...triggerRoleIdsForExt)) {
        await interaction.editReply("❌ この商品は評価中のメンバーのみ購入できます。");
        return;
      }
    }
    if (await hasUsedEvalExtension(interaction.guildId, interaction.user.id)) {
      await interaction.editReply("❌ 評価シート延長券は1人1回しか購入できません。");
      return;
    }
    const result = await buyItem(interaction.guildId, interaction.user.id, itemId, settings.currencyName);
    if (!result.ok) { await interaction.editReply(result.reason); return; }
    const extended = await extendCommunitySheet(interaction.guildId, interaction.user.id, extendDays);
    if (extended) {
      const ts = Math.floor(extended.newEndDate.getTime() / 1000);
      await interaction.editReply(
        `✅ **${result.item.name}**を購入しました！\n評価シートの期限を **<t:${ts}:D>** まで延長しました。`,
      );
      applySheetEmbedUpdate(interaction.client, interaction.guildId, extended).catch((err) => logger.error("[sheet] applySheetEmbedUpdate error", err));
    } else {
      await refundPurchase(interaction.guildId, interaction.user.id, result.item);
      await interaction.editReply("❌ 評価シートが見つかりませんでした。購入を取り消し、返金しました。\n管理者に評価シートの作成を依頼してください。");
    }
    return;
  }

  if (item.effectType === PERM_ROLE_EFFECT) {
    if (!item.targetRoleId) {
      await interaction.editReply("❌ このアイテムにはロールが設定されていません。管理者に連絡してください。");
      return;
    }
    const result = await buyItem(interaction.guildId, interaction.user.id, itemId, settings.currencyName);
    if (!result.ok) { await interaction.editReply(result.reason); return; }
    try {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      markAdviceRoleGrantFromPurchase(interaction.guildId, interaction.user.id, item.targetRoleId);
      await member.roles.add(item.targetRoleId);
      await logAdviceTicketPurchase(interaction.guild, interaction.user.id, result.item, item.targetRoleId);
      await interaction.editReply(`✅ **${result.item.name}**を購入しました！ロール <@&${item.targetRoleId}> が付与されました。`);
    } catch {
      await refundPurchase(interaction.guildId, interaction.user.id, result.item);
      await interaction.editReply("❌ ロールの付与に失敗しました。購入を取り消し、返金しました。");
    }
    return;
  }

  if (item.effectType === EVAL_RESURFACE_EFFECT) {
    const result = await buyItem(interaction.guildId, interaction.user.id, itemId, settings.currencyName);
    if (!result.ok) { await interaction.editReply(result.reason); return; }
    if (item.targetRoleId) {
      try {
        const member = await interaction.guild.members.fetch(interaction.user.id);
        markAdviceRoleGrantFromPurchase(interaction.guildId, interaction.user.id, item.targetRoleId);
        markTimedRoleGrantFromPurchase(interaction.guildId, interaction.user.id, item.targetRoleId);
        await member.roles.add(item.targetRoleId);
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await upsertTimedRoleGrant(interaction.guildId, interaction.user.id, item.targetRoleId, EVAL_RESURFACE_EFFECT, expiresAt);
        const expTs = Math.floor(expiresAt.getTime() / 1000);
        await interaction.editReply(`✅ **${result.item.name}**を購入しました！ロール <@&${item.targetRoleId}> が付与されました。（<t:${expTs}:F> に自動解除）`);
      } catch {
        clearTimedRoleGrantFromPurchase(interaction.guildId, interaction.user.id, item.targetRoleId);
        await refundPurchase(interaction.guildId, interaction.user.id, result.item);
        await interaction.editReply("❌ ロールの付与に失敗しました。購入を取り消し、返金しました。");
      }
    } else {
      await interaction.editReply(`✅ **${result.item.name}**を購入しました！`);
    }
    return;
  }

  // 高級船室延長（category="vc"）
  const vcExtendDuration = VC_EXTEND_DURATIONS[item.effectType ?? ""];
  if (vcExtendDuration !== undefined) {
    const session = await getActivePrivateVcSession(interaction.guildId, interaction.user.id, "vc");
    if (!session) {
      await interaction.editReply("❌ 有効な高級船室がありません。先に購入してください。");
      return;
    }
    const result = await buyItem(interaction.guildId, interaction.user.id, itemId, settings.currencyName);
    if (!result.ok) { await interaction.editReply(result.reason); return; }
    try {
      const updated = await extendPrivateVcSession(session.id, vcExtendDuration);
      // Propagate the new deadline to the VC schedule row and re-arm the
      // pre-expiry warning so the scheduler DMs the owner at the right time.
      // Resolve the channel name from the guild cache for use as a fallback
      // schedule name in case extendOrRepairVcSchedule needs to create a new row.
      const chForSel = interaction.guild.channels.cache.get(session.channelId)
        ?? await interaction.guild.channels.fetch(session.channelId).catch(() => null);
      const fallbackNameSel = chForSel && "name" in chForSel && chForSel.name
        ? chForSel.name
        : session.channelId;
      await extendOrRepairVcSchedule({
        channelId: session.channelId,
        guildId: interaction.guildId,
        newExpiresAt: updated.expiresAt,
        fallbackName: fallbackNameSel,
        userId: interaction.user.id,
        logPrefix: "vc-extend",
      });
      // Update the expiry display in the VC's voice-text channel (best-effort).
      try {
        const textCh = chForSel;
        if (textCh && "messages" in textCh) {
          const msgs = await (textCh as import("discord.js").TextBasedChannel).messages.fetch({ limit: 20 });
          const panelMsg = msgs.find(
            (m) => m.author.id === interaction.client.user?.id
              && (m.embeds[0]?.title === VC_PANEL_TITLE || LEGACY_VC_PANEL_TITLES.has(m.embeds[0]?.title ?? "")),
          );
          if (panelMsg) {
            const memberIds = getVcAccessMemberIds(textCh as import("discord.js").GuildChannel, interaction.user.id, interaction.client.user?.id);
            await panelMsg.edit(buildVcPanelMessage(session.channelId, interaction.user.id, updated.expiresAt, memberIds, undefined, isFreeRoomCategory(session.category)));
          }
        }
      } catch (panelErr) {
        logger.error(`[vc-extend] Failed to update panel message for channel ${session.channelId}`, panelErr);
      }
      const ts = Math.floor(updated.expiresAt.getTime() / 1000);
      await interaction.editReply(`✅ **${result.item.name}**を購入しました！\n高級船室の期限を <t:${ts}:F>（<t:${ts}:R>）まで延長しました。`);
    } catch {
      await refundPurchase(interaction.guildId, interaction.user.id, result.item);
      await interaction.editReply("❌ 延長に失敗したため、購入を取り消し、返金しました。");
    }
    return;
  }

  if (item.effectType === SHOP_LICENSE_EFFECT) {
    const isAdminForLicense = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!isAdminForLicense) {
      const allowedRoles = ["本船員", "航海士", "提督", "大提督"];
      const hasAllowedRole = interaction.guild!.roles.cache.some(
        (r) => allowedRoles.includes(r.name) && member.roles.cache.has(r.id),
      );
      if (!hasAllowedRole) {
        await interaction.editReply("❌ 個人ショップ開業券は本船員以上のロールを持つメンバーのみ購入できます。");
        return;
      }
    }
    const result = await buyItem(interaction.guildId, interaction.user.id, itemId, settings.currencyName);
    if (!result.ok) { await interaction.editReply(result.reason); return; }
    if (item.targetRoleId) {
      try {
        markAdviceRoleGrantFromPurchase(interaction.guildId, interaction.user.id, item.targetRoleId);
        await member.roles.add(item.targetRoleId);
        tryRecordGroupSale(interaction.guild!, interaction.guildId, interaction.user.id, result.item).catch(() => {});
        await interaction.editReply(`✅ **${result.item.name}**を購入しました！ショップ開業ロール <@&${item.targetRoleId}> が付与されました。`)
          .catch((err) => logger.error("[shop] editReply failed after role grant (shop-license/select)", err));
      } catch {
        await refundPurchase(interaction.guildId, interaction.user.id, result.item);
        await interaction.editReply("❌ ロールの付与に失敗しました。購入を取り消し、返金しました。");
      }
    } else {
      tryRecordGroupSale(interaction.guild!, interaction.guildId, interaction.user.id, result.item).catch(() => {});
      await interaction.editReply(`✅ **${result.item.name}**を購入しました！`);
    }
    return;
  }

  const result = await buyItem(interaction.guildId, interaction.user.id, itemId, settings.currencyName);
  if (result.ok) {
    if (item.targetRoleId) {
      let roleGranted = false;
      try {
        const member = await interaction.guild.members.fetch(interaction.user.id);
        markAdviceRoleGrantFromPurchase(interaction.guildId, interaction.user.id, item.targetRoleId);
        await member.roles.add(item.targetRoleId);
        roleGranted = true;
        await logAdviceTicketPurchase(interaction.guild!, interaction.user.id, result.item, item.targetRoleId);
        // Role granted — record group sale and reply best-effort.
        if (item.category === "group") tryRecordGroupSale(interaction.guild!, interaction.guildId, interaction.user.id, result.item).catch(() => {});
        await interaction.editReply(`✅ **${result.item.name}**を購入しました！ロール <@&${item.targetRoleId}> が付与されました。`)
          .catch((err) => logger.error("[shop] editReply failed after role grant (generic/select)", err));
      } catch {
        if (!roleGranted) {
          await refundPurchase(interaction.guildId, interaction.user.id, result.item);
          await interaction.editReply("❌ ロールの付与に失敗しました。購入を取り消し、返金しました。");
        }
      }
    } else {
      await interaction.editReply(`✅ **${result.item.name}**を購入しました！`);
      if (item.category === "group") tryRecordGroupSale(interaction.guild!, interaction.guildId, interaction.user.id, result.item).catch(() => {});
    }
  } else {
    await interaction.editReply(result.reason);
  }
}

export async function handleShopSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
  const itemId = Number(interaction.values[0]);
  if (!Number.isInteger(itemId)) {
    await interaction.reply({ content: "不正な選択です。", ephemeral: true });
    return;
  }
  await applyShopPurchase(interaction, itemId);
}

export async function handleVcRenameModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: "このフォームはサーバー内でのみ使用できます。", ephemeral: true });
    return;
  }

  const itemId = Number(interaction.customId.slice(VC_RENAME_MODAL_PREFIX.length));
  const newName = interaction.fields.getTextInputValue(VC_RENAME_MODAL_INPUT_ID).trim();

  if (!Number.isInteger(itemId) || newName.length === 0) {
    await interaction.reply({ content: "不正な入力です。", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const settings = await getGuildSettings(interaction.guild.id);

  // Find the user's private VC: a guild voice channel where they have an
  // explicit ViewChannel allow overwrite (set by the bot on creation).
  const userId = interaction.user.id;
  const privateVc = interaction.guild.channels.cache.find(
    (ch) =>
      ch.type === ChannelType.GuildVoice &&
      ch.name.startsWith("🔒") &&
      ch.permissionOverwrites.cache.some(
        (ow) => ow.id === userId && ow.allow.has(PermissionFlagsBits.ViewChannel),
      ),
  );

  if (!privateVc) {
    await interaction.editReply("❌ あなたの高級船室が見つかりません。先にVCを作成してください。");
    return;
  }

  // Charge before renaming.
  const result = await buyItem(interaction.guild.id, userId, itemId, settings.currencyName);
  if (!result.ok) {
    await interaction.editReply(result.reason);
    return;
  }

  try {
    const renamedName = `🔒 ${newName}`.slice(0, 100);
    await privateVc.setName(renamedName);
    await interaction.editReply(`✅ **${result.item.name}**を使用しました！VCを「${renamedName}」にリネームしました。`);

    // Record the rename in vc_schedules so the pre-expiry warning scheduler can
    // notify this user before the channel is automatically deleted.
    try {
      const session =
        (await getActivePrivateVcSession(interaction.guild.id, userId, "vc"));
      if (session?.expiresAt) {
        await saveSchedule(
          interaction.guild.id,
          privateVc.id,
          renamedName,
          session.expiresAt,
          userId,
        );
      }
    } catch (scheduleErr) {
      // Best-effort — schedule tracking failure does not affect the rename.
      logger.error("[vc-rename] Failed to save VC schedule after rename", scheduleErr);
    }
  } catch {
    await refundPurchase(interaction.guild.id, userId, result.item);
    await interaction.editReply("❌ チャンネルのリネームに失敗しました。購入を取り消し、返金しました。");
  }
}

export async function handleNicknameModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: "このフォームはサーバー内でのみ使用できます。", ephemeral: true });
    return;
  }

  const itemId = Number(interaction.customId.slice(NICKNAME_MODAL_PREFIX.length));
  const nickname = interaction.fields.getTextInputValue(NICKNAME_MODAL_INPUT_ID).trim();

  if (!Number.isInteger(itemId) || nickname.length === 0) {
    await interaction.reply({ content: "不正な入力です。", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  // Fetch a full GuildMember object so setNickname() and role cache are available.
  // interaction.member may be a raw APIInteractionGuildMember without methods.
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const settings = await getGuildSettings(interaction.guild.id);
  const result = await purchaseAndApplyEffect(
    interaction.guild.id,
    member,
    itemId,
    settings.currencyName,
    nickname,
  );

  if (result.ok) {
    await interaction.editReply(`**${result.item.name}**を購入し、ニックネームを「${nickname}」に変更しました!`);
    // 評価シートのスレッド名とEmbedを新しい表示名に更新（fire-and-forget）
    refreshSheetEmbedForUser(interaction.client, interaction.guild.id, interaction.user.id, nickname)
      .catch((err) => logger.error("[sheet] refreshSheetEmbedForUser error", err));
  } else {
    await interaction.editReply(result.reason);
  }
}


const balanceCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("残高確認")
    .setDescription("残高を表示します。管理者はメンバーを指定して確認できます")
    .addUserOption((opt) =>
      opt.setName("メンバー").setDescription("確認するメンバー（省略時は自分）").setRequired(false),
    ),
  async execute(interaction) {
    const guildId = requireGuild(interaction);
    const targetUser = interaction.options.getUser("メンバー");

    // 他人を指定した場合は管理者権限チェック
    if (targetUser && targetUser.id !== interaction.user.id) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: "❌ 他のメンバーの残高を確認するには管理者権限が必要です。", ephemeral: true });
        return;
      }
    }

    const subject = targetUser ?? interaction.user;
    const [wallet, settings] = await Promise.all([
      getOrCreateWallet(guildId, subject.id),
      getGuildSettings(guildId),
    ]);

    const member = interaction.guild?.members.cache.get(subject.id)
      ?? await interaction.guild?.members.fetch(subject.id).catch(() => null);
    const displayName = member?.displayName ?? subject.displayName ?? subject.username;
    const avatarUrl = member?.displayAvatarURL() ?? subject.displayAvatarURL();

    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setAuthor({ name: displayName, iconURL: avatarUrl })
      .setDescription(`残高: **${wallet.balance.toLocaleString()}${settings.currencyName}**`);
    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};

const payCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("送金")
    .setDescription("他のユーザーに送金します")
    .addUserOption((opt) =>
      opt.setName("相手").setDescription("送金先のユーザー").setRequired(true),
    )
    .addIntegerOption((opt) =>
      opt.setName("金額").setDescription("送金額").setRequired(true).setMinValue(1),
    )
    .addStringOption((opt) =>
      opt.setName("メモ").setDescription("メモ（任意、最大100文字）").setRequired(false).setMaxLength(100),
    ),
  async execute(interaction) {
    const guildId = requireGuild(interaction);
    const target = interaction.options.getUser("相手", true);
    const amount = interaction.options.getInteger("金額", true);
    const memo   = interaction.options.getString("メモ");

    const isSelf = target.id === interaction.client.user?.id;
    if (target.bot && !isSelf) {
      await interaction.reply({ content: "Botには送金できません。", ephemeral: true });
      return;
    }

    const settings = await getGuildSettings(guildId);
    const result = await transfer(guildId, interaction.user.id, target.id, amount, settings.currencyName);
    if (result.ok) {
      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setAuthor({ name: interaction.user.displayName ?? interaction.user.username, iconURL: (interaction.member as GuildMember)?.displayAvatarURL() ?? interaction.user.displayAvatarURL() })
        .setThumbnail((interaction.member as GuildMember)?.displayAvatarURL() ?? interaction.user.displayAvatarURL())
        .setDescription(`<@${target.id}> に **${amount.toLocaleString()}${settings.currencyName}** を送金しました`);
      if (memo) embed.addFields({ name: "📝 メモ", value: memo });
      await interaction.reply({ embeds: [embed] });
    } else {
      await interaction.reply({ content: result.reason, ephemeral: true });
    }
  },
};

const giveCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("give")
    .setDescription("通貨の付与・金庫への入金")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName("wallet")
        .setDescription("ユーザーのウォレットに通貨を付与します（管理者）")
        .addUserOption((opt) =>
          opt.setName("user").setDescription("付与先のユーザー").setRequired(true),
        )
        .addIntegerOption((opt) =>
          opt.setName("amount").setDescription("付与額（マイナスで没収）").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("treasury")
        .setDescription("金庫に直接通貨を付与します（管理者）")
        .addIntegerOption((opt) =>
          opt.setName("treasury_id").setDescription("金庫ID").setRequired(true),
        )
        .addIntegerOption((opt) =>
          opt.setName("amount").setDescription("付与額").setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("deposit")
        .setDescription("自分のウォレットから金庫に入金します")
        .addIntegerOption((opt) =>
          opt.setName("amount").setDescription("入金額").setRequired(true).setMinValue(1),
        )
        .addIntegerOption((opt) =>
          opt.setName("treasury_id").setDescription("複数の隊に所属している場合は金庫IDを指定").setRequired(false),
        ),
    ),
  async execute(interaction) {
    const guildId = requireGuild(interaction);
    const sub = interaction.options.getSubcommand(false);
    if (!sub) {
      await interaction.reply({ content: "サブコマンドを選択してください: `wallet` / `treasury` / `deposit`", ephemeral: true });
      return;
    }
    const settings = await getGuildSettings(guildId);
    const member = interaction.member as GuildMember | null;

    // ── wallet ──
    if (sub === "wallet") {
      if (!requireManageGuild(interaction)) {
        await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
        return;
      }
      const target = interaction.options.getUser("user", true);
      const amount = interaction.options.getInteger("amount", true);
      if (target.bot) {
        await interaction.reply({ content: "Botには付与できません。", ephemeral: true });
        return;
      }
      const result = await giveCurrency(guildId, target.id, amount, settings.currencyName);
      if (result.ok) {
        const verb = amount >= 0 ? "付与" : "没収";
        const embed = new EmbedBuilder()
          .setColor(amount >= 0 ? 0x2ecc71 : 0xe74c3c)
          .setAuthor({ name: target.displayName ?? target.username, iconURL: interaction.guild?.members.cache.get(target.id)?.displayAvatarURL() ?? target.displayAvatarURL() })
          .setDescription(`${verb}: **${Math.abs(amount).toLocaleString()}${settings.currencyName}**\n残高: **${result.balance.toLocaleString()}${settings.currencyName}**`);
        await interaction.reply({ embeds: [embed] });
      } else {
        await interaction.reply({ content: result.reason, ephemeral: true });
      }
      return;
    }

    // ── treasury ──
    if (sub === "treasury") {
      if (!requireManageGuild(interaction)) {
        await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
        return;
      }
      const treasuryId = interaction.options.getInteger("treasury_id", true);
      const amount     = interaction.options.getInteger("amount", true);
      const treasury   = await getSquadTreasury(treasuryId);
      if (!treasury || treasury.guildId !== guildId) {
        await interaction.reply({ content: "金庫が見つかりません。", ephemeral: true });
        return;
      }
      const newBalance = await giveToCrunchTreasury(guildId, treasuryId, interaction.user.id, amount);
      await interaction.reply(
        `✅ **${treasury.name}** に **${amount.toLocaleString()}${settings.currencyName}** を付与しました。\n金庫残高: ${newBalance.toLocaleString()}${settings.currencyName}`,
      );
      return;
    }

    // ── deposit ──
    if (sub === "deposit") {
      const amount = interaction.options.getInteger("amount", true);
      const idOpt  = interaction.options.getInteger("treasury_id");
      let treasury: Awaited<ReturnType<typeof getSquadTreasury>> | null = null;
      let resolveError: string | null = null;
      if (idOpt !== null) {
        const t = await getSquadTreasury(idOpt);
        if (!t || t.guildId !== guildId) { resolveError = "指定された金庫が見つかりません。"; }
        else { treasury = t; }
      } else {
        const memberRoleIds = member ? [...member.roles.cache.keys()] : [];
        const matches = await getTreasuriesByRoles(guildId, memberRoleIds);
        if (matches.length === 0) { resolveError = "所属している隊の金庫が見つかりません。"; }
        else if (matches.length > 1) {
          const ids = matches.map((t) => `[ID:${t.id}] ${t.name}`).join("\n");
          resolveError = `複数の隊に所属しています。\`treasury_id\` を指定してください:\n${ids}`;
        } else { treasury = matches[0]!; }
      }
      if (!treasury) { await interaction.reply({ content: resolveError!, ephemeral: true }); return; }
      const memberRoleIds = member ? [...member.roles.cache.keys()] : [];
      if (!memberRoleIds.includes(treasury.roleId)) {
        await interaction.reply({ content: `この金庫（${treasury.name}）の隊員ロールを持っていません。`, ephemeral: true });
        return;
      }
      await interaction.deferReply();
      try {
        const result = await depositToTreasury(guildId, treasury.id, interaction.user.id, amount);
        const embed = new EmbedBuilder()
          .setTitle(`🏦 ${treasury.name} — 入金完了`)
          .setColor(0x57f287)
          .addFields(
            { name: "入金額", value: `**+${amount.toLocaleString()}${settings.currencyName}**`, inline: true },
            { name: "金庫残高", value: `${result.treasuryBalance.toLocaleString()}${settings.currencyName}`, inline: true },
            { name: "あなたの残高", value: `${result.walletBalance.toLocaleString()}${settings.currencyName}`, inline: true },
          );
        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        logger.error("[treasury] depositToTreasury failed", err);
        await interaction.editReply("入金に失敗しました。");
      }
      return;
    }
  },
};

const DISCORD_MESSAGE_LIMIT = 2000;

const leaderboardCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("サーバー内の資産ランキングを表示します")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addBooleanOption((opt) =>
      opt.setName("all").setDescription("全員分の所持通貨を表示します(管理者用)").setRequired(false),
    ),
  async execute(interaction) {
    const guildId = requireGuild(interaction);
    const showAll = interaction.options.getBoolean("all") ?? false;

    if (showAll && !requireManageGuild(interaction)) {
      await interaction.reply({ content: "このオプションはサーバー管理権限が必要です。", ephemeral: true });
      return;
    }

    const [wallets, settings] = await Promise.all([
      getLeaderboard(guildId, showAll ? undefined : 10),
      getGuildSettings(guildId),
    ]);

    if (wallets.length === 0) {
      await interaction.reply("まだランキングデータがありません。");
      return;
    }

    const lines = wallets.map(
      (w, i) => `**${i + 1}位** <@${w.userId}> — ${w.balance.toLocaleString()}${settings.currencyName}`,
    );

    const header = showAll ? `## 💰 全員の所持通貨(${wallets.length}人)` : "## 🏆 ランキング";
    const chunks: string[] = [];
    let current = header;
    for (const line of lines) {
      if (current.length + line.length + 1 > DISCORD_MESSAGE_LIMIT) {
        chunks.push(current);
        current = line;
      } else {
        current += `\n${line}`;
      }
    }
    chunks.push(current);

    await interaction.reply({ content: chunks[0], allowedMentions: { parse: [] }, ephemeral: showAll });
    for (const chunk of chunks.slice(1)) {
      await interaction.followUp({ content: chunk, allowedMentions: { parse: [] }, ephemeral: showAll });
    }
  },
};

// ---------------------------------------------------------------------------
// /shop — flat subcommands with category choice option
// ---------------------------------------------------------------------------

type EffectChoice = { name: string; value: string };

const COMBINED_EFFECT_CHOICES: EffectChoice[] = [
  { name: "ニックネーム変更権",        value: NICKNAME_CHANGE_EFFECT   },
  { name: "高級船室作成(無期限)",        value: PRIVATE_VC_EFFECT        },
  { name: "フリールーム（3時間）",       value: PRIVATE_VC_3H_EFFECT     },
  { name: "フリールーム（6時間）",       value: PRIVATE_VC_6H_EFFECT     },
  { name: "フリールーム（9時間）",       value: PRIVATE_VC_9H_EFFECT     },
  { name: "永久ロール付与",              value: PERM_ROLE_EFFECT         },
  { name: "オチテモータ島浮上券",        value: EVAL_RESURFACE_EFFECT    },
  { name: "個人ショップ開業券",          value: SHOP_LICENSE_EFFECT      },
  { name: "評価シート延長（1週間）",      value: EVAL_EXTEND_EFFECT        },
  { name: "高級船室（1日）",            value: PRIVATE_VC_1D_EFFECT     },
  { name: "高級船室（3日）",            value: PRIVATE_VC_3D_EFFECT     },
  { name: "高級船室（1週間）",          value: PRIVATE_VC_1W_EFFECT     },
  { name: "高級船室（1ヶ月）",          value: PRIVATE_VC_1M_EFFECT     },
  { name: "VCリネーム",                  value: VC_RENAME_EFFECT         },
  { name: "高級船室延長（1日）",        value: VC_EXTEND_1D_EFFECT      },
];

const CATEGORY_CHOICES = [
  { name: "🛒 ショップ",               value: "general" },
  { name: "⚔️ 隊別ショップ",          value: "group"   },
  { name: "🔒 高級船室ショップ",       value: "vc"      },
  { name: "🏝️ オチテモータ島ショップ", value: "island" },
];

interface ShopGroupConfig {
  displayName: string;
  emoji: string;
  category: string;
  color: number;
}

const SHOP_GROUPS: Record<string, ShopGroupConfig> = {
  general: { displayName: "ショップ",               emoji: "🛒", category: "general", color: 0xf5a623 },
  group:   { displayName: "隊別ショップ",           emoji: "⚔️", category: "group",   color: 0xe74c3c },
  vc:      { displayName: "高級船室ショップ",       emoji: "🔒", category: "vc",      color: 0x3498db },
  island:  { displayName: "オチテモータ島ショップ", emoji: "🏝️", category: "island", color: 0x2ecc71 },
};

const shopCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("shop")
    .setDescription("ショップを操作します")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("購入可能アイテムを表示します")
        .addStringOption((opt) =>
          opt.setName("category").setDescription("ショップカテゴリ").setRequired(true).addChoices(...CATEGORY_CHOICES),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("add").setDescription("アイテムを追加します（管理者）")
        .addStringOption((opt) =>
          opt.setName("category").setDescription("追加先ショップ").setRequired(true).addChoices(...CATEGORY_CHOICES),
        )
        .addStringOption((opt) => opt.setName("name").setDescription("アイテム名").setRequired(true))
        .addIntegerOption((opt) => opt.setName("price").setDescription("価格").setRequired(true).setMinValue(1))
        .addStringOption((opt) => opt.setName("description").setDescription("説明").setRequired(false))
        .addStringOption((opt) =>
          opt.setName("effect").setDescription("購入時の特殊効果").setRequired(false).addChoices(...COMBINED_EFFECT_CHOICES),
        )
        .addRoleOption((opt) =>
          opt.setName("role").setDescription("付与するロール（永久ロール付与エフェクト使用時）").setRequired(false),
        )
    )
    .addSubcommand((sub) =>
      sub.setName("price").setDescription("アイテムの価格を変更します（管理者）")
        .addIntegerOption((opt) => opt.setName("item_id").setDescription("アイテムID").setRequired(true))
        .addIntegerOption((opt) => opt.setName("price").setDescription("新しい価格").setRequired(true).setMinValue(1)),
    )
    .addSubcommand((sub) =>
      sub.setName("remove").setDescription("アイテムを削除します（管理者）")
        .addIntegerOption((opt) => opt.setName("item_id").setDescription("アイテムID").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName("vc-category").setDescription("高級船室を作成するカテゴリを設定します（管理者）")
        .addChannelOption((opt) =>
          opt.setName("channel").setDescription("カテゴリチャンネルを選択").addChannelTypes(ChannelType.GuildCategory).setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("invite").setDescription("高級船室に別のメンバーを招待します")
        .addUserOption((opt) => opt.setName("member").setDescription("招待するメンバー").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName("kick").setDescription("高級船室からメンバーのアクセスを取り消します")
        .addUserOption((opt) => opt.setName("member").setDescription("取り消すメンバー").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName("set-role").setDescription("アイテムの付与ロールを設定・変更します（管理者）")
        .addIntegerOption((opt) =>
          opt.setName("item_id").setDescription("アイテムID（/shop list で確認）").setRequired(true),
        )
        .addRoleOption((opt) =>
          opt.setName("role").setDescription("付与するロール（省略で解除）").setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("panel").setDescription("このチャンネルにショップパネルを投稿します（管理者）")
        .addStringOption((opt) =>
          opt.setName("category").setDescription("表示するショップカテゴリ").setRequired(true).addChoices(...CATEGORY_CHOICES),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("forum-panel").setDescription("現在のフォーラム投稿に専用の購入パネルを設置します（管理者）")
        .addStringOption((opt) => opt.setName("name").setDescription("このフォーラム専用の商品名").setRequired(true))
        .addIntegerOption((opt) => opt.setName("price").setDescription("このフォーラム専用の価格").setRequired(true).setMinValue(1))
        .addStringOption((opt) => opt.setName("description").setDescription("商品の説明").setRequired(false))
        .addStringOption((opt) =>
          opt.setName("effect").setDescription("購入時の特殊効果").setRequired(false).addChoices(...COMBINED_EFFECT_CHOICES),
        )
        .addRoleOption((opt) =>
          opt.setName("role").setDescription("付与するロール（永久ロール付与エフェクト使用時）").setRequired(false),
        )
        .addChannelOption((opt) =>
          opt
            .setName("log_channel")
            .setDescription("購入ログを送るテキストチャンネル")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false),
        ),
    )
    ,

  async execute(interaction) {
    const guildId = requireGuild(interaction);
    const sub     = interaction.options.getSubcommand();

    // Resolve cfg for subcommands that carry a category option
    function getCfg(): ShopGroupConfig {
      const cat = interaction.options.getString("category", true);
      return SHOP_GROUPS[cat] ?? SHOP_GROUPS.general;
    }

    if (sub === "list") {
      const cfg = getCfg();
      const [items, settings] = await Promise.all([
        listShopItems(guildId, cfg.category),
        getGuildSettings(guildId),
      ]);
      const panel = buildShopPanel(items, settings.currencyName, `${cfg.emoji} ${cfg.displayName}`, cfg.color);
      await interaction.reply(panel);
      return;
    }

    if (sub === "add") {
      if (!requireManageGuild(interaction)) {
        await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
        return;
      }
      const cfg         = getCfg();
      const name        = interaction.options.getString("name", true);
      const price       = interaction.options.getInteger("price", true);
      const description = interaction.options.getString("description");
      const effect      = interaction.options.getString("effect");
      const role        = interaction.options.getRole("role");
      // role は後から /shop set-role で設定可能なため、省略を許容する
      const [item, settings] = await Promise.all([
        addShopItem(guildId, name, price, description, effect, cfg.category, role?.id ?? null),
        getGuildSettings(guildId),
      ]);
      await interaction.reply(
        `アイテム **#${item.id} ${item.name}**(${item.price.toLocaleString()}${settings.currencyName})を${cfg.displayName}に追加しました。`,
      );
      return;
    }

    if (sub === "price") {
      if (!requireManageGuild(interaction)) {
        await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
        return;
      }
      const itemId   = interaction.options.getInteger("item_id", true);
      const newPrice = interaction.options.getInteger("price", true);
      const [updated, settings] = await Promise.all([
        updateShopItemPrice(guildId, itemId, newPrice),
        getGuildSettings(guildId),
      ]);
      if (!updated) {
        await interaction.reply({ content: "そのアイテムは見つかりませんでした。", ephemeral: true });
        return;
      }
      await interaction.reply(
        `**#${updated.id} ${updated.name}** の価格を **${newPrice.toLocaleString()}${settings.currencyName}** に変更しました。`,
      );
      return;
    }

    if (sub === "remove") {
      if (!requireManageGuild(interaction)) {
        await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
        return;
      }
      const itemId  = interaction.options.getInteger("item_id", true);
      const removed = await removeShopItem(guildId, itemId);
      await interaction.reply(
        removed ? `アイテム#${itemId}を削除しました。` : "そのアイテムは見つかりませんでした。",
      );
      return;
    }

    if (sub === "vc-category") {
      if (!requireManageGuild(interaction)) {
        await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
        return;
      }
      const channel   = interaction.options.getChannel("channel", true);
      const channelId = channel.id;
      logger.info(`[vc-category] guild=${guildId} channelId=${channelId}`);
      await setVcCategoryId(guildId, channelId);
      logger.info(`[vc-category] saved ok`);
      await interaction.reply(`✅ 高級船室の作成先カテゴリを <#${channelId}> に設定しました。`);
      return;
    }

    if (sub === "invite") {
      await interaction.deferReply({ ephemeral: true });
      const session = await getActivePrivateVcSession(guildId, interaction.user.id, "vc");
      if (!session) {
        await interaction.editReply("❌ 有効な高級船室が見つかりません。先に購入してください。");
        return;
      }
      const targetUser = interaction.options.getUser("member", true);
      if (targetUser.id === interaction.user.id) {
        await interaction.editReply("❌ 自分自身を招待することはできません。");
        return;
      }
      const targetMember = await interaction.guild!.members.fetch(targetUser.id).catch(() => null);
      if (!targetMember) {
        await interaction.editReply("❌ メンバーが見つかりませんでした。");
        return;
      }
      const targetRoleNames = targetMember.roles.cache.map((role) => role.name);
      if (hasLuxuryVcBlockedRole(targetRoleNames)) {
        await interaction.editReply("❌ 追放者ロールを持つメンバーは高級船室に追加できません。");
        return;
      }
      if (!isEligibleForLuxuryVcAdd(targetRoleNames)) {
        await interaction.editReply(
          `❌ ${LUXURY_VC_ADD_ROLE_NAMES.join("・")}のいずれかのロールを持つメンバーのみ高級船室へ追加できます。`,
        );
        return;
      }
      const ch = interaction.guild!.channels.cache.get(session.channelId)
        ?? await interaction.guild!.channels.fetch(session.channelId).catch(() => null);
      if (!ch || !("permissionOverwrites" in ch)) {
        await interaction.editReply("❌ VCチャンネルが見つかりませんでした。");
        return;
      }
      await ch.permissionOverwrites.edit(targetUser.id, {
        ViewChannel: true, Connect: true, Speak: true, Stream: true, SendMessages: true,
      });
      await interaction.editReply(`✅ <@${targetUser.id}> を高級船室に招待しました。`);
      // パネルのメンバーリストをリアルタイム更新（best-effort）
      try {
        if ("messages" in ch) {
          await refreshPrivateVcPanelMessage(
            ch as import("discord.js").TextBasedChannel & import("discord.js").GuildChannel,
            {
              channelId: session.channelId,
              ownerId: interaction.user.id,
              botId: interaction.client.user?.id,
              expiresAt: session.expiresAt,
              category: session.category,
              addedMemberId: targetUser.id,
            },
          );
        }
      } catch (err) {
        logger.warn(`[vc-invite] Failed to refresh panel for channel ${session.channelId}`, err);
      }
      return;
    }

    if (sub === "kick") {
      await interaction.deferReply({ ephemeral: true });
      const session = await getActivePrivateVcSession(guildId, interaction.user.id, "vc");
      if (!session) {
        await interaction.editReply("❌ 有効な高級船室が見つかりません。");
        return;
      }
      const targetUser = interaction.options.getUser("member", true);
      if (targetUser.id === interaction.user.id) {
        await interaction.editReply("❌ 自分自身のアクセスは取り消せません。");
        return;
      }
      const ch = interaction.guild!.channels.cache.get(session.channelId)
        ?? await interaction.guild!.channels.fetch(session.channelId).catch(() => null);
      if (!ch || !("permissionOverwrites" in ch)) {
        await interaction.editReply("❌ VCチャンネルが見つかりませんでした。");
        return;
      }
      const kickResult = await kickPrivateVcMember(
        interaction.guild!,
        ch as import("discord.js").GuildChannel,
        targetUser.id,
      );
      if (!kickResult.ok) {
        await interaction.editReply(kickResult.message);
        return;
      }
      await interaction.editReply(`✅ <@${targetUser.id}> のアクセスを取り消しました。`);
      // パネルのメンバーリストをリアルタイム更新（best-effort）
      try {
        if ("messages" in ch) {
          await refreshPrivateVcPanelMessage(
            ch as import("discord.js").TextBasedChannel & import("discord.js").GuildChannel,
            {
              channelId: session.channelId,
              ownerId: interaction.user.id,
              botId: interaction.client.user?.id,
              expiresAt: session.expiresAt,
              category: session.category,
              removedMemberId: targetUser.id,
            },
          );
        }
      } catch (err) {
        logger.warn(`[vc-kick] Failed to refresh panel for channel ${session.channelId}`, err);
      }
      return;
    }

    if (sub === "set-role") {
      if (!requireManageGuild(interaction)) {
        await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
        return;
      }
      const itemId = interaction.options.getInteger("item_id", true);
      const role   = interaction.options.getRole("role");
      const updated = await updateShopItemRole(guildId, itemId, role?.id ?? null);
      if (!updated) {
        await interaction.reply({ content: `❌ アイテム ID **${itemId}** が見つかりません。`, ephemeral: true });
        return;
      }
      if (role) {
        await interaction.reply({
          content: `✅ **${updated.name}** の付与ロールを <@&${role.id}> に設定しました。`,
          ephemeral: true,
        });
      } else {
        await interaction.reply({
          content: `✅ **${updated.name}** の付与ロール設定を解除しました。`,
          ephemeral: true,
        });
      }
      return;
    }

    if (sub === "set-license") {
      if (!requireManageGuild(interaction)) {
        await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
        return;
      }
      const squadRole   = interaction.options.getRole("squad_role", true);
      const licenseRole = interaction.options.getRole("license_role", true);
      await setShopLicenseConfig(guildId, squadRole.id, licenseRole.id);
      await interaction.reply({
        content: `✅ 隊ロール <@&${squadRole.id}> → ショップ開業ロール <@&${licenseRole.id}> の対応を設定しました。`,
        ephemeral: true,
      });
      return;
    }

    if (sub === "list-licenses") {
      if (!requireManageGuild(interaction)) {
        await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
        return;
      }
      const configs = await listShopLicenseConfigs(guildId);
      if (configs.length === 0) {
        await interaction.reply({ content: "個人ショップ開業券の隊ロール対応がまだ設定されていません。`/shop set-license` で設定してください。", ephemeral: true });
        return;
      }
      const lines = configs.map((c) => `<@&${c.squadRoleId}> → <@&${c.licenseRoleId}>`);
      await interaction.reply({ content: `## 🏪 個人ショップ開業ロール対応一覧\n${lines.join("\n")}`, ephemeral: true });
      return;
    }

    if (sub === "forum-panel") {
      if (!requireManageGuild(interaction)) {
        await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
        return;
      }

      const thread = interaction.channel?.isThread() ? interaction.channel : null;
      if (!thread || thread.parent?.type !== ChannelType.GuildForum) {
        await interaction.reply({
          content: "❌ このコマンドはフォーラム内の投稿（スレッド）で実行してください。",
          ephemeral: true,
        });
        return;
      }

      const name = interaction.options.getString("name", true);
      const price = interaction.options.getInteger("price", true);
      const description = interaction.options.getString("description");
      const effect = interaction.options.getString("effect");
      const role = interaction.options.getRole("role");
      const logChannel = interaction.options.getChannel("log_channel");
      const existingPanel = await getShopForumPanel(guildId, thread.id);
      const settings = await getGuildSettings(guildId);
      const logChannelId = logChannel?.id ?? existingPanel?.logChannelId ?? null;
      if (!logChannelId) {
        await interaction.reply({
          content: "❌ `log_channel` を指定してください。購入結果を送るテキストチャンネルが必要です。",
          ephemeral: true,
        });
        return;
      }
      const saved = await upsertShopForumPanel(
        guildId,
        thread.id,
        existingPanel?.panelMessageId ?? null,
        {
          name,
          price,
          description,
          effectType: effect,
          targetRoleId: role?.id ?? null,
          logChannelId,
        },
      );
      const panel = buildForumShopPanel(saved.item.id);

      let panelMessage: import("discord.js").Message | null = null;
      if (saved.panel.panelMessageId) {
        panelMessage = await thread.messages.fetch(saved.panel.panelMessageId).catch(() => null);
      }
      if (panelMessage) {
        await panelMessage.edit(panel);
      } else {
        panelMessage = await thread.send(panel);
        await setShopForumPanelMessage(guildId, thread.id, panelMessage.id);
      }

      await interaction.reply({
        content: `✅ このフォーラム投稿の商品を **${saved.item.name}**（${saved.item.price.toLocaleString()}${settings.currencyName}）に設定し、購入ログを <#${logChannelId}> へ送る購入パネルを${panelMessage.id === existingPanel?.panelMessageId ? "更新" : "設置"}しました。`,
        ephemeral: true,
      });
      return;
    }

    if (sub === "panel") {
      if (!requireManageGuild(interaction)) {
        await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
        return;
      }
      const cfg = getCfg();
      const [items, settings] = await Promise.all([
        listShopItems(guildId, cfg.category),
        getGuildSettings(guildId),
      ]);
      if (items.length === 0) {
        await interaction.reply({ content: `❌ **${cfg.displayName}** にアイテムがまだありません。先に \`/shop add\` でアイテムを追加してください。`, ephemeral: true });
        return;
      }
      const panel = buildShopPanel(items, settings.currencyName, `${cfg.emoji} ${cfg.displayName}`, cfg.color);
      // チャンネルに常設投稿（全員が見える）
      await interaction.reply({ content: "✅ パネルを投稿しました。", ephemeral: true });
      await (interaction.channel as import("discord.js").TextChannel).send(panel);
      return;
    }
  },
};

const rewardCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("reward")
    .setDescription("ロールごとの自動報酬を設定します(管理者用)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("ロールに自動報酬を設定します")
        .addRoleOption((opt) => opt.setName("role").setDescription("対象ロール").setRequired(true))
        .addIntegerOption((opt) =>
          opt.setName("amount").setDescription("配布間隔ごとの付与額").setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("ロールの自動報酬を解除します")
        .addRoleOption((opt) => opt.setName("role").setDescription("対象ロール").setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName("list").setDescription("設定済みの自動報酬一覧を表示します"))
    .addSubcommand((sub) =>
      sub
        .setName("day")
        .setDescription("毎月の給料日を設定します(例: 25 = 毎月25日)")
        .addIntegerOption((opt) =>
          opt
            .setName("day")
            .setDescription("給料日(1〜31)")
            .setRequired(true)
            .setMinValue(1)
            .setMaxValue(31),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("pay").setDescription("今すぐロール報酬を全メンバーに支給します（管理者用）"),
    ),
  async execute(interaction) {
    const guildId = requireGuild(interaction);

    if (!requireManageGuild(interaction)) {
      await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === "remove") {
      const role = interaction.options.getRole("role", true);
      const removed = await removeRoleReward(guildId, role.id);
      await interaction.reply(
        removed ? `<@&${role.id}> の自動報酬を解除しました。` : "そのロールには自動報酬が設定されていません。",
      );
      return;
    }

    if (sub === "list") {
      const [rewards, settings] = await Promise.all([listRoleRewards(guildId), getGuildSettings(guildId)]);
      if (rewards.length === 0) {
        await interaction.reply("自動報酬は設定されていません。");
        return;
      }
      const lines = rewards.map((r) => `<@&${r.roleId}> — ${r.amount.toLocaleString()}${settings.currencyName}`);
      const scheduleLabel = settings.rewardDayOfMonth ? `毎月${settings.rewardDayOfMonth}日` : "未設定";
      await interaction.reply({
        content: `## 💰 自動報酬設定(給料日: ${scheduleLabel})\n${lines.join("\n")}`,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (sub === "set") {
      // Re-fetch settings after upsert to reflect the current schedule label.
      const role = interaction.options.getRole("role", true);
      const amount = interaction.options.getInteger("amount", true);
      const [reward, settings] = await Promise.all([
        setRoleReward(guildId, role.id, amount),
        getGuildSettings(guildId),
      ]);
      const scheduleLabel = settings.rewardDayOfMonth ? `毎月${settings.rewardDayOfMonth}日` : "未設定";
      await interaction.reply(
        `<@&${reward.roleId}> の自動報酬を **${amount.toLocaleString()}${settings.currencyName}** に設定しました(給料日: ${scheduleLabel})。`,
      );
      return;
    }

    if (sub === "day") {
      const day = interaction.options.getInteger("day", true);
      const settings = await setRewardDayOfMonth(guildId, day);
      await interaction.reply(`給料日を **毎月${settings.rewardDayOfMonth}日** に設定しました。`);
      return;
    }

    if (sub === "pay") {
      await interaction.deferReply();
      const guild = interaction.guild!;
      const settings = await getGuildSettings(guildId);

      await guild.members.fetch();
      const memberRoles = new Map<string, string[]>();
      for (const member of guild.members.cache.values()) {
        if (member.user.bot) continue;
        memberRoles.set(member.id, [...member.roles.cache.keys()]);
      }
      const subAccountRoleIds = new Set(
        [...guild.roles.cache.values()]
          .filter((role) => role.name === SUB_ACCOUNT_ROLE_NAME)
          .map((role) => role.id),
      );
      const excludedUserIds = getExcludedUserIds(memberRoles, subAccountRoleIds);

      const { paidCount, totalPaid } = await distributeRoleRewards(
        guildId,
        settings.currencyName,
        memberRoles,
        excludedUserIds,
      );

      if (paidCount === 0) {
        await interaction.editReply("報酬対象のロールを持つメンバーがいないか、ロール報酬が未設定です。");
      } else {
        await interaction.editReply(
          `✅ **${paidCount}人** に合計 **${totalPaid.toLocaleString()}${settings.currencyName}** を支給しました。`,
        );
      }
      return;
    }
  },
};


import { vcCommand } from "./vc";
import { evalsheetCommand } from "./evalsheet";
import { shiftCommand } from "./shift";
export {
  shiftCommand,
  postWeeklyShifts,
  getNextWeeklyPostTime,
  SHIFT_TOGGLE_PREFIX,
  SHIFT_CONFIRM_PREFIX,
  SHIFT_CANCEL_PREFIX,
  SHIFT_TIME_PREFIX,
  handleShiftToggle,
  handleShiftConfirm,
  handleShiftCancel,
  handleShiftTime,
  SHIFT_PANEL_OPEN_PREFIX,
  handleShiftPanelOpen,
  SHIFT_LIST_NAV_PREFIX,
  handleShiftListNav,
} from "./shift";
import { vcsalaryCommand } from "./vcsalary";
import { vclogCommand } from "./vclog";
import { slotCommand } from "./slot";
import { blackjackCommand } from "./blackjack";
import { pokerCommand } from "./poker";
import { rouletteCommand } from "./roulette";
import { highlowCommand } from "./highlow";
import { baccaratCommand } from "./baccarat";
import { chinchiroCommand } from "./chinchiro";
import { casinoCommand } from "./casino";
import { bannotifyCommand } from "./bannotify";
import { rolePanelCommand } from "./rolepanel";
import { guideCommand } from "./guide";
import { leavelogCommand } from "./leavelog";

import { interviewCommand } from "./interview";
import { stickyCommand } from "./sticky";
import {
  adviceEndCommand,
  adviceLogCommand,
  logAdviceTicketPurchase,
  markAdviceRoleGrantFromPurchase,
} from "./advice";
import { clearCommand } from "./clear";

// ─── VC コントロールパネル ────────────────────────────────────────────────────

export const VC_PANEL_BTN_ADD      = "vc:panel:add:";
export const VC_PANEL_BTN_KICK     = "vc:panel:kick:";
export const VC_PANEL_BTN_EXTEND   = "vc:panel:extend:";
export const VC_PANEL_BTN_EXPIRY   = "vc:panel:expiry:";
export const VC_PANEL_BTN_RENAME   = "vc:panel:rename:";
export const VC_PANEL_BTN_STREAM   = "vc:panel:stream:";
export const VC_PANEL_BTN_TREASURE = "vc:panel:treasure:"; // 旧: 未使用
/** 新入り宝箱ボタン ID */
export const CHEST_OPEN_BTN_SHINNIRI  = "chest:open:shinniri";
/** 本船員宝箱ボタン ID */
export const CHEST_OPEN_BTN_HONSENNIN = "chest:open:honsennin";
/** 後方互換 alias（旧パネルが残っている場合は新入り扱い） */
export const CHEST_OPEN_BTN_ID = CHEST_OPEN_BTN_SHINNIRI;
export const VC_PANEL_SEL_ADD      = "vc:panel:adds:";
export const VC_PANEL_SEL_KICK     = "vc:panel:kicks:";
export const VC_PANEL_SEL_EXTEND   = "vc:panel:exts:";
export const VC_PANEL_SEL_RENAME   = "vc:panel:rsel:";
// modal: "vc:panel:rnm:{channelId}:{ownerId}:{itemId}"
export const VC_PANEL_RENAME_MODAL = "vc:panel:rnm:";
export const VC_PANEL_KICK_PAGE    = "vc:panel:kick-page:";
const VC_PANEL_KICK_PAGE_SIZE = 25;
export const LUXURY_VC_ADD_ROLE_NAMES = ["本船員", "漂流者", "新入り"] as const;
export const LUXURY_VC_BLOCKED_ROLE_NAMES = ["追放者"] as const;

/** custom ID のペイロードを "{channelId}:{ownerId}" 形式でエンコード */
export function vcPanelId(prefix: string, channelId: string, ownerId: string) {
  return `${prefix}${channelId}:${ownerId}`;
}
/** "{channelId}:{ownerId}" を分解して返す */
export function parseVcPanelId(prefix: string, customId: string): { channelId: string; ownerId: string } {
  const payload = customId.slice(prefix.length);
  const sep = payload.lastIndexOf(":");
  return { channelId: payload.slice(0, sep), ownerId: payload.slice(sep + 1) };
}

function parseVcPanelPagedId(
  prefix: string,
  customId: string,
): { channelId: string; ownerId: string; page: number } {
  const payload = customId.slice(prefix.length);
  const parts = payload.split(":");
  const pageToken = parts.at(-1);
  if (parts.length < 3 || !/^\d+$/.test(pageToken ?? "")) {
    const legacy = parseVcPanelId(prefix, customId);
    return { ...legacy, page: 0 };
  }
  const page = Number(parts.pop() ?? 0);
  const ownerId = parts.pop() ?? "";
  return {
    channelId: parts.join(":"),
    ownerId,
    page: Number.isInteger(page) && page >= 0 ? page : 0,
  };
}

export function isBlockedFromLuxuryVcAdd(roleNames: Iterable<string>): boolean {
  return !isEligibleForLuxuryVcAdd(roleNames);
}

export function hasLuxuryVcBlockedRole(roleNames: Iterable<string>): boolean {
  const names = new Set(roleNames);
  return LUXURY_VC_BLOCKED_ROLE_NAMES.some((roleName) => names.has(roleName));
}

export function isEligibleForLuxuryVcAdd(roleNames: Iterable<string>): boolean {
  const names = new Set(roleNames);
  return !hasLuxuryVcBlockedRole(names)
    && LUXURY_VC_ADD_ROLE_NAMES.some((roleName) => names.has(roleName));
}

type PrivateVcKickResult =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Remove a member's explicit room access and disconnect them if they are
 * currently in the room. Both slash-command and panel kicks use this path so
 * they cannot report success after Discord rejected either operation.
 */
export async function kickPrivateVcMember(
  guild: Guild,
  channel: import("discord.js").GuildChannel,
  targetId: string,
): Promise<PrivateVcKickResult> {
  const botMember = guild.members.me;
  const botPermissions = botMember ? channel.permissionsFor(botMember) : null;
  if (!botPermissions?.has(PermissionFlagsBits.ManageChannels)) {
    logger.warn(`[vc-kick] Missing ManageChannels in channel ${channel.id}`);
    return {
      ok: false,
      message: "❌ Botに「チャンネルの管理」権限がないため、アクセス権を取り消せません。",
    };
  }

  let targetMember: GuildMember;
  try {
    targetMember = await guild.members.fetch(targetId);
  } catch (err) {
    logger.error(`[vc-kick] Failed to fetch member ${targetId} in guild ${guild.id}`, err);
    return {
      ok: false,
      message: "❌ 対象メンバーの状態を確認できなかったため、キックを実行できませんでした。",
    };
  }

  const needsDisconnect = targetMember.voice.channelId === channel.id;
  if (needsDisconnect && !botPermissions.has(PermissionFlagsBits.MoveMembers)) {
    logger.warn(`[vc-kick] Missing MoveMembers in channel ${channel.id} for member ${targetId}`);
    return {
      ok: false,
      message: "❌ Botに「メンバーを移動」権限がないため、VCから切断できません。Botの権限を確認してください。",
    };
  }

  try {
    await channel.permissionOverwrites.delete(targetId);
  } catch (err) {
    logger.error(`[vc-kick] Failed to remove channel access for member ${targetId} in channel ${channel.id}`, err);
    return {
      ok: false,
      message: "❌ 高級船室のアクセス権を取り消せませんでした。Botの「チャンネルの管理」権限を確認してください。",
    };
  }

  if (needsDisconnect) {
    try {
      await targetMember.voice.disconnect();
    } catch (err) {
      logger.error(`[vc-kick] Access removed but voice disconnect failed for member ${targetId} in channel ${channel.id}`, err);
      return {
        ok: false,
        message: "⚠️ アクセス権は取り消しましたが、VCからの切断に失敗しました。Botの「メンバーを移動」権限を確認してください。",
      };
    }
  }

  return { ok: true };
}

async function getLuxuryVcChannels(
  guild: Guild,
  onlyChannelId?: string,
): Promise<import("discord.js").GuildChannel[]> {
  const settings = await getGuildSettings(guild.id);
  const sessions = await getActivePrivateVcSessionsByGuild(guild.id);
  const luxurySessionChannelIds = new Set(
    sessions.filter((session) => getPrivateVcRoomCategory(session.category) === "vc")
      .map((session) => session.channelId),
  );

  const candidateIds = onlyChannelId
    ? [onlyChannelId]
    : [
        ...luxurySessionChannelIds,
        ...guild.channels.cache
          .filter((channel) => channel.parentId === settings.vcCategoryId)
          .map((channel) => channel.id),
      ];

  const channels = await Promise.all(
    [...new Set(candidateIds)].map(async (channelId) => {
      const channel = guild.channels.cache.get(channelId)
        ?? await guild.channels.fetch(channelId).catch(() => null);
      if (!channel || !("permissionOverwrites" in channel)) return null;

      const session = sessions.find((candidate) => candidate.channelId === channelId);
      if (session) {
        return getPrivateVcRoomCategory(session.category) === "vc" ? channel : null;
      }
      return settings.vcCategoryId && channel.parentId === settings.vcCategoryId
        ? channel
        : null;
    }),
  );

  return channels.filter(
    (channel) => channel !== null,
  ) as import("discord.js").GuildChannel[];
}

/**
 * 追放者が持つ高級船室の明示アクセス権を削除し、入室中なら切断する。
 * onlyChannelId 指定時はVoiceStateUpdate用、未指定時はロール付与時用。
 */
export async function enforceExpelledLuxuryVcAccess(
  member: GuildMember,
  onlyChannelId?: string,
): Promise<number> {
  if (!hasLuxuryVcBlockedRole(member.roles.cache.map((role) => role.name))) return 0;

  const channels = await getLuxuryVcChannels(member.guild, onlyChannelId);
  let revoked = 0;
  for (const channel of channels) {
    const overwrite = channel.permissionOverwrites.cache.get(member.id);
    const hasExplicitAccess = overwrite?.allow.has(PermissionFlagsBits.ViewChannel) ?? false;
    const isConnected = member.voice.channelId === channel.id;
    if (!hasExplicitAccess && !isConnected) continue;

    const result = await kickPrivateVcMember(member.guild, channel, member.id);
    if (!result.ok) {
      logger.error(
        `[vc-expelled] Failed to revoke luxury VC access user=${member.id} channel=${channel.id}: ${result.message}`,
      );
      continue;
    }
    revoked++;
    logger.info(
      `[vc-expelled] Revoked luxury VC access user=${member.id} channel=${channel.id}`,
    );
  }
  return revoked;
}

/** Bot起動時に、既存の高級船室アクセス権から追放者を除去する。 */
export async function enforceAllExpelledLuxuryVcAccess(client: Client): Promise<number> {
  let revoked = 0;
  for (const guild of client.guilds.cache.values()) {
    const channels = await getLuxuryVcChannels(guild);
    const memberIds = new Set<string>();
    for (const channel of channels) {
      channel.permissionOverwrites.cache.forEach((overwrite) => {
        if (
          overwrite.type === 1
          && overwrite.allow.has(PermissionFlagsBits.ViewChannel)
          && overwrite.id !== client.user?.id
        ) {
          memberIds.add(overwrite.id);
        }
      });
      if ("members" in channel) {
        channel.members.forEach((member) => memberIds.add(member.id));
      }
    }

    for (const memberId of memberIds) {
      const member = guild.members.cache.get(memberId)
        ?? await guild.members.fetch(memberId).catch(() => null);
      if (!member) continue;
      revoked += await enforceExpelledLuxuryVcAccess(member);
    }
  }
  return revoked;
}

/**
 * Returns the IDs of members who have an explicit ViewChannel:allow permission
 * override on the channel, excluding @everyone, the VC owner, and the bot itself.
 */
function getVcAccessMemberIds(
  channel: import("discord.js").GuildChannel,
  ownerId: string,
  botId: string | undefined,
): string[] {
  if (!("permissionOverwrites" in channel)) return [];
  return channel.permissionOverwrites.cache
    .filter(
      (ow) =>
        ow.type === 1 /* OverwriteType.Member */
        && ow.allow.has(PermissionFlagsBits.ViewChannel)
        && ow.id !== ownerId
        && (botId === undefined || ow.id !== botId),
    )
    .map((ow) => ow.id);
}

/**
 * オーナーのチャンネル上書きで Stream が明示的に allow されていれば ON とみなす。
 * ない場合は OFF（初期作成時はオーナー上書きに Stream が含まれないので OFF）。
 */
function isPrivateVcStreamEnabled(ch: import("discord.js").GuildChannel, ownerId: string): boolean {
  if (!("permissionOverwrites" in ch)) return false;
  const ow = ch.permissionOverwrites.cache.get(ownerId);
  return ow?.allow.has(PermissionFlagsBits.Stream) ?? false;
}

interface RefreshPrivateVcPanelOptions {
  channelId: string;
  ownerId: string;
  botId: string | undefined;
  expiresAt?: Date | null;
  category?: string | null;
  addedMemberId?: string;
  removedMemberId?: string;
  streamEnabled?: boolean;
}

/**
 * 権限変更直後はDiscordの上書きキャッシュが古い場合があるため、変更対象を
 * 表示用一覧へ明示反映する。パネルが古いメッセージになっていても見つける。
 */
export async function refreshPrivateVcPanelMessage(
  channel: import("discord.js").TextBasedChannel & import("discord.js").GuildChannel,
  options: RefreshPrivateVcPanelOptions,
): Promise<boolean> {
  let memberIds = getVcAccessMemberIds(channel, options.ownerId, options.botId);
  if (options.addedMemberId && !memberIds.includes(options.addedMemberId)) {
    memberIds = [...memberIds, options.addedMemberId];
  }
  if (options.removedMemberId) {
    memberIds = memberIds.filter((id) => id !== options.removedMemberId);
  }

  const isPanel = (message: import("discord.js").Message) =>
    message.author.id === options.botId
    && (
      message.embeds[0]?.title === VC_PANEL_TITLE
      || LEGACY_VC_PANEL_TITLES.has(message.embeds[0]?.title ?? "")
    );
  const oldestMessages = await channel.messages.fetch({ limit: 10, after: "0" });
  let panelMessage = oldestMessages.find(isPanel);
  if (!panelMessage) {
    const recentMessages = await channel.messages.fetch({ limit: 50 });
    panelMessage = recentMessages.find(isPanel);
  }
  if (!panelMessage) {
    logger.warn(`[vc-panel] Control panel not found in channel ${options.channelId}`);
    return false;
  }

  const streamEnabled = options.streamEnabled
    ?? isPrivateVcStreamEnabled(channel, options.ownerId);
  await panelMessage.edit(
    buildVcPanelMessage(
      options.channelId,
      options.ownerId,
      options.expiresAt ?? undefined,
      memberIds,
      streamEnabled,
      isFreeRoomCategory(options.category),
    ),
  );
  return true;
}

/**
 * Re-posts the luxury-room control panel after the latest user message so the
 * panel remains at the bottom of the voice channel's text chat.
 */
export async function movePrivateVcPanelToBottom(
  channel: import("discord.js").TextBasedChannel & import("discord.js").GuildChannel,
  options: Omit<RefreshPrivateVcPanelOptions, "ownerId"> & { ownerId?: string },
): Promise<boolean> {
  if (isFreeRoomCategory(options.category) || !options.botId) return false;

  const isPanel = (message: import("discord.js").Message) =>
    message.author.id === options.botId
    && (
      message.embeds[0]?.title === VC_PANEL_TITLE
      || LEGACY_VC_PANEL_TITLES.has(message.embeds[0]?.title ?? "")
    );

  const oldestMessages = await channel.messages.fetch({ limit: 100, after: "0" });
  const recentMessages = await channel.messages.fetch({ limit: 100 });
  const panelMessages = Array.from(
    new Map(
      [...oldestMessages.values(), ...recentMessages.values()].map((message) => [message.id, message]),
    ).values(),
  ).filter(isPanel);
  if (panelMessages.length === 0) return false;

  const panelOwnerId = options.ownerId
    ?? panelMessages[0]?.embeds[0]?.description?.match(/<@!?(\d+)>/)?.[1];
  if (!panelOwnerId) return false;

  const memberIds = getVcAccessMemberIds(channel, panelOwnerId, options.botId);
  const streamEnabled = options.streamEnabled
    ?? isPrivateVcStreamEnabled(channel, panelOwnerId);
  const panelPayload = buildVcPanelMessage(
    options.channelId,
    panelOwnerId,
    options.expiresAt ?? undefined,
    memberIds,
    streamEnabled,
    false,
  );

  // Send first so a failed delete never removes the only usable panel.
  await channel.send(panelPayload);
  const deleteResults = await Promise.allSettled(panelMessages.map((message) => message.delete()));
  if (deleteResults.some((result) => result.status === "rejected")) {
    logger.warn(`[vc-panel] Failed to delete one or more old panel messages in ${options.channelId}`);
  }
  return true;
}

export function buildVcPanelMessage(
  channelId: string,
  ownerId: string,
  expiresAt?: Date,
  memberIds?: string[],
  streamEnabled?: boolean,
  isFreeRoom = false,
) {
  const ts = expiresAt ? Math.floor(expiresAt.getTime() / 1000) : null;
  const expText = ts
    ? `⏳ 期限: <t:${ts}:F>（<t:${ts}:R>）`
    : "⏳ 期限: 無期限";
  const memberLine = !isFreeRoom && memberIds !== undefined
    ? `\n👥 アクセス中のメンバー: ${memberIds.length > 0 ? memberIds.map((id) => `<@${id}>`).join("、") : "メンバーなし"}`
    : "";
  const embed = new EmbedBuilder()
    .setTitle(isFreeRoom ? ISLAND_VC_PANEL_TITLE : VC_PANEL_TITLE)
    .setColor(0x5865f2)
    .setDescription(`<@${ownerId}> の${isFreeRoom ? "フリールーム" : "高級船室"}です。\n${expText}${memberLine}`)
    .setFooter({ text: "VCオーナーのみ操作できます" });
  const row1Buttons = [
    ...(isFreeRoom ? [] : [
      new ButtonBuilder()
        .setCustomId(vcPanelId(VC_PANEL_BTN_ADD, channelId, ownerId))
        .setLabel("メンバーを追加")
        .setStyle(ButtonStyle.Primary)
        .setEmoji("👤"),
      new ButtonBuilder()
        .setCustomId(vcPanelId(VC_PANEL_BTN_KICK, channelId, ownerId))
        .setLabel("キック")
        .setStyle(ButtonStyle.Danger)
        .setEmoji("👢")
        .setDisabled(memberIds !== undefined && memberIds.length === 0),
    ]),
    new ButtonBuilder()
      .setCustomId(vcPanelId(VC_PANEL_BTN_EXTEND, channelId, ownerId))
      .setLabel("期間延長")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("⏰"),
    new ButtonBuilder()
      .setCustomId(vcPanelId(VC_PANEL_BTN_EXPIRY, channelId, ownerId))
      .setLabel("期限確認")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("📅"),
  ];
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(...row1Buttons);
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(vcPanelId(VC_PANEL_BTN_RENAME, channelId, ownerId))
      .setLabel("VC名変更")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("✏️"),
    new ButtonBuilder()
      .setCustomId(vcPanelId(VC_PANEL_BTN_STREAM, channelId, ownerId))
      .setLabel(streamEnabled ? "画面共有: ON" : "画面共有: OFF")
      .setStyle(streamEnabled ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setEmoji("📺"),
  );
  return { embeds: [embed], components: [row1, row2] };
}

/** ownerId をボタン custom ID から取り出してオーナー確認 */
function checkOwner(
  interaction:
    | ButtonInteraction
    | StringSelectMenuInteraction
    | UserSelectMenuInteraction
    | ModalSubmitInteraction,
  ownerId: string,
): boolean {
  if (interaction.user.id !== ownerId) {
    interaction.reply({ content: "❌ VCオーナーのみ操作できます。", ephemeral: true }).catch(() => {});
    return false;
  }
  return true;
}

export async function handleVcPanelAddBtn(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild) return;
  const { channelId, ownerId } = parseVcPanelId(VC_PANEL_BTN_ADD, interaction.customId);
  if (!checkOwner(interaction, ownerId)) return;
  const select = new UserSelectMenuBuilder()
    .setCustomId(vcPanelId(VC_PANEL_SEL_ADD, channelId, ownerId))
    .setPlaceholder("追加するメンバーを選択")
    .setMinValues(1)
    .setMaxValues(1);
  const row = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(select);
  await interaction.reply({
    content: "追加するメンバーを選んでください（ニックネームで検索できます）：",
    components: [row],
    ephemeral: true,
  });
}

export async function buildLuxuryVcKickSelector(
  guild: Guild,
  channelId: string,
  ownerId: string,
  botId: string | undefined,
  requestedPage: number,
): Promise<{
  content: string;
  components: Array<
    ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>
  >;
}> {
  const channel = guild.channels.cache.get(channelId)
    ?? await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !("permissionOverwrites" in channel)) {
    return { content: "❌ VCチャンネルが見つかりませんでした。", components: [] };
  }

  const memberIds = getVcAccessMemberIds(
    channel as import("discord.js").GuildChannel,
    ownerId,
    botId,
  );
  const members = (await Promise.all(
    memberIds.map((id) => guild.members.fetch(id).catch(() => null)),
  ))
    .filter((member): member is GuildMember => member !== null && !member.user.bot)
    .sort((a, b) => a.displayName.localeCompare(b.displayName, "ja"));

  const pageCount = Math.max(1, Math.ceil(members.length / VC_PANEL_KICK_PAGE_SIZE));
  const page = Math.min(Math.max(requestedPage, 0), pageCount - 1);
  const pageMembers = members.slice(
    page * VC_PANEL_KICK_PAGE_SIZE,
    (page + 1) * VC_PANEL_KICK_PAGE_SIZE,
  );
  if (pageMembers.length === 0) {
    return {
      content: "ℹ️ 現在、高級船室へのアクセス権を持つメンバーはいません。",
      components: [],
    };
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`${VC_PANEL_SEL_KICK}${channelId}:${ownerId}:${page}`)
    .setPlaceholder("キックするメンバーを選択")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      pageMembers.map((member) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(member.displayName.slice(0, 100))
          .setValue(member.id)
          .setDescription(`@${member.user.username}`.slice(0, 100)),
      ),
    );

  const components: Array<
    ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>
  > = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
  ];
  if (pageCount > 1) {
    const navigation = new ActionRowBuilder<ButtonBuilder>();
    if (page > 0) {
      navigation.addComponents(
        new ButtonBuilder()
          .setCustomId(`${VC_PANEL_KICK_PAGE}${channelId}:${ownerId}:${page - 1}`)
          .setLabel("前のページ")
          .setStyle(ButtonStyle.Secondary),
      );
    }
    if (page < pageCount - 1) {
      navigation.addComponents(
        new ButtonBuilder()
          .setCustomId(`${VC_PANEL_KICK_PAGE}${channelId}:${ownerId}:${page + 1}`)
          .setLabel("次のページ")
          .setStyle(ButtonStyle.Secondary),
      );
    }
    components.push(navigation);
  }

  return {
    content: `キックするメンバーを選んでください（${page + 1}/${pageCount}）：`,
    components,
  };
}

export async function handleVcPanelKickBtn(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild) return;
  const { channelId, ownerId } = parseVcPanelId(VC_PANEL_BTN_KICK, interaction.customId);
  if (!checkOwner(interaction, ownerId)) return;
  const selector = await buildLuxuryVcKickSelector(
    interaction.guild,
    channelId,
    ownerId,
    interaction.client.user?.id,
    0,
  );
  await interaction.reply({ ...selector, ephemeral: true });
}

export async function handleVcPanelKickPage(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild) return;
  const { channelId, ownerId, page } = parseVcPanelPagedId(
    VC_PANEL_KICK_PAGE,
    interaction.customId,
  );
  if (!checkOwner(interaction, ownerId)) return;
  const selector = await buildLuxuryVcKickSelector(
    interaction.guild,
    channelId,
    ownerId,
    interaction.client.user?.id,
    page,
  );
  await interaction.update(selector);
}

export async function handleVcPanelExtendBtn(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild) return;
  const { channelId, ownerId } = parseVcPanelId(VC_PANEL_BTN_EXTEND, interaction.customId);
  if (!checkOwner(interaction, ownerId)) return;
  // 延長にはDB sessionが必要（無期限VCはセッション無し）
  const session = await getPrivateVcSessionByChannelId(channelId);
  if (!session) {
    await interaction.reply({ content: "❌ このVCは無期限のため期間延長できません。", ephemeral: true });
    return;
  }
  const allVcItems = await listShopItems(interaction.guild.id, "vc");
  const extendItems = allVcItems.filter((i) => i.effectType && VC_EXTEND_DURATIONS[i.effectType] !== undefined);
  if (extendItems.length === 0) {
    await interaction.reply({ content: "❌ このサーバーには延長券が設定されていません。", ephemeral: true });
    return;
  }
  const settings = await getGuildSettings(interaction.guild.id);
  const options = extendItems.map((i) => ({
    label: i.name,
    description: `${i.price.toLocaleString()} ${settings.currencyName}`,
    value: String(i.id),
  }));
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(vcPanelId(VC_PANEL_SEL_EXTEND, channelId, ownerId))
      .setPlaceholder("使用する延長券を選択")
      .addOptions(options),
  );
  await interaction.reply({ content: "使用する延長券を選んでください：", components: [row], ephemeral: true });
}

export async function handleVcPanelExpiryBtn(interaction: ButtonInteraction): Promise<void> {
  const { channelId } = parseVcPanelId(VC_PANEL_BTN_EXPIRY, interaction.customId);
  const session = await getPrivateVcSessionByChannelId(channelId);
  if (!session) {
    await interaction.reply({ content: "⏳ このVCは無期限です。", ephemeral: true });
    return;
  }
  const ts = Math.floor(session.expiresAt.getTime() / 1000);
  await interaction.reply({ content: `⏳ 期限: <t:${ts}:F>（<t:${ts}:R>）`, ephemeral: true });
}

// ─── 宝箱 ────────────────────────────────────────────────────────────────────

// 本船員宝箱の当選確率テーブル（累積）:
//   miss          49.9%
//   coin_5k       28.0%
//   coin_10k      15.0%
//   coin_30k       4.5%
//   coin_50k       1.5%
//   coin_100k      1.0%
//   limited_role   0.1%
type ChestResult =
  | "miss"
  | "coin_5k"
  | "coin_10k"
  | "coin_30k"
  | "coin_50k"
  | "coin_100k"
  | "limited_role";

/**
 * 新入り宝箱の確率テーブル:
 *   💨 ハズレ          50.0%
 *   🎫 アドバイス券     1.0%
 *   💎  50,000$         1.5%
 *   🎊  30,000$         2.5%
 *   🎁  10,000$        10.0%
 *   🌟   5,000$        15.0%
 *   🪙   1,000$        20.0%
 * 戻り値: 当選コイン数（0 = ハズレ）または "advice_ticket"
 */
function rollShinniriChest(): number | "advice_ticket" {
  const r = Math.random();
  if (r < 0.500) return 0;               // 💨 ハズレ    50.0%
  if (r < 0.700) return 1_000;           // 🪙 1,000$    20.0%
  if (r < 0.850) return 5_000;           // 🌟 5,000$    15.0%
  if (r < 0.950) return 10_000;          // 🎁 10,000$   10.0%
  if (r < 0.975) return 30_000;          // 🎊 30,000$    2.5%
  if (r < 0.990) return 50_000;          // 💎 50,000$    1.5%
  return "advice_ticket";                // 🎫 アドバイス券 1.0%
}

/** 本船員宝箱の確率テーブル */
function rollChest(): ChestResult {
  const r = Math.random();
  if (r < 0.499)  return "miss";         // 💨 49.9%
  if (r < 0.779)  return "coin_5k";      // 🌟 28.0%
  if (r < 0.929)  return "coin_10k";     // 🎁 15.0%
  if (r < 0.974)  return "coin_30k";     // 🎊  4.5%
  if (r < 0.989)  return "coin_50k";     // 💎  1.5%
  if (r < 0.999)  return "coin_100k";    // 👑  1.0%
  return "limited_role";                  // 🌈  0.1%
}

const CHEST_ROLE_LIMITED = "豪運";

/** 指定名のロールをメンバーに付与する。ロールが存在しない場合は false を返す。 */
async function grantRoleByName(guild: Guild, userId: string, roleName: string): Promise<boolean> {
  await guild.roles.fetch(); // キャッシュを最新化
  const role = guild.roles.cache.find((r) => r.name === roleName);
  if (!role) return false;
  const member = guild.members.cache.get(userId) ?? await guild.members.fetch(userId);
  await member.roles.add(role);
  return true;
}

/** 宝箱パネルのメッセージを生成 */
export function buildChestPanelMessage(chestType: "shinniri" | "honsennin") {
  const isHon = chestType === "honsennin";
  const embed = new EmbedBuilder()
    .setTitle(isHon ? "🎁 本船員宝箱" : "🎁 新入り宝箱")
    .setColor(isHon ? 0x5865f2 : 0xf6a623)
    .setDescription(
      `**${isHon ? "本船員" : "新入り"}** ロールを持つメンバー限定\n\n` +
      "**酒場🍺** に累計 **1時間** 接続すると 1回チャレンジできます。\n\n" +
      "🎲 何が出るかはお楽しみ！",
    )
    .setFooter({ text: "🎲 運試し、してみる？" });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(isHon ? CHEST_OPEN_BTN_HONSENNIN : CHEST_OPEN_BTN_SHINNIRI)
      .setLabel("宝箱を開ける")
      .setStyle(ButtonStyle.Primary)
      .setEmoji("✨"),
  );
  return { embeds: [embed], components: [row] };
}

// 宝箱は常設（期限なし）
// ロール名定数
const CHEST_ROLE_SHINNIRI  = "新入り";
const CHEST_ROLE_HONSENNIN = "本船員";
const CHEST_INTERVAL_SEC   = 3600; // 1時間ごとに1回

/**
 * 開封に必要な酒場VC時間の進捗を計算する。
 * lastOpenVcSeconds は「最後に開けた時点」ではなく、消費済み時間の
 * チェックポイントとして扱い、開封時には1時間分だけ進める。
 */
export function getChestOpenProgress(
  totalSeconds: number,
  lastOpenVcSeconds: number,
  intervalSeconds = CHEST_INTERVAL_SEC,
): {
  elapsedSeconds: number;
  remainingSeconds: number;
  canOpen: boolean;
  nextCheckpointSeconds: number;
} {
  const normalizedLastOpen = Math.min(Math.max(0, lastOpenVcSeconds), totalSeconds);
  const elapsedSeconds = Math.max(0, totalSeconds - normalizedLastOpen);
  return {
    elapsedSeconds,
    remainingSeconds: Math.max(0, intervalSeconds - elapsedSeconds),
    canOpen: elapsedSeconds >= intervalSeconds,
    nextCheckpointSeconds: normalizedLastOpen + intervalSeconds,
  };
}

export async function handleChestOpenBtn(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild) return;

  await interaction.deferReply({ ephemeral: true });

  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;

  // どちらの宝箱か判定（旧 "chest:open" は 新入り扱い）
  const chestType: "shinniri" | "honsennin" =
    interaction.customId === CHEST_OPEN_BTN_HONSENNIN ? "honsennin" : "shinniri";
  const requiredRole = chestType === "honsennin" ? CHEST_ROLE_HONSENNIN : CHEST_ROLE_SHINNIRI;

  // ロールチェック（管理者は免除）
  // 新入り宝箱 → 新入りロール限定（本船員は本船員宝箱のみ）
  // 本船員宝箱 → 本船員ロール限定
  if (!isAdmin) {
    const member = interaction.member as GuildMember;
    const hasShinniri  = member.roles.cache.some((r) => r.name === CHEST_ROLE_SHINNIRI);
    const hasHonsennin = member.roles.cache.some((r) => r.name === CHEST_ROLE_HONSENNIN);

    if (chestType === "shinniri") {
      if (hasHonsennin) {
        await interaction.editReply(`❌ **${CHEST_ROLE_HONSENNIN}** は本船員の宝箱のみ引けます。`);
        return;
      }
      if (!hasShinniri) {
        await interaction.editReply(`❌ この宝箱は **${CHEST_ROLE_SHINNIRI}** ロールを持つメンバーのみ引けます。`);
        return;
      }
    } else {
      if (!hasHonsennin) {
        await interaction.editReply(`❌ この宝箱は **${CHEST_ROLE_HONSENNIN}** ロールを持つメンバーのみ引けます。`);
        return;
      }
    }
  }

  // VC時間チェック（前回開封から CHEST_INTERVAL_SEC 以上の酒場VC接続が必要）
  // totalSeconds = 全期間の累積DB秒数 + 現在セッション中の秒数
  // elapsedSinceLastOpen = totalSeconds - 前回開封時のtotalSeconds
  // elapsedSinceLastOpen >= CHEST_INTERVAL_SEC で開封可能
  let nextCheckpointSeconds = 0;
  let usedBonusOpen = false;
  if (!isAdmin) {
    // ── ボーナス開封チェック ──────────────────────────────────────────────────
    // 管理者が付与したボーナス回数が残っていれば、クールダウン無視で1回消費する。
    // ボーナス消費時は lastOpenVcSeconds を更新しない（通常クールダウンに影響させない）。
    const bonus = await getChestBonusOpens(interaction.guild.id, interaction.user.id, chestType);
    if (bonus > 0) {
      const consumed = await consumeChestBonusOpen(interaction.guild.id, interaction.user.id, chestType);
      if (consumed) usedBonusOpen = true;
    }

    if (!usedBonusOpen) {
      // 酒場VCにいるのにトラッキングされていない場合（Bot再起動直後など）は自己修復
      if (getCurrentTavernSeconds(interaction.guild.id, interaction.user.id) === 0) {
        const voiceChannelId = interaction.guild.voiceStates.cache.get(interaction.user.id)?.channelId;
        if (voiceChannelId && await isTavernChannel(interaction.guild.id, interaction.guild, voiceChannelId)) {
          onTavernJoin(interaction.guild.id, interaction.user.id);
          logger.info(`[chest] Self-healed tavern tracking for ${interaction.user.id} in ${voiceChannelId}`);
        }
      }

      const currentSeconds = getCurrentTavernSeconds(interaction.guild.id, interaction.user.id);
      const pendingSeconds = getPendingTavernSeconds(interaction.guild.id, interaction.user.id);
      // chest_vc_accum（10分ごとにフラッシュ）＋DB反映待ちの秒数＋現在セッション中の秒数を使う。
      // vc_session_logs との MAX() は Flush 後に currentSeconds がリセットされると
      // totalSeconds が下がり elapsed が負になる問題を起こすため廃止。
      const [chestAccumSeconds, opensCount, lastOpenVcSeconds] = await Promise.all([
        getTotalChestVcSeconds(interaction.guild.id, interaction.user.id),
        getTotalChestOpensCount(interaction.guild.id, interaction.user.id),
        getChestLastOpenVcSeconds(interaction.guild.id, interaction.user.id, chestType),
      ]);
      const totalSeconds = chestAccumSeconds + pendingSeconds + currentSeconds;
      const progress = getChestOpenProgress(totalSeconds, lastOpenVcSeconds);
      const elapsed = progress.elapsedSeconds;
      // 次回開封時は累計時間をリセットせず、消費した1時間分だけ進める。
      // 例: 1時間30分で開封した場合、チェックポイントは1時間となり、
      // 残り30分は次回へ繰り越される。
      nextCheckpointSeconds = progress.nextCheckpointSeconds;

      if (elapsed < CHEST_INTERVAL_SEC) {
        const remaining = Math.ceil(progress.remainingSeconds / 60);
        const elapsedMin = Math.floor(elapsed / 60);
        const neededMin = Math.ceil(CHEST_INTERVAL_SEC / 60);
        const progressLine = `（累計酒場VC時間: ${elapsedMin}分 / ${neededMin}分）`;
        if (opensCount === 0) {
          await interaction.editReply(
            `⏳ 宝箱を開けるにはあと **${remaining}分** の酒場VC接続が必要です。\n${progressLine}`,
          );
        } else {
          await interaction.editReply(
            `📦 次の宝箱まであと **${remaining}分** の酒場VC接続が必要です。（${opensCount}回開封済み）\n${progressLine}`,
          );
        }
        return;
      }
    }
  }

  // 開封記録（管理者は記録しない＝何度でも開封可能）
  // ボーナス消費時は lastOpenVcSeconds を更新しない（通常クールダウンに影響させない）。
  if (!isAdmin) {
    const recordOps: Promise<unknown>[] = [
      incrementChestOpensToday(interaction.guild.id, interaction.user.id),
    ];
    if (!usedBonusOpen) {
      recordOps.push(setChestLastOpenVcSeconds(interaction.guild.id, interaction.user.id, chestType, nextCheckpointSeconds));
    }
    await Promise.all(recordOps);
  }

  const settings = await getGuildSettings(interaction.guild.id);
  const cn = settings.currencyName;

  /** ログを専用チャンネルに投稿するヘルパー */
  async function postChestLog(opts: {
    chestLabel: string;
    resultLabel: string;
    resultEmoji: string;
    amount: number | null;
    hit: boolean;
  }): Promise<void> {
    const logChannelId = settings.chestLogChannelId;
    if (!logChannelId) return;
    try {
      const logChannel = await interaction.guild!.channels.fetch(logChannelId).catch(() => null);
      if (!logChannel || !logChannel.isTextBased()) return;
      const embed = new EmbedBuilder()
        .setTitle(`${opts.hit ? "🎁" : "📦"} 宝箱開封ログ`)
        .setColor(opts.hit ? 0xf5c518 : 0x888888)
        .addFields(
          { name: "ユーザー", value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
          { name: "種類", value: opts.chestLabel, inline: true },
          { name: "結果", value: `${opts.resultEmoji} ${opts.resultLabel}${opts.amount !== null ? `  **${opts.amount.toLocaleString()}${cn}**` : ""}`, inline: false },
        )
        .setTimestamp();
      await logChannel.send({ embeds: [embed] });
    } catch (e) {
      logger.warn("宝箱ログ投稿失敗", e);
    }
  }

  // ── 新入り宝箱 ────────────────────────────────────────────────────────────
  if (chestType === "shinniri") {
    const roll = rollShinniriChest();

    // アドバイス券
    if (roll === "advice_ticket") {
      const ADVICE_ROLE = "評価員アドバイス券";
      const granted = await grantRoleByName(interaction.guild, interaction.user.id, ADVICE_ROLE);
      await Promise.all([
        interaction.editReply(
          granted
            ? `📦 宝箱を開けた！\n\n🎫 **アドバイス券** を獲得しました！`
            : `📦 宝箱を開けた！\n\n🎫 **アドバイス券** が当たりましたが、ロールが見つかりませんでした（管理者に連絡してください）。`,
        ),
        postChestLog({ chestLabel: "新入り宝箱", resultLabel: "アドバイス券", resultEmoji: "🎫", amount: null, hit: true }),
      ]);
      return;
    }

    // 通貨 or ハズレ
    if (roll === 0) {
      await Promise.all([
        interaction.editReply("📦 宝箱を開けた…\n\n**ハズレ** 💨 何も入っていませんでした。"),
        postChestLog({ chestLabel: "新入り宝箱", resultLabel: "ハズレ", resultEmoji: "💨", amount: null, hit: false }),
      ]);
    } else {
      const emoji = roll >= 50_000 ? "💎" : roll >= 30_000 ? "🎊" : roll >= 10_000 ? "🎁" : roll >= 5_000 ? "🌟" : "🪙";
      await Promise.all([
        giveCurrency(interaction.guild.id, interaction.user.id, roll, "treasure-chest").then(() =>
          interaction.editReply(`📦 宝箱を開けた！\n\n${emoji} **${roll.toLocaleString()}${cn}** を獲得しました！`)
        ),
        postChestLog({ chestLabel: "新入り宝箱", resultLabel: `${roll.toLocaleString()}${cn}`, resultEmoji: emoji, amount: roll, hit: true }),
      ]);
    }
    return;
  }

  // ── 本船員宝箱: 既存の確率テーブル ────────────────────────────────────────
  const result = rollChest();

  // ── 限定ロール賞品 ────────────────────────────────────────────────────────
  if (result === "limited_role") {
    const granted = await grantRoleByName(interaction.guild, interaction.user.id, CHEST_ROLE_LIMITED);
    const limitedEmbed = granted
      ? new EmbedBuilder()
          .setTitle("🌈✨　大当たり　✨🌈")
          .setDescription(
            `## <@${interaction.user.id}> さん、おめでとうございます！\n\n` +
            `宝箱から **超激レア** な景品が飛び出した！\n\n` +
            `> 🎊 **限定ロール「${CHEST_ROLE_LIMITED}」** を獲得！\n\n` +
            `*確率 0.1% の奇跡を引き当てました。*`,
          )
          .setColor(0xffd700)
          .setThumbnail(interaction.user.displayAvatarURL())
          .setFooter({ text: "本船員宝箱 — 0.1% の奇跡" })
          .setTimestamp()
      : new EmbedBuilder()
          .setTitle("🌈　限定ロール当選！")
          .setDescription(
            `<@${interaction.user.id}> さんに **限定ロール** が当たりました！\n\n` +
            `⚠️ ロール「${CHEST_ROLE_LIMITED}」が見つかりませんでした。管理者にお問い合わせください。`,
          )
          .setColor(0xff9900)
          .setTimestamp();
    await Promise.all([
      interaction.editReply({ content: granted ? "🎉🎉🎉" : "", embeds: [limitedEmbed] }),
      postChestLog({ chestLabel: "本船員宝箱", resultLabel: `限定ロール（${CHEST_ROLE_LIMITED}）`, resultEmoji: "🌈", amount: null, hit: true }),
    ]);
    return;
  }

  // ── 通貨賞品 ──────────────────────────────────────────────────────────────
  const coinPrizes: Partial<Record<ChestResult, { amount: number; label: string; emoji: string }>> = {
    coin_5k:   { amount:   5_000, label: "当たり",   emoji: "🌟" },
    coin_10k:  { amount:  10_000, label: "大当たり", emoji: "🎁" },
    coin_30k:  { amount:  30_000, label: "レア",     emoji: "🎊" },
    coin_50k:  { amount:  50_000, label: "超レア",   emoji: "💎" },
    coin_100k: { amount: 100_000, label: "伝説",     emoji: "👑" },
  };

  const coin = coinPrizes[result];
  if (coin) {
    await Promise.all([
      giveCurrency(interaction.guild.id, interaction.user.id, coin.amount, "treasure-chest").then(() =>
        interaction.editReply(`📦 宝箱を開けた！\n\n**${coin.label}** ${coin.emoji} **${coin.amount.toLocaleString()}${cn}** を獲得しました！`)
      ),
      postChestLog({ chestLabel: "本船員宝箱", resultLabel: coin.label, resultEmoji: coin.emoji, amount: coin.amount, hit: true }),
    ]);
    return;
  }

  // miss
  await Promise.all([
    interaction.editReply("📦 宝箱を開けた…\n\n**ハズレ** 💨 何も入っていませんでした。"),
    postChestLog({ chestLabel: "本船員宝箱", resultLabel: "ハズレ", resultEmoji: "💨", amount: null, hit: false }),
  ]);
}

export async function handleVcPanelAddSel(
  interaction: StringSelectMenuInteraction | UserSelectMenuInteraction,
): Promise<void> {
  if (!interaction.guild) return;
  const { channelId, ownerId } = parseVcPanelPagedId(VC_PANEL_SEL_ADD, interaction.customId);
  if (!checkOwner(interaction, ownerId)) return;
  const targetId = interaction.values[0];
  if (!targetId) { await interaction.reply({ content: "❌ ユーザーが選択されていません。", ephemeral: true }); return; }
  if (targetId === interaction.user.id) { await interaction.reply({ content: "❌ 自分自身を追加することはできません。", ephemeral: true }); return; }
  const targetMember = await interaction.guild.members.fetch(targetId).catch(() => null);
  if (!targetMember) {
    await interaction.reply({ content: "❌ メンバーが見つかりませんでした。", ephemeral: true });
    return;
  }
  const targetRoleNames = targetMember.roles.cache.map((role) => role.name);
  if (hasLuxuryVcBlockedRole(targetRoleNames)) {
    await interaction.reply({
      content: "❌ 追放者ロールを持つメンバーは高級船室に追加できません。",
      ephemeral: true,
    });
    return;
  }
  if (!isEligibleForLuxuryVcAdd(targetRoleNames)) {
    await interaction.reply({
      content: `❌ ${LUXURY_VC_ADD_ROLE_NAMES.join("・")}のいずれかのロールを持つメンバーのみ高級船室へ追加できます。`,
      ephemeral: true,
    });
    return;
  }
  const ch = interaction.guild.channels.cache.get(channelId)
    ?? await interaction.guild.channels.fetch(channelId).catch(() => null);
  if (!ch || !("permissionOverwrites" in ch)) {
    await interaction.reply({ content: "❌ VCチャンネルが見つかりませんでした。", ephemeral: true }); return;
  }
  // 画面共有の現在状態を引き継いで追加メンバーにも適用
  const streamEnabledOnAdd = isPrivateVcStreamEnabled(ch as import("discord.js").GuildChannel, ownerId);
  await ch.permissionOverwrites.edit(targetId, {
    ViewChannel: true, Connect: true, Speak: true,
    Stream: streamEnabledOnAdd, SendMessages: true, AttachFiles: true,
  });
  await interaction.reply({ content: `✅ <@${targetId}> をVCに追加しました。`, ephemeral: true });
  // Refresh the panel so the new member appears in the access list (best-effort).
  try {
    if ("messages" in ch) {
      const session = await getPrivateVcSessionByChannelId(channelId);
      await refreshPrivateVcPanelMessage(
        ch as import("discord.js").TextBasedChannel & import("discord.js").GuildChannel,
        {
          channelId,
          ownerId,
          botId: interaction.client.user?.id,
          expiresAt: session?.expiresAt,
          category: session?.category,
          addedMemberId: targetId,
          streamEnabled: streamEnabledOnAdd,
        },
      );
    }
  } catch (err) {
    logger.error(`[vc-panel] Failed to refresh panel after add for channel ${channelId}`, err);
  }
}

export async function handleVcPanelKickSel(
  interaction: StringSelectMenuInteraction | UserSelectMenuInteraction,
): Promise<void> {
  if (!interaction.guild) return;
  const { channelId, ownerId } = parseVcPanelPagedId(VC_PANEL_SEL_KICK, interaction.customId);
  if (!checkOwner(interaction, ownerId)) return;
  const targetId = interaction.values[0];
  if (!targetId) { await interaction.reply({ content: "❌ ユーザーが選択されていません。", ephemeral: true }); return; }
  if (targetId === interaction.user.id) { await interaction.reply({ content: "❌ 自分自身をキックすることはできません。", ephemeral: true }); return; }
  const ch = interaction.guild.channels.cache.get(channelId)
    ?? await interaction.guild.channels.fetch(channelId).catch(() => null);
  if (!ch || !("permissionOverwrites" in ch)) {
    await interaction.reply({ content: "❌ VCチャンネルが見つかりませんでした。", ephemeral: true }); return;
  }
  const accessMemberIds = getVcAccessMemberIds(
    ch as import("discord.js").GuildChannel,
    ownerId,
    interaction.client.user?.id,
  );
  if (!accessMemberIds.includes(targetId)) {
    await interaction.reply({
      content: "❌ このメンバーは現在、高級船室へのアクセス権を持っていません。",
      ephemeral: true,
    });
    return;
  }
  const kickResult = await kickPrivateVcMember(
    interaction.guild,
    ch as import("discord.js").GuildChannel,
    targetId,
  );
  if (!kickResult.ok) {
    await interaction.reply({ content: kickResult.message, ephemeral: true });
    return;
  }
  await interaction.reply({ content: `✅ <@${targetId}> をキックしました。`, ephemeral: true });
  // Refresh the panel so the removed member disappears from the access list (best-effort).
  try {
    if ("messages" in ch) {
      const session = await getPrivateVcSessionByChannelId(channelId);
      await refreshPrivateVcPanelMessage(
        ch as import("discord.js").TextBasedChannel & import("discord.js").GuildChannel,
        {
          channelId,
          ownerId,
          botId: interaction.client.user?.id,
          expiresAt: session?.expiresAt,
          category: session?.category,
          removedMemberId: targetId,
        },
      );
    }
  } catch (err) {
    logger.error(`[vc-panel] Failed to refresh panel after kick for channel ${channelId}`, err);
  }
}

export async function handleVcPanelExtendSel(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!interaction.guild) return;
  const { channelId, ownerId } = parseVcPanelId(VC_PANEL_SEL_EXTEND, interaction.customId);
  if (!checkOwner(interaction, ownerId)) return;
  const session = await getPrivateVcSessionByChannelId(channelId);
  if (!session) { await interaction.reply({ content: "❌ セッションが見つかりません。", ephemeral: true }); return; }
  const itemId = parseInt(interaction.values[0]!, 10);
  const item = await getShopItem(interaction.guild.id, itemId);
  if (!item?.effectType) { await interaction.reply({ content: "❌ アイテムが見つかりません。", ephemeral: true }); return; }
  const duration = VC_EXTEND_DURATIONS[item.effectType];
  if (duration === undefined) { await interaction.reply({ content: "❌ 無効な延長券です。", ephemeral: true }); return; }
  await interaction.deferReply({ ephemeral: true });
  const settings = await getGuildSettings(interaction.guild.id);
  const result = await buyItem(interaction.guild.id, interaction.user.id, itemId, settings.currencyName);
  if (!result.ok) { await interaction.editReply(result.reason); return; }
  const updated = await extendPrivateVcSession(session.id, duration);
  // Resolve the channel name from the guild cache for use as a fallback
  // schedule name in case extendOrRepairVcSchedule needs to create a new row.
  const chForPanel = interaction.guild.channels.cache.get(channelId)
    ?? await interaction.guild.channels.fetch(channelId).catch(() => null);
  const fallbackNamePanel = chForPanel && "name" in chForPanel && chForPanel.name
    ? chForPanel.name
    : channelId;
  await extendOrRepairVcSchedule({
    channelId,
    guildId: interaction.guild.id,
    newExpiresAt: updated.expiresAt,
    fallbackName: fallbackNamePanel,
    userId: session.userId ?? undefined,
    logPrefix: "vc-panel",
  });
  // パネルの期限表示を更新（best-effort）
  try {
    const textCh = chForPanel;
    if (textCh && "messages" in textCh) {
      const msgs = await (textCh as import("discord.js").TextBasedChannel).messages.fetch({ limit: 20 });
      const panelMsg = msgs.find(
        (m) => m.author.id === interaction.client.user?.id
          && (m.embeds[0]?.title === VC_PANEL_TITLE || LEGACY_VC_PANEL_TITLES.has(m.embeds[0]?.title ?? "")),
      );
      if (panelMsg) {
        const memberIds = getVcAccessMemberIds(textCh as import("discord.js").GuildChannel, ownerId, interaction.client.user?.id);
        const streamEnabledOnExtend = isPrivateVcStreamEnabled(textCh as import("discord.js").GuildChannel, ownerId);
        await panelMsg.edit(buildVcPanelMessage(channelId, ownerId, updated.expiresAt, memberIds, streamEnabledOnExtend, isFreeRoomCategory(session.category)));
      }
    }
  } catch { /* best-effort */ }
  const ts = Math.floor(updated.expiresAt.getTime() / 1000);
  await interaction.editReply(`✅ **${result.item.name}**を使用しました！期限が <t:${ts}:F> まで延長されました。`);
}

const VC_PANEL_RENAME_INPUT_ID = "vc-panel-new-name";

function buildRenameModal(channelId: string, ownerId: string, itemId: number) {
  return new ModalBuilder()
    .setCustomId(`${VC_PANEL_RENAME_MODAL}${channelId}:${ownerId}:${itemId}`)
    .setTitle("VC名変更")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(VC_PANEL_RENAME_INPUT_ID)
          .setLabel("新しいVC名（🔒 は自動で付きます）")
          .setStyle(TextInputStyle.Short)
          .setMaxLength(90)
          .setRequired(true),
      ),
    );
}
export async function handleVcPanelRenameBtn(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild) return;
  const { channelId, ownerId } = parseVcPanelId(VC_PANEL_BTN_RENAME, interaction.customId);
  if (!checkOwner(interaction, ownerId)) return;
  const allVcItems = await listShopItems(interaction.guild.id, "vc");
  const renameItems = allVcItems.filter((i) => i.effectType === VC_RENAME_EFFECT);
  if (renameItems.length === 0) {
    // 名前変更券が未設定の場合は無料でリネーム（itemId=0 は無料の特殊ケース）
    await interaction.showModal(buildRenameModal(channelId, ownerId, 0));
    return;
  }
  if (renameItems.length === 1) {
    // アイテムが1種類のみ → 直接モーダル表示
    await interaction.showModal(buildRenameModal(channelId, ownerId, renameItems[0]!.id));
    return;
  }
  // 複数ある場合はまずアイテムを選ばせる
  const settings = await getGuildSettings(interaction.guild.id);
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(vcPanelId(VC_PANEL_SEL_RENAME, channelId, ownerId))
      .setPlaceholder("使用する名前変更券を選択")
      .addOptions(renameItems.map((i) => ({
        label: i.name,
        description: `${i.price.toLocaleString()} ${settings.currencyName}`,
        value: String(i.id),
      }))),
  );
  await interaction.reply({ content: "使用する名前変更券を選んでください：", components: [row], ephemeral: true });
}

export async function handleVcPanelRenameSel(interaction: StringSelectMenuInteraction): Promise<void> {
  const { channelId, ownerId } = parseVcPanelId(VC_PANEL_SEL_RENAME, interaction.customId);
  if (!checkOwner(interaction, ownerId)) return;
  const itemId = parseInt(interaction.values[0]!, 10);
  await interaction.showModal(buildRenameModal(channelId, ownerId, itemId));
}
export async function handleVcPanelRenameModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.guild) return;
  const payload = interaction.customId.slice(VC_PANEL_RENAME_MODAL.length);
  const parts = payload.split(":");
  const channelId = parts[0]!;
  const ownerId   = parts[1]!;
  const itemId    = parseInt(parts[2]!, 10);
  if (interaction.user.id !== ownerId) {
    await interaction.reply({ content: "❌ VCオーナーのみ操作できます。", ephemeral: true }); return;
  }
  const newName = interaction.fields.getTextInputValue(VC_PANEL_RENAME_INPUT_ID).trim();
  if (!newName) { await interaction.reply({ content: "❌ VC名を入力してください。", ephemeral: true }); return; }
  await interaction.deferReply({ ephemeral: true });
  const renamedName = `🔒 ${newName}`.slice(0, 100);

  // itemId=0 は名前変更券なし（無料リネーム）
  const isFree = itemId === 0;
  let purchaseResult: Awaited<ReturnType<typeof buyItem>> | null = null;
  if (!isFree) {
    const settings = await getGuildSettings(interaction.guild.id);
    purchaseResult = await buyItem(interaction.guild.id, interaction.user.id, itemId, settings.currencyName);
    if (!purchaseResult.ok) { await interaction.editReply(purchaseResult.reason); return; }
  }

  try {
    const ch = interaction.guild.channels.cache.get(channelId)
      ?? await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!ch) throw new Error("channel not found");
    await ch.setName(renamedName);
    // スケジュール更新（best-effort）
    try {
      const session = await getPrivateVcSessionByChannelId(channelId);
      if (session?.expiresAt) {
        await saveSchedule(interaction.guild.id, channelId, renamedName, session.expiresAt, ownerId);
      }
    } catch (scheduleErr) {
      logger.error("[vc-panel] Failed to save schedule after rename", scheduleErr);
    }
    const successMsg = isFree
      ? `✅ VCを「${renamedName}」にリネームしました。`
      : `✅ **${purchaseResult!.item.name}**を使用しました！VCを「${renamedName}」にリネームしました。`;
    await interaction.editReply(successMsg);
  } catch {
    if (!isFree && purchaseResult) {
      await refundPurchase(interaction.guild.id, interaction.user.id, purchaseResult.item);
      await interaction.editReply("❌ チャンネルのリネームに失敗しました。購入を取り消し、返金しました。");
    } else {
      await interaction.editReply("❌ チャンネルのリネームに失敗しました。");
    }
  }
}

/** 🔄 既存の高級船室パネルを一括更新（/vc refresh-panels） */
export async function handleVcRefreshPanels(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild || !interaction.guildId) return;
  await interaction.deferReply({ ephemeral: true });

  const sessions = await getActivePrivateVcSessionsByGuild(interaction.guildId);
  if (sessions.length === 0) {
    await interaction.editReply("このサーバーにアクティブな高級船室はありません。");
    return;
  }

  let updated = 0;
  let skipped = 0;
  for (const session of sessions) {
    try {
      const ch = interaction.guild.channels.cache.get(session.channelId)
        ?? await interaction.guild.channels.fetch(session.channelId).catch(() => null);
      if (!ch || !("messages" in ch)) { skipped++; continue; }
      const textCh = ch as import("discord.js").TextBasedChannel & import("discord.js").GuildChannel;
      const botId = interaction.client.user?.id;
      // 旧タイトル「非公開VC コントロールパネル」も含めてマッチ（移行後に新タイトルへ上書き）
      const isPanel = (m: import("discord.js").Message) =>
        m.author.id === botId && (
          LEGACY_VC_PANEL_TITLES.has(m.embeds[0]?.title ?? "") ||
          m.embeds[0]?.title === VC_PANEL_TITLE
        );
      const oldMsgs = await textCh.messages.fetch({ limit: 10, after: "0" });
      const recentMsgs = await textCh.messages.fetch({ limit: 50 });
      const panelMsg = oldMsgs.find(isPanel) ?? recentMsgs.find(isPanel);
      if (!panelMsg) { skipped++; continue; }
      const memberIds = getVcAccessMemberIds(textCh, session.userId, interaction.client.user?.id);
      const streamEnabled = isPrivateVcStreamEnabled(textCh, session.userId);
      await panelMsg.edit(buildVcPanelMessage(session.channelId, session.userId, session.expiresAt, memberIds, streamEnabled, isFreeRoomCategory(session.category)));
      updated++;
    } catch (err) {
      logger.warn(`[vc-refresh] Failed to refresh panel for channel ${session.channelId}`, err);
      skipped++;
    }
  }

  await interaction.editReply(
    `✅ 高級船室パネルを更新しました。\n更新: ${updated} 件 / スキップ: ${skipped} 件（チャンネル消失・パネルなし）`,
  );
}

/**
 * 🔄 全ギルドの既存高級船室パネルをメンバーリスト・期限・ボタン含めて一括更新。
 * 起動時・定期スケジューラ両方から呼ばれる。
 */
export async function refreshAllVcPanels(discordClient: import("discord.js").Client): Promise<void> {
  let updated = 0;
  let skipped = 0;
  for (const guild of discordClient.guilds.cache.values()) {
    try {
      const sessions = await getActivePrivateVcSessionsByGuild(guild.id);
      const freeRoomSettings = sessions.some((session) => isFreeRoomCategory(session.category))
        ? await resolveFreeRoomSettings(guild)
        : null;
      for (const session of sessions) {
        try {
          const ch = guild.channels.cache.get(session.channelId)
            ?? await guild.channels.fetch(session.channelId).catch(() => null);
          if (!ch || !("messages" in ch)) { skipped++; continue; }
          const textCh = ch as import("discord.js").TextBasedChannel & import("discord.js").GuildChannel;
          if (isFreeRoomCategory(session.category) && freeRoomSettings) {
            for (const roleId of freeRoomSettings.accessRoleIds) {
              await textCh.permissionOverwrites.edit(roleId, {
                ViewChannel: true,
                Connect: true,
                Speak: true,
                SendMessages: true,
              });
            }
          }
          const botId = discordClient.user?.id;
          // 旧タイトル「非公開VC コントロールパネル」も含めてマッチ（移行後に新タイトルへ上書き）
          const isPanel = (m: import("discord.js").Message) =>
            m.author.id === botId && (
              LEGACY_VC_PANEL_TITLES.has(m.embeds[0]?.title ?? "") ||
              m.embeds[0]?.title === VC_PANEL_TITLE
            );
          // パネルは通常チャンネル作成直後（最古付近）に投稿される。
          // 再投稿されて中間〜末尾にある場合も拾えるよう2パスで検索する。
          const oldMsgs = await textCh.messages.fetch({ limit: 10, after: "0" });
          const recentMsgs = await textCh.messages.fetch({ limit: 50 });
          const panelMsg = oldMsgs.find(isPanel) ?? recentMsgs.find(isPanel);
          if (!panelMsg) { skipped++; continue; }
          const memberIds = getVcAccessMemberIds(textCh, session.userId, discordClient.user?.id);
          const streamEnabled = isPrivateVcStreamEnabled(textCh, session.userId);
          await panelMsg.edit(buildVcPanelMessage(session.channelId, session.userId, session.expiresAt ?? undefined, memberIds, streamEnabled, isFreeRoomCategory(session.category)));
          updated++;
        } catch (err) {
          logger.warn(`[vc-panel-refresh] Failed to refresh panel for channel ${session.channelId}`, err);
          skipped++;
        }
      }
    } catch (err) {
      logger.warn(`[vc-panel-refresh] Failed to get sessions for guild ${guild.id}`, err);
    }
  }
  logger.info(`[vc-panel-refresh] 完了: 更新 ${updated} 件 / スキップ ${skipped} 件`);
}

/** 📺 画面共有トグル（高級船室） */
export async function handleVcPanelStreamBtn(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild) return;
  const { channelId, ownerId } = parseVcPanelId(VC_PANEL_BTN_STREAM, interaction.customId);
  if (!checkOwner(interaction, ownerId)) return;
  await interaction.deferReply({ ephemeral: true });

  const ch = interaction.guild.channels.cache.get(channelId)
    ?? await interaction.guild.channels.fetch(channelId).catch(() => null);
  if (!ch || !("permissionOverwrites" in ch)) {
    await interaction.editReply("❌ チャンネルが見つかりません。");
    return;
  }
  const nowEnabled = isPrivateVcStreamEnabled(ch as import("discord.js").GuildChannel, ownerId);
  const newState   = !nowEnabled;

  // オーナーの上書きに Stream を追加 / 削除
  await (ch as import("discord.js").GuildChannel).permissionOverwrites.edit(
    ownerId,
    newState ? { Stream: true } : { Stream: false },
  );

  // 招待済みメンバーにも同じ設定を反映
  const memberIds = getVcAccessMemberIds(
    ch as import("discord.js").GuildChannel,
    ownerId,
    interaction.client.user?.id,
  );
  for (const mid of memberIds) {
    await (ch as import("discord.js").GuildChannel).permissionOverwrites.edit(
      mid,
      newState ? { Stream: true } : { Stream: false },
    ).catch(() => {});
  }

  // パネル更新（best-effort）
  try {
    if ("messages" in ch) {
      const msgs = await (ch as import("discord.js").TextBasedChannel).messages.fetch({ limit: 20 });
      const panelMsg = msgs.find(
        (m) =>
          m.author.id === interaction.client.user?.id &&
          (m.embeds[0]?.title === VC_PANEL_TITLE || LEGACY_VC_PANEL_TITLES.has(m.embeds[0]?.title ?? "")),
      );
      if (panelMsg) {
        const session = await getPrivateVcSessionByChannelId(channelId).catch(() => null);
        const refreshedMemberIds = getVcAccessMemberIds(
          ch as import("discord.js").GuildChannel,
          ownerId,
          interaction.client.user?.id,
        );
        await panelMsg.edit(
          buildVcPanelMessage(channelId, ownerId, session?.expiresAt ?? undefined, refreshedMemberIds, newState, isFreeRoomCategory(session?.category)),
        );
      }
    }
  } catch (err) {
    logger.error(`[vc-panel] Failed to update panel after stream toggle channel=${channelId}`, err);
  }

  await interaction.editReply(
    `✅ 画面共有を **${newState ? "有効 ✅" : "無効 🚫"}** にしました。`,
  );
}

const chestCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("宝箱")
    .setDescription("宝箱パネルを設置します（管理者専用）")
    .setDefaultMemberPermissions(0)
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("このチャンネルに宝箱パネルを設置します")
        .addStringOption((o) =>
          o.setName("type")
            .setDescription("宝箱の種類")
            .setRequired(true)
            .addChoices(
              { name: "🎁 新入り宝箱", value: "shinniri" },
              { name: "🎁 本船員宝箱", value: "honsennin" },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("add-time")
        .setDescription("【救済】指定ユーザーの本日の酒場VC時間を手動で加算します（管理者専用）")
        .addUserOption((opt) =>
          opt.setName("user").setDescription("対象ユーザー").setRequired(true),
        )
        .addIntegerOption((opt) =>
          opt.setName("minutes").setDescription("加算する分数").setRequired(true).setMinValue(1).setMaxValue(1440),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("rescue-yesterday")
        .setDescription("【救済】昨日(JST)酒場にいたメンバーを自動検出し、本日分の時間を付与します（管理者専用）"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("set-channels")
        .setDescription("【管理者専用】酒場VCとして認識するチャンネル名を設定します（コード変更不要）")
        .addStringOption((opt) =>
          opt
            .setName("names")
            .setDescription("チャンネル名をカンマ区切りで指定。空欄でデフォルト（大酒場🍺, 小酒場🍺）に戻す")
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("set-log")
        .setDescription("【管理者専用】宝箱開封ログを投稿するチャンネルを設定します")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("ログ投稿先チャンネル（省略するとログ無効化）")
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("add-bonus")
        .setDescription("【管理者専用】指定ユーザーの宝箱を引ける回数を追加・減算します")
        .addUserOption((opt) =>
          opt.setName("user").setDescription("対象ユーザー").setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("type")
            .setDescription("宝箱の種類")
            .setRequired(true)
            .addChoices(
              { name: "🎁 新入り宝箱", value: "shinniri" },
              { name: "🎁 本船員宝箱", value: "honsennin" },
            ),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("count")
            .setDescription("追加回数（マイナスで減算、合計は0未満にならない）")
            .setRequired(true),
        ),
    ) as SlashCommandBuilder,
  async execute(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: "❌ 管理者のみ使用できます。", ephemeral: true });
      return;
    }
    const sub = interaction.options.getSubcommand();
    if (sub === "set") {
      const type = (interaction.options.getString("type", true) ?? "shinniri") as "shinniri" | "honsennin";
      const panel = buildChestPanelMessage(type);
      await (interaction.channel as import("discord.js").TextChannel)?.send(panel);
      const label = type === "honsennin" ? "本船員宝箱" : "新入り宝箱";
      await interaction.reply({ content: `✅ **${label}** パネルを設置しました。`, ephemeral: true });
    } else if (sub === "add-time") {
      const targetUser = interaction.options.getUser("user", true);
      const minutes = interaction.options.getInteger("minutes", true);
      const seconds = minutes * 60;
      if (!interaction.guildId) {
        await interaction.reply({ content: "❌ サーバー内でのみ使用できます。", ephemeral: true });
        return;
      }
      await addChestVcSeconds(interaction.guildId, targetUser.id, seconds);
      await interaction.reply({
        content: `✅ <@${targetUser.id}> の本日の酒場VC時間に **${minutes}分** を追加しました。`,
        ephemeral: true,
      });
    } else if (sub === "rescue-yesterday") {
      if (!interaction.guildId || !interaction.guild) {
        await interaction.reply({ content: "❌ サーバー内でのみ使用できます。", ephemeral: true });
        return;
      }
      await interaction.deferReply({ ephemeral: true });

      // 酒場チャンネル名を取得（DB設定があればそれを、なければデフォルトを使用）
      const tavernNames = await getTavernChannelNames(interaction.guildId);
      await interaction.guild.channels.fetch();
      const tavernChannels = interaction.guild.channels.cache.filter(
        (ch) => tavernNames.has(ch.name) && (ch.type === 2 /* GuildVoice */ || ch.type === 13 /* GuildStageVoice */),
      );
      if (tavernChannels.size === 0) {
        const nameList = [...tavernNames].map((n) => `「${n}」`).join("・");
        await interaction.editReply(`❌ ${nameList} という名前のVCが見つかりませんでした。`);
        return;
      }

      // 昨日（JST）の範囲を UTC で計算
      const nowJstMs = Date.now() + 9 * 3600 * 1000;
      const jstMidnightTodayMs = Math.floor(nowJstMs / 86_400_000) * 86_400_000;
      const rangeEnd   = new Date(jstMidnightTodayMs - 9 * 3600 * 1000);   // 今日 0:00 JST を UTC に変換
      const rangeStart = new Date(rangeEnd.getTime()  - 86_400_000);        // 昨日 0:00 JST

      // vc_session_logs から昨日の酒場セッションを集計（両チャンネル合算）
      const tavernIds = [...tavernChannels.values()].map((ch) => ch.id);
      const rows = await db
        .select({
          userId:       vcSessionLogsTable.userId,
          totalSeconds: drizzleSql<number>`sum(${vcSessionLogsTable.durationSeconds})::int`,
        })
        .from(vcSessionLogsTable)
        .where(
          and(
            eq(vcSessionLogsTable.guildId, interaction.guildId),
            inArray(vcSessionLogsTable.channelId, tavernIds),
            gte(vcSessionLogsTable.joinedAt, rangeStart),
            lt(vcSessionLogsTable.joinedAt,  rangeEnd),
          ),
        )
        .groupBy(vcSessionLogsTable.userId);

      if (rows.length === 0) {
        const channelLabel = [...tavernNames].join("・");
        await interaction.editReply(
          `⚠️ 昨日（JST）の ${channelLabel} のセッションログが見つかりませんでした。\n` +
          `（該当チャンネルがVCログカテゴリに設定されていない場合、セッションは記録されません。\`/宝箱 add-time\` で手動補填してください）`,
        );
        return;
      }

      // 今日分として addChestVcSeconds を付与
      await Promise.all(
        rows.map(({ userId, totalSeconds }) =>
          addChestVcSeconds(interaction.guildId!, userId, totalSeconds ?? 0),
        ),
      );

      const channelLabel = [...tavernNames].join("・");
      const lines = rows.map(({ userId, totalSeconds }) => {
        const min = Math.floor((totalSeconds ?? 0) / 60);
        return `<@${userId}> — ${min}分`;
      });
      await interaction.editReply(
        `✅ **${rows.length}名** に昨日の${channelLabel}のVC時間を本日分として付与しました。\n\n${lines.join("\n")}`,
      );
    } else if (sub === "set-log") {
      if (!interaction.guildId) {
        await interaction.reply({ content: "❌ サーバー内でのみ使用できます。", ephemeral: true });
        return;
      }
      const ch = interaction.options.getChannel("channel", false);
      await setChestLogChannelId(interaction.guildId, ch?.id ?? null);
      if (ch) {
        await interaction.reply({ content: `✅ 宝箱ログチャンネルを <#${ch.id}> に設定しました。`, ephemeral: true });
      } else {
        await interaction.reply({ content: "✅ 宝箱ログを無効化しました。", ephemeral: true });
      }
    } else if (sub === "add-bonus") {
      if (!interaction.guildId) {
        await interaction.reply({ content: "❌ サーバー内でのみ使用できます。", ephemeral: true });
        return;
      }
      const targetUser = interaction.options.getUser("user", true);
      const chestType = interaction.options.getString("type", true) as "shinniri" | "honsennin";
      const count = interaction.options.getInteger("count", true);
      if (targetUser.bot) {
        await interaction.reply({ content: "❌ Botには付与できません。", ephemeral: true });
        return;
      }
      const newTotal = await addChestBonusOpens(interaction.guildId, targetUser.id, chestType, count);
      const chestLabel = chestType === "honsennin" ? "本船員宝箱" : "新入り宝箱";
      const verb = count >= 0 ? `+${count}回 追加` : `${count}回 減算`;
      await interaction.reply({
        content: `✅ <@${targetUser.id}> の **${chestLabel}** ボーナス開封回数を ${verb} しました。\n残り: **${newTotal}回**`,
        ephemeral: true,
      });
    } else if (sub === "set-channels") {
      if (!interaction.guildId) {
        await interaction.reply({ content: "❌ サーバー内でのみ使用できます。", ephemeral: true });
        return;
      }
      const rawNames = interaction.options.getString("names", false);
      if (!rawNames || rawNames.trim() === "") {
        // リセット：DB値を null にしてデフォルトに戻す
        await setChestTavernChannelNames(interaction.guildId, null);
        const defaults = [...TAVERN_CHANNEL_NAMES].join("、");
        await interaction.reply({
          content: `✅ 酒場チャンネル名をデフォルト（${defaults}）にリセットしました。`,
          ephemeral: true,
        });
      } else {
        const names = rawNames.split(",").map((s) => s.trim()).filter(Boolean);
        if (names.length === 0) {
          await interaction.reply({ content: "❌ 有効なチャンネル名を1つ以上入力してください。", ephemeral: true });
          return;
        }
        await setChestTavernChannelNames(interaction.guildId, names);
        await interaction.reply({
          content: `✅ 酒場チャンネル名を **${names.join("、")}** に更新しました。\nVCトラッカー・救済コマンドともに即時反映されます。`,
          ephemeral: true,
        });
      }
    }
  },
};

// ─── /引き落とし ─────────────────────────────────────────────────────────────

const debitCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("引き落とし")
    .setDescription("指定ユーザーの残高を引き落とす（管理者専用）")
    .setDefaultMemberPermissions(0)
    .addUserOption((opt) =>
      opt.setName("対象").setDescription("引き落とし対象のユーザー").setRequired(true),
    )
    .addIntegerOption((opt) =>
      opt.setName("金額").setDescription("引き落とす金額").setRequired(true).setMinValue(1),
    )
    .addStringOption((opt) =>
      opt.setName("理由").setDescription("引き落とし理由（任意）").setRequired(false),
    ),

  async execute(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: "このコマンドはサーバー内でのみ使用できます。", ephemeral: true });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: "このコマンドはサーバー管理者のみ使用できます。", ephemeral: true });
      return;
    }

    const target = interaction.options.getUser("対象", true);
    const amount = interaction.options.getInteger("金額", true);
    const reason = interaction.options.getString("理由") ?? "admin-debit";

    if (target.bot) {
      await interaction.reply({ content: "Botを対象にはできません。", ephemeral: true });
      return;
    }

    const settings = await getGuildSettings(interaction.guildId);
    const result = await giveCurrency(interaction.guildId, target.id, -amount, settings.currencyName, reason);

    if (!result.ok) {
      await interaction.reply({ content: `❌ ${result.reason}`, ephemeral: true });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle("💸 引き落とし完了")
      .setColor(0xe74c3c)
      .setDescription(
        `<@${target.id}> から **${amount.toLocaleString()}${settings.currencyName}** を引き落としました。\n残高: **${result.balance.toLocaleString()}${settings.currencyName}**`,
      )
      .addFields(
        { name: "理由", value: reason, inline: true },
        { name: "実行者", value: `<@${interaction.user.id}>`, inline: true },
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  },
};

const monthlyDebitCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("月額引き落とし")
    .setDescription("指定ロールのメンバーから毎月25日に引き落とす設定（管理者専用）")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("毎月の引き落とし対象ロールと金額を設定")
        .addRoleOption((opt) => opt.setName("role").setDescription("対象ロール").setRequired(true))
        .addIntegerOption((opt) =>
          opt.setName("amount").setDescription("毎月引き落とす金額").setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((sub) => sub.setName("remove").setDescription("毎月の引き落とし設定を解除"))
    .addSubcommand((sub) => sub.setName("list").setDescription("毎月の引き落とし設定を表示")),

  async execute(interaction) {
    const guildId = requireGuild(interaction);
    if (!requireManageGuild(interaction)) {
      await interaction.reply({ content: "このコマンドはサーバー管理者のみ使用できます。", ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();
    if (sub === "remove") {
      await clearMonthlyRoleDebit(guildId);
      await interaction.reply("毎月のロール引き落とし設定を解除しました。");
      return;
    }

    const settings = await getGuildSettings(guildId);
    if (sub === "list") {
      if (!settings.monthlyDebitRoleId || !settings.monthlyDebitAmount) {
        await interaction.reply("毎月のロール引き落としは設定されていません。");
        return;
      }
      await interaction.reply({
        content: `## 月額引き落とし設定\n対象: <@&${settings.monthlyDebitRoleId}>\n金額: **${settings.monthlyDebitAmount.toLocaleString()}${settings.currencyName}**\n実行日: **毎月25日 00:00（日本時間）**`,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const role = interaction.options.getRole("role", true);
    const amount = interaction.options.getInteger("amount", true);
    await setMonthlyRoleDebit(guildId, role.id, amount);
    await interaction.reply(
      `<@&${role.id}> の月額引き落としを **${amount.toLocaleString()}${settings.currencyName}** に設定しました。毎月25日00:00（日本時間）に実行します。`,
    );
  },
};

const timedRoleCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("期間限定ロール")
    .setDescription("指定ロールを持つメンバーから指定期間後にロールを外します（管理者専用）")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName("付与")
        .setDescription("現在のロール保持者を指定期間後に自動解除します")
        .addRoleOption((opt) =>
          opt.setName("ロール").setDescription("期間限定にするロール").setRequired(true),
        )
        .addIntegerOption((opt) =>
          opt.setName("期間").setDescription("付与期間").setRequired(true).setMinValue(1).setMaxValue(8760),
        )
        .addStringOption((opt) =>
          opt
            .setName("単位")
            .setDescription("期間の単位")
            .setRequired(true)
            .addChoices(
              { name: "時間", value: "hours" },
              { name: "日", value: "days" },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("解除")
        .setDescription("指定ロールの自動解除予約を取り消します")
        .addRoleOption((opt) =>
          opt.setName("ロール").setDescription("予約を取り消すロール").setRequired(true),
        ),
    ),

  async execute(interaction) {
    const guildId = requireGuild(interaction);
    if (!requireManageGuild(interaction)) {
      await interaction.reply({ content: "このコマンドはサーバー管理者のみ使用できます。", ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();
    const role = interaction.options.getRole("ロール", true);
    if (role.id === interaction.guild!.roles.everyone.id) {
      await interaction.reply({ content: "Everyoneロールは対象にできません。", ephemeral: true });
      return;
    }

    if (sub === "解除") {
      try {
        await deleteTimedRoleConfigAndGrants(guildId, role.id);
        await interaction.reply(`✅ <@&${role.id}> の自動解除設定と未実行の予約を取り消しました。`);
      } catch (err) {
        logger.error(`[timed-role] Failed to cancel role expiry guild=${guildId} role=${role.id}`, err);
        await interaction.reply({ content: "❌ 自動解除予約の取り消しに失敗しました。", ephemeral: true });
      }
      return;
    }

    const duration = interaction.options.getInteger("期間", true);
    const unit = interaction.options.getString("単位", true);
    const durationSeconds = duration * (unit === "days" ? 24 * 60 * 60 : 60 * 60);
    const configuredAt = new Date();
    const expiresAt = new Date(configuredAt.getTime() + durationSeconds * 1000);

    try {
      await upsertTimedRoleConfig(guildId, role.id, durationSeconds);
      const members = await interaction.guild!.members.fetch();
      const holders = members.filter((member) => !member.user.bot && member.roles.cache.has(role.id));
      await Promise.all(
        [...holders.values()].map((member) =>
          upsertTimedRoleGrant(
            guildId,
            member.id,
            role.id,
            ADMIN_TIMED_ROLE_EFFECT,
            expiresAt,
          ),
        ),
      );
      const expiresTs = Math.floor(expiresAt.getTime() / 1000);
      await interaction.reply(
        `✅ <@&${role.id}> の自動解除期間を設定しました。\n`
        + `現在の保持者 **${holders.size}人**の期限: <t:${expiresTs}:F>（<t:${expiresTs}:R>）\n`
        + "今後このロールが付与されたメンバーは、付与時点から同じ期間後に自動解除されます。",
      );
    } catch (err) {
      logger.error(`[timed-role] Failed to schedule role expiry guild=${guildId} role=${role.id}`, err);
      await interaction.reply({ content: "❌ 期限付きロールの設定に失敗しました。", ephemeral: true });
    }
  },
};

const balanceRankingCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("残高ランキング")
    .setDescription("全メンバーの残高をランキング表示します（管理者専用）")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async execute(interaction) {
    const guildId = requireGuild(interaction);
    await interaction.deferReply({ ephemeral: true });

    // 現在のギルドメンバー一覧を取得（脱退者除外に使用）
    const members = await interaction.guild!.members.fetch();
    const memberIds = new Set(members.keys());

    const [wallets, settings] = await Promise.all([
      getLeaderboard(guildId, undefined),
      getGuildSettings(guildId),
    ]);

    // サーバー在籍中のメンバーのみに絞り込み
    const activeWallets = wallets.filter((w) => memberIds.has(w.userId));

    if (activeWallets.length === 0) {
      await interaction.editReply("まだ残高データがありません。");
      return;
    }

    const lines = activeWallets.map(
      (w, i) => `**${i + 1}位** <@${w.userId}> — ${w.balance.toLocaleString()}${settings.currencyName}`,
    );

    const header = `## 💰 残高ランキング（${activeWallets.length}人）`;
    const chunks: string[] = [];
    let current = header;
    for (const line of lines) {
      if (current.length + line.length + 1 > DISCORD_MESSAGE_LIMIT) {
        chunks.push(current);
        current = line;
      } else {
        current += `\n${line}`;
      }
    }
    chunks.push(current);

    await interaction.editReply({ content: chunks[0], allowedMentions: { parse: [] } });
    for (const chunk of chunks.slice(1)) {
      await interaction.followUp({ content: chunk, allowedMentions: { parse: [] }, ephemeral: true });
    }
  },
};

export const commands: Command[] = [
  interviewCommand,
  balanceCommand,
  payCommand,
  giveCommand,
  leaderboardCommand,
  shopCommand,
  rewardCommand,
  vcCommand,
  shiftCommand,
  vcsalaryCommand,
  vclogCommand,
  slotCommand,
  blackjackCommand,
  highlowCommand,
  pokerCommand,
  rouletteCommand,
  baccaratCommand,
  chinchiroCommand,
  chinchiroDiceCommand,
  casinoCommand,
  bannotifyCommand,
  evalsheetCommand,
  rolePanelCommand,
  guideCommand,
  leavelogCommand,

  stickyCommand,
  adviceEndCommand,
  adviceLogCommand,
  clearCommand,
  chestCommand,
  debitCommand,
  monthlyDebitCommand,
  timedRoleCommand,
  balanceRankingCommand,
  calendarCommand,
];
