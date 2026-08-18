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

// ─── Join deduplication ───────────────────────────────────────────────────────

/**
 * Tracks the last time a join notification was sent for a given
 * guildId:userId:channelId triple.
 *
 * Discord mobile clients sometimes fire multiple VOICE_STATE_UPDATE events
 * in rapid succession for a single physical join (e.g. during connection
 * negotiation). Without dedup this results in 2–3 identical join embeds.
 *
 * 5 seconds is long enough to absorb any Discord gateway burst, yet short
 * enough that a user who genuinely leaves and rejoins the same VC within
 * a few seconds will still get a notification on the second entry.
 */
const JOIN_DEDUP_MS = 5_000;
const recentJoins = new Map<string, number>(); // `guildId:userId:channelId` → timestamp

// ─── Notification senders ─────────────────────────────────────────────────────

/**
 * Sends a join notification embed to the configured notify channel.
 *
 * Silently no-ops when `notifyChannelId` is absent from
 * `guild.channels.cache` (e.g. the channel was deleted after the bot
 * fetched its settings), or when sending fails for any reason.
 *
 * Deduplicates notifications within a 5-second window to suppress the
 * spurious duplicate events that Discord mobile clients emit on join.
 */
export async function sendVcNotifyJoin(
  guild: VoiceState["guild"],
  userId: string,
  channelId: string,
  notifyChannelId: string,
): Promise<void> {
  // Dedup: skip if we already sent a join for this user+channel recently.
  const dedupKey = `${guild.id}:${userId}:${channelId}`;
  const lastSent = recentJoins.get(dedupKey);
  if (lastSent !== undefined && Date.now() - lastSent < JOIN_DEDUP_MS) return;
  recentJoins.set(dedupKey, Date.now());

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
