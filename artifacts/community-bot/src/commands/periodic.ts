import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import {
  addPeriodicMessage,
  listPeriodicMessages,
  removePeriodicMessage,
  togglePeriodicMessage,
} from "../lib/periodicMessages.js";

interface Command {
  data: { name: string; toJSON: () => unknown };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

export const periodicCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("periodic")
    .setDescription("定期メッセージの管理（管理者用）")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("定期メッセージを追加します")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("投稿先チャンネル")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("message")
            .setDescription("投稿するメッセージ内容")
            .setRequired(true),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("interval")
            .setDescription("投稿間隔（時間）。デフォルト: 24")
            .setMinValue(1)
            .setMaxValue(720)
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("定期メッセージを削除します")
        .addIntegerOption((opt) =>
          opt.setName("id").setDescription("削除するメッセージのID（/periodic list で確認）").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("toggle")
        .setDescription("定期メッセージの有効/無効を切り替えます")
        .addIntegerOption((opt) =>
          opt.setName("id").setDescription("切り替えるメッセージのID（/periodic list で確認）").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("このサーバーの定期メッセージ一覧を表示します"),
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: "サーバー内でのみ使用できます。", ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();

    // ── add ──────────────────────────────────────────────────────────────────
    if (sub === "add") {
      const channel = interaction.options.getChannel("channel", true);
      const message = interaction.options.getString("message", true);
      const intervalHours = interaction.options.getInteger("interval") ?? 24;

      const row = await addPeriodicMessage(interaction.guildId, channel.id, message, intervalHours);

      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle("✅ 定期メッセージを追加しました")
            .addFields(
              { name: "ID", value: String(row.id), inline: true },
              { name: "チャンネル", value: `<#${channel.id}>`, inline: true },
              { name: "間隔", value: `${intervalHours}時間ごと`, inline: true },
              { name: "メッセージ", value: message.slice(0, 1024) },
            )
            .setFooter({ text: "次の投稿は今すぐ（初回）または interval 時間後" })
            .setTimestamp(),
        ],
        ephemeral: true,
      });
      return;
    }

    // ── remove ────────────────────────────────────────────────────────────────
    if (sub === "remove") {
      const id = interaction.options.getInteger("id", true);
      const deleted = await removePeriodicMessage(interaction.guildId, id);
      if (!deleted) {
        await interaction.reply({ content: `❌ ID \`${id}\` が見つかりません。\`/periodic list\` でIDを確認してください。`, ephemeral: true });
        return;
      }
      await interaction.reply({ content: `✅ ID \`${id}\` の定期メッセージを削除しました。`, ephemeral: true });
      return;
    }

    // ── toggle ────────────────────────────────────────────────────────────────
    if (sub === "toggle") {
      const id = interaction.options.getInteger("id", true);
      const row = await togglePeriodicMessage(interaction.guildId, id);
      if (!row) {
        await interaction.reply({ content: `❌ ID \`${id}\` が見つかりません。\`/periodic list\` でIDを確認してください。`, ephemeral: true });
        return;
      }
      const state = row.enabled ? "✅ 有効" : "⏸ 無効";
      await interaction.reply({ content: `${state} にしました（ID: \`${id}\`）`, ephemeral: true });
      return;
    }

    // ── list ──────────────────────────────────────────────────────────────────
    if (sub === "list") {
      const rows = await listPeriodicMessages(interaction.guildId);
      if (rows.length === 0) {
        await interaction.reply({ content: "定期メッセージは登録されていません。`/periodic add` で追加できます。", ephemeral: true });
        return;
      }

      const lines = rows.map((r) => {
        const state = r.enabled ? "✅" : "⏸";
        const last = r.lastPostedAt
          ? `<t:${Math.floor(r.lastPostedAt.getTime() / 1000)}:R>`
          : "未投稿";
        const preview = r.message.length > 40 ? r.message.slice(0, 40) + "…" : r.message;
        return `${state} **ID: ${r.id}** | <#${r.channelId}> | ${r.intervalHours}h | 最終: ${last}\n　\`${preview}\``;
      });

      const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle(`📋 定期メッセージ一覧（${rows.length}件）`)
        .setDescription(lines.join("\n\n").slice(0, 4000))
        .setTimestamp();

      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
  },
};
