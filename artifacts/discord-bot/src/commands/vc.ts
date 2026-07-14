/**
 * /vc command — rename an existing VC, and manage scheduled auto-delete.
 *
 * Subcommands:
 *   rename <channel> <new-name>  — immediately rename a VC (no duration picker)
 *   list                         — show all scheduled VCs and their remaining time
 *   cancel <channel>             — remove the schedule (channel is NOT deleted)
 *
 * Required bot permission: ManageChannels
 */

import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { logger } from "../lib/logger";
import { deleteSchedule, listSchedules } from "../lib/vc";

function formatRelativeTime(ms: number): string {
  if (ms <= 0) return "期限切れ";
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  const hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  const mins = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}日`);
  if (hours > 0) parts.push(`${hours}時間`);
  if (mins > 0 || parts.length === 0) parts.push(`${mins}分`);
  return parts.join("");
}

export const vcCommand = {
  data: new SlashCommandBuilder()
    .setName("vc")
    .setDescription("VCのリネームと自動削除スケジュールを管理します")
    // Restrict to members who can manage channels; server admins can override.
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addSubcommand((sub) =>
      sub
        .setName("rename")
        .setDescription("VCを新しい名前にリネームし、期間終了後に自動削除します")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("リネームするVCチャンネル")
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("new-name")
            .setDescription("新しいチャンネル名")
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(100),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("list")
        .setDescription("スケジュール登録されているVCの一覧と残り時間を表示します"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("cancel")
        .setDescription("VCの自動削除スケジュールをキャンセルします（VCは削除されません）")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("キャンセルするVCチャンネル")
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(true),
        ),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: "このコマンドはサーバー内でのみ使用できます。", ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === "rename") {
      await handleRename(interaction);
    } else if (sub === "list") {
      await handleList(interaction);
    } else if (sub === "cancel") {
      await handleCancel(interaction);
    }
  },
};

async function handleRename(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = interaction.options.getChannel("channel", true);
  const newName = interaction.options.getString("new-name", true).trim();

  // Runtime permission check for the invoking member (defence-in-depth in addition
  // to setDefaultMemberPermissions, which Discord clients enforce on the UI side).
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.reply({
      content: "このコマンドを使用するには ManageChannels 権限が必要です。",
      ephemeral: true,
    });
    return;
  }

  // Verify bot has ManageChannels permission
  const me = interaction.guild?.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.reply({
      content: "BotにManageChannels権限がないため、VCをリネームできません。",
      ephemeral: true,
    });
    return;
  }

  // Rename immediately — no duration picker.
  const voiceChannel = interaction.guild?.channels.cache.get(channel.id)
    ?? await interaction.guild?.channels.fetch(channel.id).catch(() => null);

  if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
    await interaction.reply({ content: "対象のボイスチャンネルが見つかりませんでした。", ephemeral: true });
    return;
  }

  await voiceChannel.setName(newName);
  await interaction.reply({ content: `<#${channel.id}> を **${newName}** にリネームしました。`, ephemeral: true });
}

async function handleList(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const schedules = await listSchedules(interaction.guildId!);

  if (schedules.length === 0) {
    await interaction.editReply("現在スケジュール登録されているVCはありません。");
    return;
  }

  const now = Date.now();
  const embed = new EmbedBuilder()
    .setTitle("📋 VC自動削除スケジュール一覧")
    .setColor(0x5865f2)
    .setDescription(
      schedules
        .map((s) => {
          const remaining = s.expiresAt.getTime() - now;
          const ts = Math.floor(s.expiresAt.getTime() / 1000);
          return `• <#${s.channelId}> **${s.channelName}**\n　削除予定: <t:${ts}:F>（残り ${formatRelativeTime(remaining)}）`;
        })
        .join("\n\n"),
    );

  await interaction.editReply({ embeds: [embed] });
}

async function handleCancel(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = interaction.options.getChannel("channel", true);

  // Runtime permission check (defence-in-depth alongside setDefaultMemberPermissions).
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.reply({
      content: "このコマンドを使用するには ManageChannels 権限が必要です。",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const removed = await deleteSchedule(channel.id);
  if (removed) {
    logger.info(`[vc] Schedule cancelled for channel ${channel.id} by ${interaction.user.id}`);
    await interaction.editReply(`<#${channel.id}> の自動削除スケジュールをキャンセルしました。チャンネルは削除されません。`);
  } else {
    await interaction.editReply(`<#${channel.id}> にはスケジュールが登録されていません。`);
  }
}
