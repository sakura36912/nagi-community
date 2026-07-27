import {
  EmbedBuilder,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import {
  getPointBalance,
  getRecentTransactions,
} from "../lib/points";

interface Command {
  data: SlashCommandBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

const TYPE_LABELS: Record<string, string> = {
  vc_time:      "🎙️ VC滞在",
  role_tenure:  "🎭 ロール保持",
  boost:        "🚀 サーバーブースト",
  event_result: "🏆 イベント結果",
  bounty_post:  "💰 懸賞金掲載",
  bounty_award: "🎁 懸賞金受取",
  bounty_refund:"↩️ 懸賞金返金",
  manual:       "✏️ 手動",
};

export const pointCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("point")
    .setDescription("ポイントを確認する")
    .addSubcommand((sub) =>
      sub.setName("balance").setDescription("自分のポイント残高を確認する"),
    )
    .addSubcommand((sub) =>
      sub.setName("history").setDescription("最近のポイント履歴を確認する（最大10件）"),
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: "サーバー内でのみ使用できます。", ephemeral: true });
      return;
    }
    const guildId = interaction.guildId;
    const userId  = interaction.user.id;
    const sub     = interaction.options.getSubcommand();

    await interaction.deferReply({ ephemeral: true });

    if (sub === "balance") {
      const balance = await getPointBalance(guildId, userId);
      const embed = new EmbedBuilder()
        .setTitle("💎 ポイント残高")
        .setColor(0x5865f2)
        .setDescription(`<@${userId}> の現在の残高\n\n## ${balance.toLocaleString("ja-JP")} pt`)
        .setFooter({ text: "懸賞金の掲載・入札にポイントを使えます" });
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === "history") {
      const txs = await getRecentTransactions(guildId, userId, 10);
      const embed = new EmbedBuilder()
        .setTitle("📋 ポイント履歴")
        .setColor(0x5865f2);

      if (txs.length === 0) {
        embed.setDescription("まだ取引がありません。");
      } else {
        const balance = await getPointBalance(guildId, userId);
        embed.setDescription(`現在の残高: **${balance.toLocaleString("ja-JP")} pt**`);
        embed.addFields(
          txs.map((tx) => ({
            name: `${TYPE_LABELS[tx.type] ?? tx.type}　${tx.amount > 0 ? `+${tx.amount}` : tx.amount} pt`,
            value: `${tx.note ?? "—"}　<t:${Math.floor(tx.createdAt.getTime() / 1000)}:R>`,
            inline: false,
          })),
        );
      }
      await interaction.editReply({ embeds: [embed] });
    }
  },
};
