import { sheetCommand, applySheetEmbedUpdate, buildSheetEmbed, buildSheetThreadName, findSelfIntro, refreshSheetEmbedForUser } from "./sheet";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  SlashCommandSubcommandGroupBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type ModalSubmitInteraction,
} from "discord.js";
import type { ShopItem } from "@workspace/db";
import type { Guild } from "discord.js";
import { logger } from "../lib/logger";
import {
  DEFAULT_DAILY_AMOUNT,
  NICKNAME_CHANGE_EFFECT,
  PRIVATE_VC_EFFECT,
  PRIVATE_VC_1D_EFFECT,
  PRIVATE_VC_1W_EFFECT,
  PRIVATE_VC_1M_EFFECT,
  VC_RENAME_EFFECT,
  TIMED_VC_DURATIONS,
  EVAL_EXTEND_DAYS,
  PERM_ROLE_EFFECT,
  EVAL_RESURFACE_EFFECT,
  SHOP_LICENSE_EFFECT,
  extendCommunitySheet,
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
  setUraCategoryId,
  setUraChannelId,
  buyItem,
  claimDaily,
  createOrUpdateCurrency,
  createPrivateVcSession,
  getActivePrivateVcSession,
  extendPrivateVcSession,
  depositToTreasury,
  getTreasuriesByRoles,
  getTreasuryHistory,
  giveToCrunchTreasury,
  updateShopItemPrice,
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
  setupSquadTreasury,
  setRewardDayOfMonth,
  setRewardInterval,
  setRoleReward,
  transfer,
  withdrawFromTreasury,
} from "../lib/economy";

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
export const NICKNAME_MODAL_PREFIX = "shop:nickname-modal:";
const NICKNAME_MODAL_INPUT_ID = "nickname";
export const VC_RENAME_MODAL_PREFIX = "shop:vc-rename-modal:";
const VC_RENAME_MODAL_INPUT_ID = "vc-new-name";
// Discord caps action rows at 5, each holding up to 5 buttons.
const MAX_SHOP_BUY_BUTTONS = 25;

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
): Promise<{ ok: true; item: ShopItem; channelId: string; expiresAt?: Date } | { ok: false; reason: string }> {
  const me = guild.members.me;
  if (!me?.permissions.has("ManageChannels")) {
    return { ok: false, reason: "BotにManageChannels権限がないため、VCを作成できません。" };
  }

  const result = await buyItem(guild.id, member.id, itemId, currencyName);
  if (!result.ok) return result;

  try {
    const expiresAt = durationMs !== undefined ? new Date(Date.now() + durationMs) : undefined;
    const label = durationMs !== undefined
      ? (durationMs <= 24 * 60 * 60 * 1000 ? "1日" : durationMs <= 7 * 24 * 60 * 60 * 1000 ? "1週間" : "1ヶ月")
      : "";
    const channelName = label ? `🔒 ${member.displayName}(${label})` : `🔒 ${member.displayName}`;

    // Resolve the category from cache or fetch it so discord.js can set parent_id correctly.
    const parentCategory = vcCategoryId
      ? (guild.channels.cache.get(vcCategoryId) ?? await guild.channels.fetch(vcCategoryId).catch(() => null))
      : null;
    logger.info(`[privateVC] category=${vcCategoryId ?? "none"} resolved=${parentCategory?.id ?? "null"}`);

    const channel = await guild.channels.create({
      name: channelName.slice(0, 100),
      type: ChannelType.GuildVoice,
      userLimit: 2,
      ...(parentCategory ? { parent: parentCategory.id } : {}),
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: member.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.Connect,
            PermissionFlagsBits.Speak,
          ],
        },
      ],
    });

    if (expiresAt) {
      await createPrivateVcSession(guild.id, member.id, channel.id, expiresAt, "vc");
    }

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

/**
 * 裏フリールーム専用: 既存セッションがあれば期間延長、なければ新規作成。
 * Returns the same shape as purchaseAndCreatePrivateVc, plus an `extended` flag.
 */
/** Grant ViewChannel on the ura access channel. Non-throwing. */
async function grantUraChannelAccess(guild: Guild, userId: string, uraChannelId: string): Promise<void> {
  try {
    const ch = guild.channels.cache.get(uraChannelId)
      ?? await guild.channels.fetch(uraChannelId).catch(() => null);
    if (!ch || !("permissionOverwrites" in ch)) return;
    await ch.permissionOverwrites.edit(userId, { ViewChannel: true });
    logger.info(`[ura] Granted ViewChannel on ${uraChannelId} to user ${userId}`);
  } catch (err) {
    logger.error(`[ura] Failed to grant channel access to ${userId}`, err);
  }
}

/**
 * 裏フリールーム専用: 既存セッションがあれば期間延長、なければ新規作成。
 * Returns the same shape as purchaseAndCreatePrivateVc, plus an `extended` flag.
 */
async function purchaseExtendOrCreateUraVc(
  guild: Guild,
  member: GuildMember,
  itemId: number,
  currencyName: string,
  durationMs: number,
  vcCategoryId?: string | null,
  uraChannelId?: string | null,
): Promise<
  | { ok: true; item: ShopItem; channelId: string; expiresAt: Date; extended: boolean }
  | { ok: false; reason: string }
