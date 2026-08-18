/**
 * VC session-log and join-notification logic for the straight-join branch
 * of the voiceStateUpdate handler (user joins from nothing or from AFK).
 *
 * Extracted from index.ts so it can be unit-tested independently of the
 * Discord client bootstrap.
 */

import { VoiceState } from "discord.js";
import { getVcLogSettings, recordVcLogJoin } from "./vcReward.js";
import { sendVcNotifyJoin } from "./vcNotify.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns the tracked log category ID for `channelId` by looking up
 * `guild.channels.cache`, or null if the channel is not in any configured
 * log category.
 */
function getLogCategoryId(
  channelId: string,
  categoryIds: string[],
  guild: VoiceState["guild"],
): string | null {
  if (categoryIds.length === 0) return null; // empty = disabled
  const channel = guild.channels.cache.get(channelId);
  if (!channel || !channel.parentId) return null;
  return categoryIds.includes(channel.parentId) ? channel.parentId : null;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Handles the session-log and join-notification side-effects when a member
 * joins a VC from nothing (or from AFK).
 *
 * - Records the session start if the channel is in a configured log category.
 * - Sends a join notification to the configured notify channel (silently
 *   no-ops when the notify channel has been deleted from guild.channels.cache).
 *
 * Throws on unexpected errors so the caller can log them.
 */
export async function handleVcLogJoin(
  guild: VoiceState["guild"],
  userId: string,
  newChannelId: string,
): Promise<void> {
  const logSettings = await getVcLogSettings(guild.id);
  const catId = getLogCategoryId(newChannelId, logSettings.categoryIds, guild);
  if (catId) await recordVcLogJoin(guild.id, userId, newChannelId, catId);
  // 追跡カテゴリ内のチャンネルのみ通知。
  // 追跡外（Hub 待機チャンネル等）は通知しない → 移動後の実VCで handleVcLogMove が通知する。
  if (catId && logSettings.notifyChannelId) {
    await sendVcNotifyJoin(guild, userId, newChannelId, logSettings.notifyChannelId);
  }
}
