import { EmbedBuilder, PermissionFlagsBits, type ButtonInteraction, type StringSelectMenuInteraction } from "discord.js";
import type { ShopItem } from "@workspace/db";
import { buyItem, refundPurchase, getGuildSettings, PERM_ROLE_EFFECT } from "./economy";
import { logger } from "./logger";

export const KP_SHOP_CATEGORY = "kp";
export const KP_SHOP_NAME = "キミノヒトミニKPshop";

/** A separate shop for ordinary goods and permanent-role products. */
export function supportsKpEffect(effect: string | null | undefined): boolean {
  return !effect || effect === PERM_ROLE_EFFECT;
}

export async function purchaseKpItem(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  item: ShopItem,
): Promise<void> {
  if (!interaction.guild || !interaction.guildId) return;
  await interaction.deferReply({ ephemeral: true });
  if (item.category !== KP_SHOP_CATEGORY || !supportsKpEffect(item.effectType)) {
    await interaction.editReply("このショップでは通常商品と永久ロール付与商品のみ購入できます。");
    return;
  }
  if (item.effectType === PERM_ROLE_EFFECT && !item.targetRoleId) {
    await interaction.editReply("付与するロールが未設定です。管理者に連絡してください。");
    return;
  }
  // Use the interaction's source channel, not a shared guild-wide log setting.
  const channel = interaction.channel;
  if (!channel?.isTextBased() || !("send" in channel) || !("permissionsFor" in channel)) {
    await interaction.editReply("購入ログをこのチャンネルに投稿できないため、購入を中止しました。");
    return;
  }
  const me = interaction.guild.members.me;
  const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.EmbedLinks,
    channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages];
  if (!me || !channel.permissionsFor(me)?.has(required)) {
    await interaction.editReply("購入ログの表示に必要なチャンネル閲覧・送信・埋め込み権限がないため、購入を中止しました。");
    return;
  }
  const { currencyName } = await getGuildSettings(interaction.guildId);
  const result = await buyItem(interaction.guildId, interaction.user.id, item.id, currencyName);
  if (!result.ok) {
    await interaction.editReply(result.reason);
    return;
  }
  if (result.item.targetRoleId) {
    try {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      await member.roles.add(result.item.targetRoleId);
    } catch (error) {
      await refundPurchase(interaction.guildId, interaction.user.id, result.item);
      logger.warn("[kp-shop] Role grant failed; purchase refunded", error);
      await interaction.editReply("ロールの付与に失敗しました。購入を取り消し、返金しました。");
      return;
    }
  }
  let logged = true;
  try {
    await channel.send({
      embeds: [new EmbedBuilder()
        .setTitle(`${KP_SHOP_NAME} 購入ログ`)
        .setColor(0xf5a623)
        .addFields(
          { name: "購入者", value: `<@${interaction.user.id}>` },
          { name: "商品", value: result.item.name },
          { name: "個数", value: "1個", inline: true },
          { name: "購入金額", value: `${result.item.price.toLocaleString()}${currencyName}`, inline: true },
        )
        .setFooter({ text: `購入操作ID: ${interaction.id}` })
        .setTimestamp()],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    // A completed purchase must not be refunded merely because logging failed.
    logged = false;
    logger.warn("[kp-shop] Purchase completed but channel log failed", error);
  }
  await interaction.editReply(
    `✅ **${result.item.name}**を購入しました！${logged ? "" : "\n⚠️ 購入は完了しましたが、購入ログの投稿に失敗しました。管理者に連絡してください。"}`,
  );
}