> {
  // Check for an existing active session for this user.
  const existingSession = await getActivePrivateVcSession(guild.id, member.id);

  if (!existingSession) {
    // No session → create a new VC, record with category="ura".
    const me = guild.members.me;
    if (!me?.permissions.has("ManageChannels")) {
      return { ok: false, reason: "BotにManageChannels権限がないため、VCを作成できません。" };
    }
    const result = await buyItem(guild.id, member.id, itemId, currencyName);
    if (!result.ok) return result;

    try {
      const expiresAt = new Date(Date.now() + durationMs);
      const label =
        durationMs <= 24 * 60 * 60 * 1000 ? "1日" :
        durationMs <= 7 * 24 * 60 * 60 * 1000 ? "1週間" : "1ヶ月";
      const channelName = `🔒 ${member.displayName}(${label})`;

      const parentCategory = vcCategoryId
        ? (guild.channels.cache.get(vcCategoryId) ?? await guild.channels.fetch(vcCategoryId).catch(() => null))
        : null;

      const channel = await guild.channels.create({
        name: channelName.slice(0, 100),
        type: ChannelType.GuildVoice,
        userLimit: 2,
        ...(parentCategory ? { parent: parentCategory.id } : {}),
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] },
        ],
      });

      await createPrivateVcSession(guild.id, member.id, channel.id, expiresAt, "ura");

      // Grant access to the ura text channel.
      if (uraChannelId) await grantUraChannelAccess(guild, member.id, uraChannelId);

      return { ok: true, item: result.item, channelId: channel.id, expiresAt, extended: false };
    } catch (err) {
      try { await refundPurchase(guild.id, member.id, result.item); } catch { /* best-effort */ }
      logger.error("[ura] Failed to create VC", err);
      return { ok: false, reason: "VCの作成に失敗したため、購入を取り消し、返金しました。" };
    }
  }

  // Session exists → extend it.
  const buyResult = await buyItem(guild.id, member.id, itemId, currencyName);
  if (!buyResult.ok) return buyResult;

  try {
    const updated = await extendPrivateVcSession(existingSession.id, durationMs);

    // Rename the channel to reflect the new expiry period (non-fatal).
    try {
      const label =
        durationMs <= 24 * 60 * 60 * 1000 ? "1日" :
        durationMs <= 7 * 24 * 60 * 60 * 1000 ? "1週間" : "1ヶ月";
      const ch = guild.channels.cache.get(existingSession.channelId)
        ?? await guild.channels.fetch(existingSession.channelId).catch(() => null);
      if (ch && ch.type === ChannelType.GuildVoice) {
        await ch.setName(`🔒 ${member.displayName}(${label})`.slice(0, 100));
      }
    } catch { /* non-fatal */ }

    // Re-grant channel access in case it was somehow revoked.
    if (uraChannelId) await grantUraChannelAccess(guild, member.id, uraChannelId);

    return { ok: true, item: buyResult.item, channelId: existingSession.channelId, expiresAt: updated.expiresAt, extended: true };
  } catch (err) {
    await refundPurchase(guild.id, member.id, buyResult.item);
    logger.error("[ura] Failed to extend session", err);
    return { ok: false, reason: "期間の延長に失敗したため、購入を取り消し、返金しました。" };
  }
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
      .map((i) => `**#${i.id} ${i.name}** — ${i.price}${currencyName}${i.description ? `\n${i.description}` : ""}`)
      .join("\n\n"),
  );

  const buyable = items.slice(0, MAX_SHOP_BUY_BUTTONS);
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buyable.length; i += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      buyable.slice(i, i + 5).map((item) =>
        new ButtonBuilder()
          .setCustomId(`${SHOP_BUY_PREFIX}${item.id}`)
          .setLabel(`購入: ${item.name}`.slice(0, 80))
          .setStyle(ButtonStyle.Primary),
      ),
    );
    rows.push(row);
  }

  return { embeds: [embed], components: rows };
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
    const vcCatId = item.category === "ura" ? settings.uraCategoryId : settings.vcCategoryId;
    const isUra = item.category === "ura" && vcDuration !== undefined;
    const result = isUra
      ? await purchaseExtendOrCreateUraVc(interaction.guild!, member, itemId, settings.currencyName, vcDuration!, vcCatId, settings.uraChannelId)
      : await purchaseAndCreatePrivateVc(interaction.guild!, member, itemId, settings.currencyName, vcDuration, vcCatId);
    if (result.ok) {
      const ts = result.expiresAt ? Math.floor(result.expiresAt.getTime() / 1000) : null;
      const expiry = ts ? `\n期限: <t:${ts}:F>（<t:${ts}:R>に自動削除）` : "";
      const action = "extended" in result && result.extended ? "期間を延長しました！" : "購入しました!";
      await interaction.editReply(`**${result.item.name}**を${action} あなた専用の非公開VC: <#${result.channelId}>${expiry}`);
    } else {
      await interaction.editReply(result.reason);
    }
    return;
  }

  // Eval-sheet extension券: buy first, then extend the community eval sheet.
  const extendDays = EVAL_EXTEND_DAYS[item.effectType ?? ""];
  if (extendDays !== undefined) {
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
    try {
      const member = await interaction.guild!.members.fetch(interaction.user.id);
      await member.roles.add(item.targetRoleId);
      await interaction.editReply(`✅ **${result.item.name}**を購入しました！ロール <@&${item.targetRoleId}> が付与されました。`);
    } catch {
      await refundPurchase(interaction.guildId, interaction.user.id, result.item);
      await interaction.editReply("❌ ロールの付与に失敗しました。購入を取り消し、返金しました。");
    }
    return;
  }

  // 評価落ち浮上券
  if (item.effectType === EVAL_RESURFACE_EFFECT) {
    const result = await buyItem(interaction.guildId, interaction.user.id, itemId, settings.currencyName);
    if (!result.ok) { await interaction.editReply(result.reason); return; }
    const sheetSettings = await getEvalSheetSettings(interaction.guildId);
    if (!sheetSettings?.forumChannelId) {
      await refundPurchase(interaction.guildId, interaction.user.id, result.item);
      await interaction.editReply("❌ 評価フォーラムが設定されていません。購入を取り消し、返金しました。");
      return;
    }
    const forum = interaction.guild!.channels.cache.get(sheetSettings.forumChannelId)
      ?? await interaction.guild!.channels.fetch(sheetSettings.forumChannelId).catch(() => null);
    if (!forum || forum.type !== ChannelType.GuildForum) {
      await refundPurchase(interaction.guildId, interaction.user.id, result.item);
      await interaction.editReply("❌ 評価フォーラムが見つかりません。購入を取り消し、返金しました。");
      return;
    }
    try {
      const evalDays = sheetSettings.evalPeriodDays ?? 14;
      const startDate = new Date();
      const endDate = new Date(startDate.getTime() + evalDays * 24 * 60 * 60 * 1000);
      const targetUser = await interaction.client.users.fetch(interaction.user.id);
      const member = await interaction.guild!.members.fetch(interaction.user.id);
      const displayName = member.displayName;
      const [vcSeconds, selfIntro] = await Promise.all([
        getSheetVcSeconds(interaction.guildId, interaction.user.id, startDate, endDate).catch(() => 0),
        findSelfIntro(interaction.guild!, interaction.user.id).catch(() => null),
      ]);
      const embed = buildSheetEmbed({ targetUser, displayName, startDate, endDate, vcSeconds, nameboardUrl: sheetSettings.nameboardUrl, selfIntro, createdByLabel: "評価落ち浮上券で再開" });
      const thread = await forum.threads.create({ name: buildSheetThreadName(displayName, endDate), message: { embeds: [embed] } });
      await createEvalSheet(interaction.guildId, interaction.user.id, startDate, endDate, forum.id, thread.id);
      const ts = Math.floor(endDate.getTime() / 1000);
      await interaction.editReply(`✅ **${result.item.name}**を使用しました！評価シートが新規作成されました。期限: **<t:${ts}:D>**`);
    } catch {
      await refundPurchase(interaction.guildId, interaction.user.id, result.item);
      await interaction.editReply("❌ 評価シートの作成に失敗しました。購入を取り消し、返金しました。");
    }
    return;
  }

  // 個人ショップ開業券
  if (item.effectType === SHOP_LICENSE_EFFECT) {
    const result = await buyItem(interaction.guildId, interaction.user.id, itemId, settings.currencyName);
    if (!result.ok) { await interaction.editReply(result.reason); return; }
    try {
      const member = await interaction.guild!.members.fetch(interaction.user.id);
      const userRoleIds = [...member.roles.cache.keys()];
      const config = await getShopLicenseForUser(interaction.guildId, userRoleIds);
      if (!config) {
        await refundPurchase(interaction.guildId, interaction.user.id, result.item);
        await interaction.editReply("❌ あなたの隊ロールに対応するショップ開業設定が見つかりません。購入を取り消し、返金しました。");
        return;
      }
      await member.roles.add(config.licenseRoleId);
      await interaction.editReply(`✅ **${result.item.name}**を購入しました！ショップ開業ロール <@&${config.licenseRoleId}> が付与されました。`);
      tryRecordGroupSale(interaction.guild!, interaction.guildId, interaction.user.id, result.item).catch(() => {});
    } catch {
      await refundPurchase(interaction.guildId, interaction.user.id, result.item);
      await interaction.editReply("❌ ロールの付与に失敗しました。購入を取り消し、返金しました。");
    }
    return;
  }

  const result = await buyItem(interaction.guildId, interaction.user.id, itemId, settings.currencyName);

  if (result.ok) {
    await interaction.editReply(`**${result.item.name}**を購入しました!`);
    if (item.category === "group") tryRecordGroupSale(interaction.guild!, interaction.guildId, interaction.user.id, result.item).catch(() => {});
  } else {
    await interaction.editReply(result.reason);
  }
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
    await interaction.editReply("❌ あなたの非公開VCが見つかりません。先にVCを作成してください。");
    return;
  }

  // Charge before renaming.
  const result = await buyItem(interaction.guild.id, userId, itemId, settings.currencyName);
  if (!result.ok) {
    await interaction.editReply(result.reason);
    return;
  }

  try {
    await privateVc.setName(`🔒 ${newName}`.slice(0, 100));
    await interaction.editReply(`✅ **${result.item.name}**を使用しました！VCを「🔒 ${newName}」にリネームしました。`);
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

const currencyCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("currency")
    .setDescription("このサーバー専用の通貨を設定します")
    .addSubcommand((sub) =>
      sub
        .setName("create")
        .setDescription("通貨を作成・設定します(管理者用)")
        .addStringOption((opt) =>
          opt.setName("name").setDescription("通貨の名前(例: コイン)").setRequired(true).setMaxLength(20),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("daily_amount")
            .setDescription(`/daily で受け取れる額(デフォルト: ${DEFAULT_DAILY_AMOUNT})`)
            .setRequired(false)
            .setMinValue(1),
        ),
    )
    .addSubcommand((sub) => sub.setName("info").setDescription("現在の通貨設定を表示します")),
  async execute(interaction) {
    const guildId = requireGuild(interaction);
    const sub = interaction.options.getSubcommand();

    if (sub === "create") {
      if (!requireManageGuild(interaction)) {
        await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
        return;
      }
      const name = interaction.options.getString("name", true).trim();
      if (name.length === 0) {
        await interaction.reply({ content: "通貨名を入力してください。", ephemeral: true });
        return;
      }
      const dailyAmount = interaction.options.getInteger("daily_amount") ?? undefined;
      const settings = await createOrUpdateCurrency(guildId, name, dailyAmount);
      await interaction.reply(
        `このサーバーの通貨を **${settings.currencyName}** に設定しました。\`/daily\` で1日あたり **${settings.dailyAmount}${settings.currencyName}** 受け取れます。`,
      );
      return;
    }

    if (sub === "info") {
      const settings = await getGuildSettings(guildId);
      await interaction.reply(
        `現在の通貨: **${settings.currencyName}**\nデイリーボーナス: **${settings.dailyAmount}${settings.currencyName}**`,
      );
      return;
    }
  },
};

const balanceCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("balance")
    .setDescription("自分または指定したユーザーの残高を表示します")
    .addUserOption((opt) =>
      opt.setName("user").setDescription("確認したいユーザー").setRequired(false),
    ),
  async execute(interaction) {
    const guildId = requireGuild(interaction);
    const target = interaction.options.getUser("user") ?? interaction.user;

    if (target.id !== interaction.user.id && !requireManageGuild(interaction)) {
      await interaction.reply({ content: "他のユーザーの残高を確認できるのは管理者のみです。", ephemeral: true });
      return;
    }

    const [wallet, settings] = await Promise.all([
      getOrCreateWallet(guildId, target.id),
      getGuildSettings(guildId),
    ]);
    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setAuthor({ name: target.displayName ?? target.username, iconURL: target.displayAvatarURL() })
      .setDescription(`残高: **${wallet.balance.toLocaleString()}${settings.currencyName}**`);
    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};

const dailyCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("daily")
    .setDescription("毎日受け取れる通貨を受け取ります"),
  async execute(interaction) {
    const guildId = requireGuild(interaction);
    const settings = await getGuildSettings(guildId);
    const result = await claimDaily(guildId, interaction.user.id, settings.dailyAmount);
    if (result.ok) {
      await interaction.reply(
        `${settings.dailyAmount}${settings.currencyName}を受け取りました!現在の残高: **${result.balance}${settings.currencyName}**`,
      );
    } else {
      await interaction.reply({
        content: `まだ受け取れません。次回まであと ${formatMs(result.msRemaining)} です。`,
        ephemeral: true,
      });
    }
  },
};

const payCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("pay")
    .setDescription("他のユーザーに送金します")
    .addUserOption((opt) =>
      opt.setName("user").setDescription("送金先のユーザー").setRequired(true),
    )
    .addIntegerOption((opt) =>
      opt.setName("amount").setDescription("送金額").setRequired(true).setMinValue(1),
    )
    .addStringOption((opt) =>
      opt.setName("memo").setDescription("メモ（任意、最大100文字）").setRequired(false).setMaxLength(100),
    ),
  async execute(interaction) {
    const guildId = requireGuild(interaction);
    const target = interaction.options.getUser("user", true);
    const amount = interaction.options.getInteger("amount", true);
    const memo   = interaction.options.getString("memo");

    if (target.bot) {
      await interaction.reply({ content: "Botには送金できません。", ephemeral: true });
      return;
    }

    const settings = await getGuildSettings(guildId);
    const result = await transfer(guildId, interaction.user.id, target.id, amount, settings.currencyName);
    if (result.ok) {
      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setAuthor({ name: interaction.user.displayName ?? interaction.user.username, iconURL: interaction.user.displayAvatarURL() })
        .setThumbnail(interaction.user.displayAvatarURL())
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
    .setDescription("ユーザーに通貨を付与します(管理者用)")
    .addUserOption((opt) =>
      opt.setName("user").setDescription("付与先のユーザー").setRequired(true),
    )
    .addIntegerOption((opt) =>
      opt.setName("amount").setDescription("付与額(マイナスで没収)").setRequired(true),
    ),
  async execute(interaction) {
    const guildId = requireGuild(interaction);

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

    const settings = await getGuildSettings(guildId);
    const result = await giveCurrency(guildId, target.id, amount, settings.currencyName);
    if (result.ok) {
      const verb = amount >= 0 ? "付与" : "没収";
      const embed = new EmbedBuilder()
        .setColor(amount >= 0 ? 0x2ecc71 : 0xe74c3c)
        .setAuthor({ name: target.displayName ?? target.username, iconURL: target.displayAvatarURL() })
        .setDescription(`${verb}: **${Math.abs(amount).toLocaleString()}${settings.currencyName}**\n残高: **${result.balance.toLocaleString()}${settings.currencyName}**`);
      await interaction.reply({ embeds: [embed] });
    } else {
      await interaction.reply({ content: result.reason, ephemeral: true });
    }
  },
};

const DISCORD_MESSAGE_LIMIT = 2000;

const leaderboardCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("サーバー内の資産ランキングを表示します")
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
      (w, i) => `**${i + 1}位** <@${w.userId}> — ${w.balance}${settings.currencyName}`,
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
// Shop command factory — creates an independent /shop-style command scoped to
// a single `category` in the shopItemsTable. All shops share the same button
// and modal handlers (items are identified by ID, not category).
// ---------------------------------------------------------------------------

type EffectChoice = { name: string; value: string };

const DEFAULT_EFFECT_CHOICES: EffectChoice[] = [
  { name: "ニックネーム変更権", value: NICKNAME_CHANGE_EFFECT },
  { name: "非公開VC作成(無期限)", value: PRIVATE_VC_EFFECT },
  { name: "永久ロール付与", value: PERM_ROLE_EFFECT },
  { name: "評価落ち浮上券", value: EVAL_RESURFACE_EFFECT },
  { name: "個人ショップ開業券", value: SHOP_LICENSE_EFFECT },
];

const VC_EFFECT_CHOICES: EffectChoice[] = [
  { name: "非公開VC作成(無期限)", value: PRIVATE_VC_EFFECT },
  { name: "非公開VC（1日）", value: PRIVATE_VC_1D_EFFECT },
  { name: "非公開VC（1週間）", value: PRIVATE_VC_1W_EFFECT },
  { name: "非公開VC（1ヶ月）", value: PRIVATE_VC_1M_EFFECT },
  { name: "VCリネーム", value: VC_RENAME_EFFECT },
];

// ─────────────────────────────────────────────────────────────
// Unified /shop command  (subcommand-group per category)
// Usage: /shop <general|group|vc|ura> <list|buy|add|…>
// ─────────────────────────────────────────────────────────────
interface ShopGroupConfig {
  displayName: string;
  emoji: string;
  category: string;
  color: number;
  effectChoices: EffectChoice[];
  licenseSetup?: boolean;
  vcCategorySetup?: boolean;
  uraCategorySetup?: boolean;
  uraChannelSetup?: boolean;
}

const SHOP_GROUPS: Record<string, ShopGroupConfig> = {
  general: { displayName: "ショップ",               emoji: "🛒", category: "general", color: 0xf5a623, effectChoices: DEFAULT_EFFECT_CHOICES },
  group:   { displayName: "隊別ショップ",           emoji: "⚔️", category: "group",   color: 0xe74c3c, effectChoices: DEFAULT_EFFECT_CHOICES, licenseSetup: true },
  vc:      { displayName: "非公開VCショップ",       emoji: "🔒", category: "vc",      color: 0x3498db, effectChoices: VC_EFFECT_CHOICES,     vcCategorySetup: true },
  ura:     { displayName: "裏フリールームショップ", emoji: "🌙", category: "ura",     color: 0x9b59b6, effectChoices: VC_EFFECT_CHOICES,     uraCategorySetup: true, uraChannelSetup: true },
};

function buildShopGroup(groupName: string, cfg: ShopGroupConfig): SlashCommandSubcommandGroupBuilder {
  const g = new SlashCommandSubcommandGroupBuilder()
    .setName(groupName)
    .setDescription(cfg.displayName)
    .addSubcommand((sub) => sub.setName("list").setDescription(`${cfg.displayName}の購入可能アイテム一覧を表示します`))
    .addSubcommand((sub) =>
      sub
        .setName("buy")
        .setDescription("アイテムを購入します")
        .addIntegerOption((opt) =>
          opt.setName("item_id").setDescription(`アイテムID(/shop ${groupName} list で確認)`).setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName("inventory").setDescription("自分の所持アイテムを表示します"))
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription(`${cfg.displayName}にアイテムを追加します(管理者用)`)
        .addStringOption((opt) => opt.setName("name").setDescription("アイテム名").setRequired(true))
        .addIntegerOption((opt) => opt.setName("price").setDescription("価格").setRequired(true).setMinValue(1))
        .addStringOption((opt) => opt.setName("description").setDescription("説明").setRequired(false))
        .addStringOption((opt) =>
          opt.setName("effect").setDescription("購入時の特殊効果").setRequired(false).addChoices(...cfg.effectChoices),
        )
        .addRoleOption((opt) =>
          opt.setName("role").setDescription("付与するロール（永久ロール付与エフェクト使用時）").setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("price")
        .setDescription("アイテムの価格を変更します(管理者用)")
        .addIntegerOption((opt) => opt.setName("item_id").setDescription("アイテムID").setRequired(true))
        .addIntegerOption((opt) => opt.setName("price").setDescription("新しい価格").setRequired(true).setMinValue(1)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription(`${cfg.displayName}からアイテムを削除します(管理者用)`)
        .addIntegerOption((opt) => opt.setName("item_id").setDescription("アイテムID").setRequired(true)),
    );

  if (cfg.vcCategorySetup) {
    g.addSubcommand((sub) =>
      sub
        .setName("vc-category")
        .setDescription("非公開VCを作成するカテゴリを設定します(管理者用)")
        .addChannelOption((opt) =>
          opt.setName("channel").setDescription("カテゴリチャンネルを選択").addChannelTypes(ChannelType.GuildCategory).setRequired(true),
        ),
    );
  }
  if (cfg.uraCategorySetup) {
    g.addSubcommand((sub) =>
      sub
        .setName("ura-category")
        .setDescription("裏フリールームVCを作成するカテゴリを設定します(管理者用)")
        .addChannelOption((opt) =>
          opt.setName("channel").setDescription("カテゴリチャンネルを選択").addChannelTypes(ChannelType.GuildCategory).setRequired(true),
        ),
    );
  }
  if (cfg.uraChannelSetup) {
    g.addSubcommand((sub) =>
      sub
        .setName("ura-channel")
        .setDescription("裏フリールーム購入者にアクセス権を付与するチャンネルを設定します(管理者用)")
        .addChannelOption((opt) =>
          opt.setName("channel").setDescription("テキスト・ボイスチャンネルを選択").setRequired(true),
        ),
    );
  }
  if (cfg.licenseSetup) {
    g
      .addSubcommand((sub) =>
        sub
          .setName("license-setup")
          .setDescription("隊ロール→ショップ開業ロールのマッピングを設定します(管理者用)")
          .addRoleOption((opt) => opt.setName("squad_role").setDescription("隊ロール").setRequired(true))
          .addRoleOption((opt) => opt.setName("shop_role").setDescription("付与するショップ開業ロール").setRequired(true)),
      )
      .addSubcommand((sub) => sub.setName("license-list").setDescription("現在の隊→開業ロールのマッピング一覧を表示します(管理者用)"))
      .addSubcommand((sub) => sub.setName("sales").setDescription("隊ごとの売上を表示します"));
  }

  return g;
}

const shopCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("shop")
    .setDescription("ショップを操作します")
    .addSubcommandGroup(buildShopGroup("general", SHOP_GROUPS.general))
    .addSubcommandGroup(buildShopGroup("group",   SHOP_GROUPS.group))
    .addSubcommandGroup(buildShopGroup("vc",      SHOP_GROUPS.vc))
    .addSubcommandGroup(buildShopGroup("ura",     SHOP_GROUPS.ura)),

  async execute(interaction) {
    const guildId = requireGuild(interaction);
    const groupName = interaction.options.getSubcommandGroup(true);
    const sub = interaction.options.getSubcommand();
    const cfg = SHOP_GROUPS[groupName];
    const { displayName, emoji, category, color } = cfg;
    const panelTitle = `${emoji} ${displayName}`;

      if (sub === "list") {
        const [items, settings] = await Promise.all([
          listShopItems(guildId, category),
          getGuildSettings(guildId),
        ]);
        const panel = buildShopPanel(items, settings.currencyName, panelTitle, color);
        await interaction.reply(panel);
        return;
      }

      if (sub === "buy") {
        const itemId = interaction.options.getInteger("item_id", true);
        const item = await getShopItem(guildId, itemId);
        if (!item) {
          await interaction.reply({ content: "そのアイテムは見つかりませんでした。", ephemeral: true });
          return;
        }
        // Guard: prevent buying items from a different shop via this command
        if (item.category !== category) {
          await interaction.reply({ content: "そのアイテムはこのショップでは購入できません。", ephemeral: true });
          return;
        }

        if (item.effectType === NICKNAME_CHANGE_EFFECT) {
          await interaction.showModal(buildNicknameModal(item.id));
          return;
        }
        if (item.effectType === VC_RENAME_EFFECT) {
          await interaction.showModal(buildVcRenameModal(item.id));
          return;
        }

        await interaction.deferReply({ ephemeral: true });
        const settings = await getGuildSettings(guildId);

        const vcDuration = TIMED_VC_DURATIONS[item.effectType ?? ""];
        if (item.effectType === PRIVATE_VC_EFFECT || vcDuration !== undefined) {
          const member = await interaction.guild!.members.fetch(interaction.user.id);
          const vcCatId = item.category === "ura" ? settings.uraCategoryId : settings.vcCategoryId;
          const isUra = item.category === "ura" && vcDuration !== undefined;
          const result = isUra
            ? await purchaseExtendOrCreateUraVc(interaction.guild!, member, itemId, settings.currencyName, vcDuration!, vcCatId, settings.uraChannelId)
            : await purchaseAndCreatePrivateVc(interaction.guild!, member, itemId, settings.currencyName, vcDuration, vcCatId);
          if (result.ok) {
            const ts = result.expiresAt ? Math.floor(result.expiresAt.getTime() / 1000) : null;
            const expiry = ts ? `\n期限: <t:${ts}:F>（<t:${ts}:R>に自動削除）` : "";
            const action = "extended" in result && result.extended ? "期間を延長しました！" : "購入しました!";
            await interaction.editReply(`**${result.item.name}**を${action} あなた専用の非公開VC: <#${result.channelId}>${expiry}`);
          } else {
            await interaction.editReply(result.reason);
          }
          return;
        }

        // Eval-sheet extension券
        const extendDays = EVAL_EXTEND_DAYS[item.effectType ?? ""];
        if (extendDays !== undefined) {
          const result = await buyItem(guildId, interaction.user.id, itemId, settings.currencyName);
          if (!result.ok) { await interaction.editReply(result.reason); return; }
          const extended = await extendCommunitySheet(guildId, interaction.user.id, extendDays);
          if (extended) {
            const ts = Math.floor(extended.newEndDate.getTime() / 1000);
            await interaction.editReply(
              `✅ **${result.item.name}**を購入しました！\n評価シートの期限を **<t:${ts}:D>** まで延長しました。`,
            );
            applySheetEmbedUpdate(interaction.client, guildId, extended).catch((err) => logger.error("[sheet] applySheetEmbedUpdate error", err));
          } else {
            await refundPurchase(guildId, interaction.user.id, result.item);
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
          const result = await buyItem(guildId, interaction.user.id, itemId, settings.currencyName);
          if (!result.ok) { await interaction.editReply(result.reason); return; }
          try {
            const member = await interaction.guild!.members.fetch(interaction.user.id);
            await member.roles.add(item.targetRoleId);
            await interaction.editReply(`✅ **${result.item.name}**を購入しました！ロール <@&${item.targetRoleId}> が付与されました。`);
          } catch {
            await refundPurchase(guildId, interaction.user.id, result.item);
            await interaction.editReply("❌ ロールの付与に失敗しました。購入を取り消し、返金しました。");
          }
          return;
        }

        // 評価落ち浮上券
        if (item.effectType === EVAL_RESURFACE_EFFECT) {
          const result = await buyItem(guildId, interaction.user.id, itemId, settings.currencyName);
          if (!result.ok) { await interaction.editReply(result.reason); return; }
          const sheetSettings = await getEvalSheetSettings(guildId);
          if (!sheetSettings?.forumChannelId) {
            await refundPurchase(guildId, interaction.user.id, result.item);
            await interaction.editReply("❌ 評価フォーラムが設定されていません。購入を取り消し、返金しました。");
            return;
          }
          const forum = interaction.guild!.channels.cache.get(sheetSettings.forumChannelId)
            ?? await interaction.guild!.channels.fetch(sheetSettings.forumChannelId).catch(() => null);
          if (!forum || forum.type !== ChannelType.GuildForum) {
            await refundPurchase(guildId, interaction.user.id, result.item);
            await interaction.editReply("❌ 評価フォーラムが見つかりません。購入を取り消し、返金しました。");
            return;
          }
          try {
            const evalDays = sheetSettings.evalPeriodDays ?? 14;
            const startDate = new Date();
            const endDate = new Date(startDate.getTime() + evalDays * 24 * 60 * 60 * 1000);
            const targetUser = await interaction.client.users.fetch(interaction.user.id);
            const member = await interaction.guild!.members.fetch(interaction.user.id);
            const displayName = member.displayName;
            const [vcSeconds, selfIntro] = await Promise.all([
              getSheetVcSeconds(guildId, interaction.user.id, startDate, endDate).catch(() => 0),
              findSelfIntro(interaction.guild!, interaction.user.id).catch(() => null),
            ]);
            const embed = buildSheetEmbed({ targetUser, displayName, startDate, endDate, vcSeconds, nameboardUrl: sheetSettings.nameboardUrl, selfIntro, createdByLabel: "評価落ち浮上券で再開" });
            const thread = await forum.threads.create({ name: buildSheetThreadName(displayName, endDate), message: { embeds: [embed] } });
            await createEvalSheet(guildId, interaction.user.id, startDate, endDate, forum.id, thread.id);
            const ts = Math.floor(endDate.getTime() / 1000);
            await interaction.editReply(`✅ **${result.item.name}**を使用しました！評価シートが新規作成されました。期限: **<t:${ts}:D>**`);
          } catch {
            await refundPurchase(guildId, interaction.user.id, result.item);
            await interaction.editReply("❌ 評価シートの作成に失敗しました。購入を取り消し、返金しました。");
          }
          return;
        }

        // 個人ショップ開業券
        if (item.effectType === SHOP_LICENSE_EFFECT) {
          const result = await buyItem(guildId, interaction.user.id, itemId, settings.currencyName);
          if (!result.ok) { await interaction.editReply(result.reason); return; }
          try {
            const member = await interaction.guild!.members.fetch(interaction.user.id);
            const userRoleIds = [...member.roles.cache.keys()];
            const config = await getShopLicenseForUser(guildId, userRoleIds);
            if (!config) {
              await refundPurchase(guildId, interaction.user.id, result.item);
              await interaction.editReply("❌ あなたの隊ロールに対応するショップ開業設定が見つかりません。購入を取り消し、返金しました。");
              return;
            }
            await member.roles.add(config.licenseRoleId);
            await interaction.editReply(`✅ **${result.item.name}**を購入しました！ショップ開業ロール <@&${config.licenseRoleId}> が付与されました。`);
            tryRecordGroupSale(interaction.guild!, guildId, interaction.user.id, result.item).catch(() => {});
          } catch {
            await refundPurchase(guildId, interaction.user.id, result.item);
            await interaction.editReply("❌ ロールの付与に失敗しました。購入を取り消し、返金しました。");
          }
          return;
        }

        const result = await buyItem(guildId, interaction.user.id, itemId, settings.currencyName);
        if (result.ok) {
          await interaction.editReply(`**${result.item.name}**を購入しました!`);
          if (category === "group") tryRecordGroupSale(interaction.guild!, guildId, interaction.user.id, result.item).catch(() => {});
        } else {
          await interaction.editReply(result.reason);
        }
        return;
      }

      if (sub === "inventory") {
        const items = await listInventory(guildId, interaction.user.id);
        if (items.length === 0) {
          await interaction.reply({ content: "所持アイテムはありません。", ephemeral: true });
          return;
        }
        const lines = items.map((row) => `**${row.item.name}** x${row.quantity}`);
        await interaction.reply({ content: `## 🎒 所持アイテム\n${lines.join("\n")}`, ephemeral: true });
        return;
      }

      if (sub === "add") {
        if (!requireManageGuild(interaction)) {
          await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
          return;
        }
        const name = interaction.options.getString("name", true);
        const price = interaction.options.getInteger("price", true);
        const description = interaction.options.getString("description");
        const effect = interaction.options.getString("effect");
        const role = interaction.options.getRole("role");
        if (effect === PERM_ROLE_EFFECT && !role) {
          await interaction.reply({ content: "❌ 永久ロール付与には `role` オプションでロールを指定してください。", ephemeral: true });
          return;
        }
        const [item, settings] = await Promise.all([
          addShopItem(guildId, name, price, description, effect, category, role?.id ?? null),
          getGuildSettings(guildId),
        ]);
        await interaction.reply(
          `アイテム **#${item.id} ${item.name}**(${item.price}${settings.currencyName})を${displayName}に追加しました。`,
        );
        return;
      }

      if (sub === "price") {
        if (!requireManageGuild(interaction)) {
          await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
          return;
        }
        const itemId = interaction.options.getInteger("item_id", true);
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
          `**#${updated.id} ${updated.name}** の価格を **${newPrice}${settings.currencyName}** に変更しました。`,
        );
        return;
      }

      if (sub === "remove") {
        if (!requireManageGuild(interaction)) {
          await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
          return;
        }
        const itemId = interaction.options.getInteger("item_id", true);
        const removed = await removeShopItem(guildId, itemId);
        await interaction.reply(
          removed ? `アイテム#${itemId}を削除しました。` : "そのアイテムは見つかりませんでした。",
        );
        return;
      }

      if (sub === "vc-category" && cfg.vcCategorySetup) {
        if (!requireManageGuild(interaction)) {
          await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
          return;
        }
        const channel = interaction.options.getChannel("channel", true);
        const channelId = channel.id;
        logger.info(`[vc-category] guild=${guildId} channelId=${channelId}`);
        await setVcCategoryId(guildId, channelId);
        logger.info(`[vc-category] saved ok`);
        await interaction.reply(`✅ 非公開VCの作成先カテゴリを <#${channelId}> に設定しました。`);
        return;
      }

      if (sub === "ura-category" && cfg.uraCategorySetup) {
        if (!requireManageGuild(interaction)) {
          await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
          return;
        }
        const channel = interaction.options.getChannel("channel", true);
        const channelId = channel.id;
        await setUraCategoryId(guildId, channelId);
        await interaction.reply(`✅ 裏フリールームVCの作成先カテゴリを <#${channelId}> に設定しました。`);
        return;
      }

      if (sub === "ura-channel" && cfg.uraChannelSetup) {
        if (!requireManageGuild(interaction)) {
          await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
          return;
        }
        const channel = interaction.options.getChannel("channel", true);
        await setUraChannelId(guildId, channel.id);
        await interaction.reply(`✅ 裏フリールーム購入者のアクセス先チャンネルを <#${channel.id}> に設定しました。`);
        return;
      }

      if (sub === "sales" && cfg.licenseSetup) {
        const [summary, treasuries, settings] = await Promise.all([
          getGroupShopSalesSummary(guildId),
          listSquadTreasuries(guildId),
          getGuildSettings(guildId),
        ]);
        if (summary.length === 0) {
          await interaction.reply({ content: "まだ売上データがありません。", ephemeral: false });
          return;
        }
        const medals = ["🥇", "🥈", "🥉"];
        const lines = summary.map((row, i) => {
          const treasury = treasuries.find(t => t.roleId === row.squadRoleId);
          const name = treasury ? treasury.name : `<@&${row.squadRoleId}>`;
          const rank = medals[i] ?? `${i + 1}位`;
          return `${rank} **${name}**: ${row.totalAmount.toLocaleString()}${settings.currencyName}（${row.purchaseCount}件）`;
        });
        const total = summary.reduce((s, r) => s + r.totalAmount, 0);
        const totalCount = summary.reduce((s, r) => s + r.purchaseCount, 0);
        lines.push(`\n合計: **${total.toLocaleString()}${settings.currencyName}**（${totalCount}件）`);
        await interaction.reply({ content: `## ⚔️ 隊別売上\n${lines.join("\n")}` });
        return;
      }

      if (sub === "license-setup" && cfg.licenseSetup) {
        if (!requireManageGuild(interaction)) {
          await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
          return;
        }
        const squadRole = interaction.options.getRole("squad_role", true);
        const shopRole  = interaction.options.getRole("shop_role", true);
        await setShopLicenseConfig(guildId, squadRole.id, shopRole.id);
        await interaction.reply(
          `✅ 隊ロール <@&${squadRole.id}> → 開業ロール <@&${shopRole.id}> のマッピングを設定しました。`,
        );
        return;
      }

      if (sub === "license-list" && cfg.licenseSetup) {
        if (!requireManageGuild(interaction)) {
          await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
          return;
        }
        const configs = await listShopLicenseConfigs(guildId);
        if (configs.length === 0) {
          await interaction.reply({ content: "開業ロールの設定がまだありません。`/shop group license-setup` で設定してください。", ephemeral: true });
          return;
        }
        const lines = configs.map((c) => `<@&${c.squadRoleId}> → <@&${c.licenseRoleId}>`);
        await interaction.reply({ content: `## ⚔️ 隊別ショップ開業ロール設定\n${lines.join("\n")}`, ephemeral: true });
        return;
      }
    },
};

const rewardCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("reward")
    .setDescription("ロールごとの自動報酬を設定します(管理者用)")
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
        .setName("interval")
        .setDescription("自動報酬の配布間隔を設定します(分指定)")
        .addIntegerOption((opt) =>
          opt.setName("minutes").setDescription("配布間隔(分)").setRequired(true).setMinValue(1),
        ),
    )
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
      const lines = rewards.map((r) => `<@&${r.roleId}> — ${r.amount}${settings.currencyName}`);
      const scheduleLabel = settings.rewardDayOfMonth
        ? `毎月${settings.rewardDayOfMonth}日`
        : `${settings.rewardIntervalMinutes}分ごと`;
      await interaction.reply({
        content: `## ⏱️ 自動報酬設定(${scheduleLabel})\n${lines.join("\n")}`,
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
      const scheduleLabel = settings.rewardDayOfMonth
        ? `毎月${settings.rewardDayOfMonth}日`
        : `${settings.rewardIntervalMinutes}分ごと`;
      await interaction.reply(
        `<@&${reward.roleId}> の自動報酬を **${amount}${settings.currencyName}** に設定しました(配布: ${scheduleLabel})。`,
      );
      return;
    }

    if (sub === "interval") {
      const minutes = interaction.options.getInteger("minutes", true);
      const settings = await setRewardInterval(guildId, minutes);
      await interaction.reply(`自動報酬の配布間隔を **${settings.rewardIntervalMinutes}分ごと** に設定しました。`);
      return;
    }

    if (sub === "day") {
      const day = interaction.options.getInteger("day", true);
      const settings = await setRewardDayOfMonth(guildId, day);
      await interaction.reply(`給料日を **毎月${settings.rewardDayOfMonth}日** に設定しました。`);
      return;
    }
  },
};


