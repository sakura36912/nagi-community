import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { logger } from "../lib/logger";
import {
  getStickyMessage,
  listStickyMessages,
  removeStickyMessage,
  setStickyMessage,
} from "../lib/sticky";

export const stickyCommand = {
  data: new SlashCommandBuilder()
    .setName("sticky")
    .setDescription("チャンネルの最下部に常に表示されるメッセージを管理します（管理者）")
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("指定チャンネルにスティッキーメッセージを登録します")
        .addChannelOption((o) =>
          o
            .setName("channel")
            .setDescription("スティッキーメッセージを設定するチャンネル")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        )
        .addStringOption((o) =>
          o
            .setName("content")
            .setDescription("常に表示するメッセージ内容")
            .setRequired(true)
            .setMaxLength(2000),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("指定チャンネルのスティッキーメッセージを削除します")
        .addChannelOption((o) =>
          o
            .setName("channel")
            .setDescription("スティッキーメッセージを削除するチャンネル")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("このサーバーのスティッキーメッセージ一覧を表示します"),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) {
      await interaction.reply({ content: "このコマンドはサーバー内でのみ使用できます。", ephemeral: true });
      return;
    }

    const member = interaction.guild.members.cache.get(interaction.user.id)
      ?? await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
      return;
    }

    const guildId = interaction.guild.id;
    const sub = interaction.options.getSubcommand();

    // ── set ──────────────────────────────────────────────────────────────────
    if (sub === "set") {
      const channel = interaction.options.getChannel("channel", true);
      const content = interaction.options.getString("content", true);

      await interaction.deferReply({ ephemeral: true });

      // Save to DB
      await setStickyMessage(guildId, channel.id, content);

      // Fetch the text channel and post the sticky immediately
      const textChannel = interaction.guild.channels.cache.get(channel.id)
        ?? await interaction.guild.channels.fetch(channel.id).catch(() => null);

      if (textChannel?.isTextBased()) {
        try {
          const msg = await textChannel.send({ content, allowedMentions: { parse: [] } });
          const { updateStickyLastMessageId } = await import("../lib/sticky");
          await updateStickyLastMessageId(guildId, channel.id, msg.id);
        } catch (err) {
          logger.warn(`[sticky] Failed to post initial sticky in ${channel.id}`, err);
        }
      }

      await interaction.editReply(
        `✅ <#${channel.id}> にスティッキーメッセージを設定しました。新しいメッセージが投稿されるたびに最下部に再表示されます。`,
      );
      return;
    }

    // ── remove ───────────────────────────────────────────────────────────────
    if (sub === "remove") {
      const channel = interaction.options.getChannel("channel", true);

      await interaction.deferReply({ ephemeral: true });

      // Try to delete the last sticky message from Discord
      const existing = await getStickyMessage(guildId, channel.id);
      if (existing?.lastMessageId) {
        const textChannel = interaction.guild.channels.cache.get(channel.id)
          ?? await interaction.guild.channels.fetch(channel.id).catch(() => null);
        if (textChannel?.isTextBased()) {
          await textChannel.messages.delete(existing.lastMessageId).catch(() => null);
        }
      }

      const removed = await removeStickyMessage(guildId, channel.id);
      if (!removed) {
        await interaction.editReply(`❌ <#${channel.id}> にスティッキーメッセージは設定されていません。`);
        return;
      }

      await interaction.editReply(`✅ <#${channel.id}> のスティッキーメッセージを削除しました。`);
      return;
    }

    // ── list ─────────────────────────────────────────────────────────────────
    if (sub === "list") {
      await interaction.deferReply({ ephemeral: true });

      const rows = await listStickyMessages(guildId);
      if (rows.length === 0) {
        await interaction.editReply("このサーバーにはスティッキーメッセージが設定されていません。");
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle("📌 スティッキーメッセージ一覧")
        .setColor(0xf5a623)
        .setDescription(
          rows
            .map((r) => `<#${r.channelId}>\n> ${r.content.replace(/\n/g, "\n> ").slice(0, 100)}${r.content.length > 100 ? "…" : ""}`)
            .join("\n\n"),
        );

      await interaction.editReply({ embeds: [embed] });
      return;
    }
  },
};
