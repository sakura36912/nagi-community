/**
 * VC session-log and notification logic for the "move between channels" branch
 * of the voiceStateUpdate handler.
 *
 * Extracted from index.ts so it can be unit-tested independently of the Discord
 * client bootstrap.
 */

import {
  getVcLogSettings,
  recordVcLogLeave,
  recordVcLogJoin,
  getVcLogPresence,
} from "./vcReward.js";

// ─── Public interface ─────────────────────────────────────────────────────────

/**
 * Callbacks injected by the caller for the two kinds of Discord notifications.
 * This decouples the routing logic from the Discord.js EmbedBuilder details so
 * it can be tested with simple spy functions.
 */
export interface VcLogMoveNotify {
  sendJoin: (userId: string, channelId: string, notifyChannelId: string) => Promise<void>;
  sendLeave: (
    userId: string,
    channelId: string,
    notifyChannelId: string,
    joinedAt?: Date,
  ) => Promise<void>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns the tracked category ID for `channelId`, or null if it is not in any
 * of the configured log categories.
 *
 * @param channelId       - Discord channel being inspected.
 * @param categoryIds     - The guild's configured log category IDs.
 * @param channelParentId - Callback that resolves a channel to its parent
 *                          category ID (returns null/undefined when absent).
 */
export function getLogCategoryId(
  channelId: string,
  categoryIds: string[],
  channelParentId: (channelId: string) => string | null | undefined,
): string | null {
  if (categoryIds.length === 0) return null; // no categories configured → disabled
  const parentId = channelParentId(channelId) ?? null;
  if (!parentId) return null;
  return categoryIds.includes(parentId) ? parentId : null;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Handles the session-log and notification side-effects when a member moves
 * between two non-AFK voice channels.
 *
 * Three cases:
 *   - tracked → untracked : settle session, send leave notification.
 *   - untracked → tracked : start session, send join notification.
 *   - tracked → tracked   : keep session alive, send both notifications.
 *
 * Throws on unexpected errors so the caller can log them.
 */
export async function handleVcLogMove(
  guildId: string,
  userId: string,
  oldChannelId: string,
  newChannelId: string,
  channelParentId: (channelId: string) => string | null | undefined,
  notify: VcLogMoveNotify,
): Promise<void> {
  const logSettings = await getVcLogSettings(guildId);
  const wasLogCat = getLogCategoryId(oldChannelId, logSettings.categoryIds, channelParentId);
  const nowLogCat = getLogCategoryId(newChannelId, logSettings.categoryIds, channelParentId);

  if (wasLogCat && !nowLogCat) {
    // Moved out of a tracked category — settle the session and notify leave.
    const leaveResult = await recordVcLogLeave(guildId, userId);
    if (logSettings.notifyChannelId) {
      const joinedAt = leaveResult
        ? new Date(Date.now() - leaveResult.durationSeconds * 1000)
        : undefined;
      await notify.sendLeave(userId, oldChannelId, logSettings.notifyChannelId, joinedAt);
    }
  } else if (!wasLogCat && nowLogCat) {
    // Moved into a tracked category — start a new session and notify join.
    await recordVcLogJoin(guildId, userId, newChannelId, nowLogCat);
    if (logSettings.notifyChannelId) {
      await notify.sendJoin(userId, newChannelId, logSettings.notifyChannelId);
    }
  } else if (wasLogCat && nowLogCat && logSettings.notifyChannelId) {
    // Moved within tracked categories — session continues uninterrupted.
    const presence = await getVcLogPresence(guildId, userId);
    await notify.sendLeave(userId, oldChannelId, logSettings.notifyChannelId, presence?.joinedAt);
    await notify.sendJoin(userId, newChannelId, logSettings.notifyChannelId);
  }
}
