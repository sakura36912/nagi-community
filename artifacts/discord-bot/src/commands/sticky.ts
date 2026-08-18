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
import { stickyProcessingChannels } from "../lib/stickyLock";

export const stickyCommand = {
  data: new SlashCommandBuilder()
    .setName("sticky")
    .setDescription("チャンネルの最下部に常に表示されるメッセージを管理します（管理者）")
    .setDefaultMemberPermissions(0)
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

      // Fetch the channel object first so we can delete/post
      const textChannel = interaction.guild.channels.cache.get(channel.id)
        ?? await interaction.guild.channels.fetch(channel.id).catch(() => null);

      // ロックを取得して MessageCreate ハンドラとの競合を防ぐ
      // （古いスティッキー削除→DB更新→新スティッキー投稿→ID更新 の間に
      //  ユーザーメッセージが割り込んで孤立スティッキーを作るのを防止）
      const channelKey = `${guildId}:${channel.id}`;
      // 他の処理がロックを持っている場合は最大2秒待つ
      const deadline = Date.now() + 2000;
      while (stickyProcessingChannels.has(channelKey) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      stickyProcessingChannels.add(channelKey);

      try {
        // Grab the existing sticky before overwriting so we can delete the old post
        const existing = await getStickyMessage(guildId, channel.id);
        if (existing?.lastMessageId && textChannel?.isTextBased()) {
          await textChannel.messages.delete(existing.lastMessageId).catch(() => null);
        }

        // 直近200件（2ページ×100件）をスキャンして孤立スティッキーを除去。
        // MessageCreate ハンドラと同じ範囲にそろえることで、50件圏外に
        // 押し出された孤立スティッキーを /sticky set 実行時にも確実に消す。
        if (textChannel?.isTextBased()) {
          try {
            const batch1 = await textChannel.messages.fetch({ limit: 100 });
            const orphans1 = batch1.filter(
              (m) => m.author.bot && (m.content === existing?.content || m.content === content),
            );
            if (orphans1.size > 0) await Promise.allSettled(orphans1.map((m) => m.delete()));

            const lastId = batch1.last()?.id;
            if (lastId) {
              const batch2 = await textChannel.messages.fetch({ limit: 100, before: lastId });
              const orphans2 = batch2.filter(
                (m) => m.author.bot && (m.content === existing?.content || m.content === content),
              );
              if (orphans2.size > 0) await Promise.allSettled(orphans2.map((m) => m.delete()));
            }
          } catch { /* non-fatal */ }
        }

        // Save to DB (resets lastMessageId to null)
        await setStickyMessage(guildId, channel.id, content);

        // Post the new sticky at the bottom and record its ID
        if (textChannel?.isTextBased()) {
          try {
            const { updateStickyLastMessageId } = await import("../lib/sticky");
            const msg = await textChannel.send({ content, allowedMentions: { parse: [] } });
            await updateStickyLastMessageId(guildId, channel.id, msg.id);
          } catch (err) {
            logger.warn(`[sticky] Failed to post initial sticky in ${channel.id}`, err);
          }
        }
      } finally {
        stickyProcessingChannels.delete(channelKey);
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
