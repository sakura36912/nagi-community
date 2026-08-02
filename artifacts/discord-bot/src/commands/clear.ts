import {
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { logger } from "../lib/logger";

export const clearCommand = {
  data: new SlashCommandBuilder()
    .setName("clear")
    .setDescription("チャンネルのメッセージを一括削除します（管理者）")
    .addIntegerOption((opt) =>
      opt
        .setName("count")
        .setDescription("削除するメッセージ数（1〜100）")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(100),
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild || !interaction.channel) {
      await interaction.reply({ content: "このコマンドはサーバー内でのみ使用できます。", ephemeral: true });
      return;
    }

    // ManageMessages 権限チェック
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member || !member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      await interaction.reply({ content: "❌ このコマンドはメッセージの管理権限が必要です。", ephemeral: true });
      return;
    }

    const count = interaction.options.getInteger("count", true);

    await interaction.deferReply({ ephemeral: true });

    try {
      const channel = interaction.channel;
      if (!channel.isTextBased() || channel.isDMBased()) {
        await interaction.editReply("❌ このチャンネルではメッセージを削除できません。");
        return;
      }

      // bulkDelete は 14 日以内のメッセージのみ対応
      const deleted = await channel.bulkDelete(count, true);

      logger.info(`[clear] ${interaction.user.tag} が #${channel.id} で ${deleted.size} 件削除`);

      await interaction.editReply(`✅ ${deleted.size} 件のメッセージを削除しました。`);
    } catch (err) {
      logger.error("[clear] 削除エラー:", err);
      await interaction.editReply("❌ メッセージの削除に失敗しました。Botにメッセージ管理権限があるか確認してください。");
    }
  },
};
