/**
 * /vc command — rename an existing VC with a scheduled auto-delete.
 *
 * Subcommands:
 *   rename <channel> <new-name>  — show a duration picker (buttons)
 *   list                         — show all scheduled VCs and their remaining time
 *   cancel <channel>             — remove the schedule (channel is NOT deleted)
 *
 * Required bot permission: ManageChannels
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { logger } from "../lib/logger";
import { deleteSchedule, listSchedules } from "../lib/vc";

// customId format: vc:rename:<durationKey>:<token>
// The token is a short random key that maps to { channelId, newName } stored
// in an in-memory Map. This keeps customId well within Discord's 100-char limit
// even for long/multibyte channel names.
export const VC_RENAME_BUTTON_PREFIX = "vc:rename:";

export const DURATION_OPTIONS = [
  { key: "1d", label: "1日", ms: 24 * 60 * 60 * 1000 },
  { key: "1w", label: "1週間", ms: 7 * 24 * 60 * 60 * 1000 },
  { key: "1m", label: "1ヶ月", ms: 30 * 24 * 60 * 60 * 1000 },
] as const;

export type DurationKey = (typeof DURATION_OPTIONS)[number]["key"];

export function durationFromKey(key: string): (typeof DURATION_OPTIONS)[number] | undefined {
  return DURATION_OPTIONS.find((d) => d.key === key);
}

// Pending rename records — keyed by a short random token.
// Entries expire after 15 minutes to avoid unbounded growth.
const PENDING_RENAME_TTL_MS = 15 * 60 * 1000;
interface PendingRename { channelId: string; newName: string; expiresAt: number }
const pendingRenames = new Map<string, PendingRename>();

function generateToken(): string {
  // 8 random hex chars — collision probability negligible at this scale
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
}

export function storePendingRename(channelId: string, newName: string): string {
  // Prune stale entries on each new write
  const now = Date.now();
  for (const [key, val] of pendingRenames) {
    if (val.expiresAt < now) pendingRenames.delete(key);
  }
  const token = generateToken();
  pendingRenames.set(token, { channelId, newName, expiresAt: now + PENDING_RENAME_TTL_MS });
  return token;
}

export function consumePendingRename(token: string): PendingRename | undefined {
  const entry = pendingRenames.get(token);
  if (!entry) return undefined;
  pendingRenames.delete(token);
  if (entry.expiresAt < Date.now()) return undefined;
  return entry;
}

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

  // Store rename data in memory and use a short token in customId.
  // Discord limits customId to 100 chars; embedding a full channel name
  // (especially URL-encoded Japanese) would easily exceed that limit.
  const token = storePendingRename(channel.id, newName);

  // customId format: vc:rename:<durationKey>:<token>
  // Max length: 10 + 2 + 1 + 8 = 21 chars — safely under Discord's 100-char limit.
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    DURATION_OPTIONS.map((d) =>
      new ButtonBuilder()
        .setCustomId(`${VC_RENAME_BUTTON_PREFIX}${d.key}:${token}`)
        .setLabel(d.label)
        .setStyle(ButtonStyle.Primary),
    ),
  );

  await interaction.reply({
    content: `<#${channel.id}> を **${newName}** にリネームします。期間を選択してください:`,
    components: [row],
    ephemeral: true,
  });
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
