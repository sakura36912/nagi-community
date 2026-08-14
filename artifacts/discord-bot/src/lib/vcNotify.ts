/**
 * VC join/leave notification helpers.
 *
 * Extracted from index.ts so they can be unit-tested independently of the
 * Discord client bootstrap (which creates a Client on import).
 */

import { EmbedBuilder, TextChannel, VoiceState } from "discord.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the display name of a VC channel, falling back to its ID. */
export function getVcChannelName(
  guild: VoiceState["guild"],
  channelId: string,
): string {
  return guild.channels.cache.get(channelId)?.name ?? `チャンネル(${channelId})`;
}

/** 秒数を「X時間Y分Z秒」形式に変換 */
export function formatDuration(totalSecs: number): string {
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (h > 0) return `${h}時間${m}分${s}秒`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

// ─── Notification senders ─────────────────────────────────────────────────────

/**
 * Sends a join notification embed to the configured notify channel.
 *
 * Silently no-ops when `notifyChannelId` is absent from
 * `guild.channels.cache` (e.g. the channel was deleted after the bot
 * fetched its settings), or when sending fails for any reason.
 */
export async function sendVcNotifyJoin(
  guild: VoiceState["guild"],
  userId: string,
  channelId: string,
  notifyChannelId: string,
): Promise<void> {
  try {
    const ch = guild.channels.cache.get(notifyChannelId);
    if (!ch || !("send" in ch)) return;
    const member = guild.members.cache.get(userId);
    const memberName = member?.displayName ?? `ユーザー(${userId})`;
    const memberIconUrl = member?.displayAvatarURL() ?? undefined;
    const channelName = getVcChannelName(guild, channelId);
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setAuthor({ name: memberName, iconURL: memberIconUrl })
      .setDescription(`🔊 **${channelName}** に参加しました`)
      .setTimestamp();
    if (memberIconUrl) embed.setThumbnail(memberIconUrl);
    await (ch as TextChannel).send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch {
    // 通知失敗は無視
  }
}

/**
 * Sends a leave notification embed to the configured notify channel.
 *
 * Silently no-ops when `notifyChannelId` is absent from
 * `guild.channels.cache` (e.g. the channel was deleted), or when
 * sending fails for any reason.
 */
export async function sendVcNotifyLeave(
  guild: VoiceState["guild"],
  userId: string,
  channelId: string,
  notifyChannelId: string,
  joinedAt?: Date,
): Promise<void> {
  try {
    const ch = guild.channels.cache.get(notifyChannelId);
    if (!ch || !("send" in ch)) return;
    const member = guild.members.cache.get(userId);
    const memberName = member?.displayName ?? `ユーザー(${userId})`;
    const memberIconUrl = member?.displayAvatarURL() ?? undefined;
    const channelName = getVcChannelName(guild, channelId);
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setAuthor({ name: memberName, iconURL: memberIconUrl })
      .setDescription(`🔇 **${channelName}** から退出しました`)
      .setTimestamp();
    if (memberIconUrl) embed.setThumbnail(memberIconUrl);
    if (joinedAt) {
      const secs = Math.floor((Date.now() - joinedAt.getTime()) / 1000);
      embed.addFields({ name: "⏱ 滞在時間", value: formatDuration(secs), inline: true });
    }
    await (ch as TextChannel).send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch {
    // 通知失敗は無視
  }
}
