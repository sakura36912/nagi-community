import {
  ActionRowBuilder, ChannelType, PermissionFlagsBits, RoleSelectMenuBuilder,
  type ChatInputCommandInteraction, type RoleSelectMenuInteraction,
} from "discord.js";
import { getShopForumPanel, setShopForumPanelCastRoles } from "@workspace/db";
import { getForumCastRoleIds } from "../lib/forumCastPicker";
import { logger } from "../lib/logger";

export const FORUM_CAST_ROLES_PREFIX = "shop:forum-cast-roles:";
export function buildForumCastRoleConfig(itemId: number, actorId: string, defaultIds: string[]) {
  const select = new RoleSelectMenuBuilder()
    .setCustomId(`${FORUM_CAST_ROLES_PREFIX}${itemId}:${actorId}`)
    .setPlaceholder("キャスト対象ロールを複数選択（最大25）")
    .setMinValues(1).setMaxValues(25);
  if (defaultIds.length) select.setDefaultRoles(defaultIds.slice(0, 25));
  return [new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(select)];
}

export async function showForumCastRoleConfig(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: "サーバー管理権限が必要です。", ephemeral: true });
    return;
  }
  if (!interaction.channel?.isThread() || interaction.channel.parent?.type !== ChannelType.GuildForum) {
    await interaction.reply({ content: "対象のフォーラム投稿内で実行してください。", ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const panel = await getShopForumPanel(interaction.guild.id, interaction.channelId);
  if (!panel) {
    await interaction.editReply("先に /shop forum-panel で購入パネルを設定してください。");
    return;
  }
  const roles = await interaction.guild.roles.fetch();
  const defaults = getForumCastRoleIds(panel).filter((id) => roles.has(id));
  await interaction.editReply({
    content: "キャスト対象ロールを1～25個選択してください。選択すると保存されます。\nいずれかのロールを持つメンバーが候補になり、同じ人は重複表示しません。以前の設定は今回選んだロール一覧に置き換わります。",
    components: buildForumCastRoleConfig(panel.shopItemId, interaction.user.id, defaults),
    allowedMentions: { parse: [] },
  });
}

export async function handleForumCastRoleConfig(interaction: RoleSelectMenuInteraction): Promise<void> {
  const [itemText, actorId] = interaction.customId.slice(FORUM_CAST_ROLES_PREFIX.length).split(":");
  const itemId = Number(itemText);
  if (!interaction.guild || actorId !== interaction.user.id
    || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: "設定を開始した管理者本人のみ操作できます。", ephemeral: true });
    return;
  }
  await interaction.deferUpdate();
  try {
    if (!interaction.channel?.isThread() || interaction.channel.parent?.type !== ChannelType.GuildForum) {
      throw new Error("対象のフォーラム投稿内で操作してください。");
    }
    const ids = [...new Set(interaction.values)];
    if (!Number.isInteger(itemId) || itemId <= 0 || !ids.length || ids.length > 25 || ids.includes(interaction.guild.id)) {
      throw new Error("キャスト対象ロールを1～25個指定してください。@everyone は指定できません。");
    }
    const roles = await interaction.guild.roles.fetch();
    if (ids.some((id) => !roles.has(id))) throw new Error("削除されたロールが含まれています。ロールを選び直してください。");
    const panel = await setShopForumPanelCastRoles(interaction.guild.id, interaction.channelId, itemId, ids);
    if (!panel) throw new Error("この購入パネルは無効か、別の商品に変更されています。コマンドからやり直してください。");
    logger.info(`[forum-shop] Cast roles updated guild=${interaction.guild.id} channel=${interaction.channelId} actor=${interaction.user.id} roles=${ids.length}`);
    await interaction.editReply({
      content: `✅ キャスト対象ロールを${ids.length}個に設定しました。\n${ids.map((id) => `<@&${id}>`).join("、")}\nいずれかのロールを持つメンバーだけを表示します。`,
      components: [], allowedMentions: { parse: [] },
    });
  } catch (error) {
    logger.warn("[forum-shop] Cast role configuration failed", error);
    await interaction.editReply({
      content: error instanceof Error ? error.message : "キャストロールの設定に失敗しました。",
      components: [], allowedMentions: { parse: [] },
    });
  }
}