// ─── /treasury ───────────────────────────────────────────────────────────────

const treasuryCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("treasury")
    .setDescription("隊の金庫を管理します")
    .addSubcommand((sub) =>
      sub
        .setName("setup")
        .setDescription("隊の金庫を作成・更新します（管理者）")
        .addRoleOption((opt) =>
          opt.setName("role").setDescription("隊員ロール").setRequired(true),
        )
        .addStringOption((opt) =>
          opt.setName("name").setDescription("金庫の表示名（例: 桜雅隊）").setRequired(true).setMaxLength(50),
        )
        .addRoleOption((opt) =>
          opt.setName("leader_role").setDescription("出金権限を持つ隊長ロール").setRequired(false),
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
    )
    .addSubcommand((sub) =>
      sub
        .setName("withdraw")
        .setDescription("金庫から自分のウォレットに出金します（隊長・管理者）")
        .addIntegerOption((opt) =>
          opt.setName("amount").setDescription("出金額").setRequired(true).setMinValue(1),
        )
        .addIntegerOption((opt) =>
          opt.setName("treasury_id").setDescription("金庫IDを指定").setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("balance")
        .setDescription("金庫の残高を確認します")
        .addIntegerOption((opt) =>
          opt.setName("treasury_id").setDescription("金庫IDを指定（省略時は自隊）").setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("give")
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
        .setName("history")
        .setDescription("金庫の入出金履歴を表示します")
        .addIntegerOption((opt) =>
          opt.setName("treasury_id").setDescription("金庫IDを指定（省略時は自隊）").setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("すべての隊金庫一覧を表示します"),
    ),

  async execute(interaction) {
    const guildId = requireGuild(interaction);
    const sub = interaction.options.getSubcommand();
    const settings = await getGuildSettings(guildId);
    const currencyName = settings?.currencyName ?? "円";

    const member = interaction.member as GuildMember | null;
    const isAdmin = !!member?.permissions.has("Administrator");

    // ── setup ────────────────────────────────────────────────────────────────
    if (sub === "setup") {
      if (!isAdmin) {
        await interaction.reply({ content: "このコマンドは管理者権限が必要です。", ephemeral: true });
        return;
      }
      const role       = interaction.options.getRole("role", true);
      const name       = interaction.options.getString("name", true);
      const leaderRole = interaction.options.getRole("leader_role");
      const treasury   = await setupSquadTreasury(guildId, role.id, name, leaderRole?.id ?? null);
      await interaction.reply({
        content: `✅ **${name}** の金庫を設定しました（ID: \`${treasury.id}\`）\n` +
          `隊員ロール: <@&${role.id}>` +
          (leaderRole ? `\n隊長ロール（出金権限）: <@&${leaderRole.id}>` : ""),
        allowedMentions: { parse: [] },
      });
      return;
    }

    // ── list ────────────────────────────────────────────────────────────────
    if (sub === "list") {
      const treasuries = await listSquadTreasuries(guildId);
      if (treasuries.length === 0) {
        await interaction.reply({ content: "金庫はまだ設定されていません。`/treasury setup` で作成してください。", ephemeral: true });
        return;
      }
      const embed = new EmbedBuilder()
        .setTitle("🏦 隊金庫一覧")
        .setColor(0xf5a623)
        .addFields(
          treasuries.map((t) => ({
            name: `[ID:${t.id}] ${t.name}`,
            value: [
              `隊員ロール: <@&${t.roleId}>`,
              t.leaderRoleId ? `隊長ロール: <@&${t.leaderRoleId}>` : null,
              `残高: **${t.balance.toLocaleString()}${currencyName}**`,
            ].filter(Boolean).join("\n"),
            inline: false,
          })),
        );
      await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
      return;
    }

    // ── resolve treasury for member-facing subcommands ────────────────────
    async function resolveTreasury(idOpt: number | null) {
      if (idOpt !== null) {
        const t = await getSquadTreasury(idOpt);
        if (!t || t.guildId !== guildId) return { treasury: null, error: "指定された金庫が見つかりません。" };
        return { treasury: t, error: null };
      }
      const memberRoleIds = member ? [...member.roles.cache.keys()] : [];
      const matches = await getTreasuriesByRoles(guildId, memberRoleIds);
      if (matches.length === 0) return { treasury: null, error: "所属している隊の金庫が見つかりません。" };
      if (matches.length > 1) {
        const ids = matches.map((t) => `[ID:${t.id}] ${t.name}`).join("\n");
        return { treasury: null, error: `複数の隊に所属しています。\`treasury_id\` を指定してください:\n${ids}` };
      }
      return { treasury: matches[0]!, error: null };
    }

    // ── balance ──────────────────────────────────────────────────────────────
    if (sub === "balance") {
      const { treasury, error } = await resolveTreasury(interaction.options.getInteger("treasury_id"));
      if (!treasury) { await interaction.reply({ content: error!, ephemeral: true }); return; }
      const embed = new EmbedBuilder()
        .setTitle(`🏦 ${treasury.name} — 残高`)
        .setColor(0xf5a623)
        .addFields(
          { name: "残高", value: `**${treasury.balance.toLocaleString()}${currencyName}**`, inline: true },
          { name: "隊員ロール", value: `<@&${treasury.roleId}>`, inline: true },
          ...(treasury.leaderRoleId ? [{ name: "隊長ロール", value: `<@&${treasury.leaderRoleId}>`, inline: true }] : []),
        );
      await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
      return;
    }

    // ── history ──────────────────────────────────────────────────────────────
    if (sub === "history") {
      const { treasury, error } = await resolveTreasury(interaction.options.getInteger("treasury_id"));
      if (!treasury) { await interaction.reply({ content: error!, ephemeral: true }); return; }
      const txs = await getTreasuryHistory(treasury.id, 10);
      const lines = txs.map((tx) => {
        const sign = tx.amount > 0 ? "+" : "";
        const ts = Math.floor(tx.createdAt.getTime() / 1000);
        return `<t:${ts}:d> <@${tx.userId}> ${sign}${tx.amount.toLocaleString()}${currencyName} (${tx.reason})`;
      });
      const embed = new EmbedBuilder()
        .setTitle(`🏦 ${treasury.name} — 履歴（直近${txs.length}件）`)
        .setColor(0xf5a623)
        .setDescription(lines.length > 0 ? lines.join("\n") : "履歴がありません。");
      await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
      return;
    }

    // ── deposit ──────────────────────────────────────────────────────────────
    if (sub === "deposit") {
      const amount = interaction.options.getInteger("amount", true);
      const { treasury, error } = await resolveTreasury(interaction.options.getInteger("treasury_id"));
      if (!treasury) { await interaction.reply({ content: error!, ephemeral: true }); return; }

      // Must be a squad member
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
            { name: "入金額", value: `**+${amount.toLocaleString()}${currencyName}**`, inline: true },
            { name: "金庫残高", value: `${result.treasuryBalance.toLocaleString()}${currencyName}`, inline: true },
            { name: "あなたの残高", value: `${result.walletBalance.toLocaleString()}${currencyName}`, inline: true },
          );
        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        await interaction.editReply(err instanceof Error ? err.message : "入金に失敗しました。");
      }
      return;
    }

    // ── withdraw ─────────────────────────────────────────────────────────────
    if (sub === "withdraw") {
      const amount = interaction.options.getInteger("amount", true);
      const { treasury, error } = await resolveTreasury(interaction.options.getInteger("treasury_id"));
      if (!treasury) { await interaction.reply({ content: error!, ephemeral: true }); return; }

      // Must be admin or hold the leader role
      const memberRoleIds = member ? [...member.roles.cache.keys()] : [];
      const isLeader = treasury.leaderRoleId ? memberRoleIds.includes(treasury.leaderRoleId) : false;
      if (!isAdmin && !isLeader) {
        const who = treasury.leaderRoleId ? ` または <@&${treasury.leaderRoleId}>` : "";
        await interaction.reply({
          content: `出金は管理者${who} のみ可能です。`,
          ephemeral: true,
          allowedMentions: { parse: [] },
        });
        return;
      }

      await interaction.deferReply();
      // Ensure wallet exists before withdraw
      await getOrCreateWallet(guildId, interaction.user.id);
      try {
        const result = await withdrawFromTreasury(guildId, treasury.id, interaction.user.id, amount);
        const embed = new EmbedBuilder()
          .setTitle(`🏦 ${treasury.name} — 出金完了`)
          .setColor(0xed4245)
          .addFields(
            { name: "出金額", value: `**-${amount.toLocaleString()}${currencyName}**`, inline: true },
            { name: "金庫残高", value: `${result.treasuryBalance.toLocaleString()}${currencyName}`, inline: true },
            { name: "あなたの残高", value: `${result.walletBalance.toLocaleString()}${currencyName}`, inline: true },
          );
        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        await interaction.editReply(err instanceof Error ? err.message : "出金に失敗しました。");
      }
      return;
    }

    // ── give ─────────────────────────────────────────────────────────────────
    if (sub === "give") {
      if (!isAdmin) {
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
        `✅ **${treasury.name}** に **${amount.toLocaleString()}${currencyName}** を付与しました。\n金庫残高: ${newBalance.toLocaleString()}${currencyName}`,
      );
      return;
    }
  },
};

import { vcCommand } from "./vc";
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
} from "./shift";
import { shiftCommand } from "./shift";
import { vcsalaryCommand } from "./vcsalary";
import { slotCommand } from "./slot";

export const commands: Command[] = [
  currencyCommand,
  balanceCommand,
  dailyCommand,
  payCommand,
  giveCommand,
  leaderboardCommand,
  shopCommand,
  rewardCommand,
  vcCommand,
  treasuryCommand,
  shiftCommand,
  vcsalaryCommand,
  slotCommand,
  sheetCommand,
];
