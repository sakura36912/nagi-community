/**
 * handleChannelDelete
 *
 * Called from the Events.ChannelDelete listener in index.ts.
 * Extracted into its own module so it can be unit-tested independently
 * of the Discord client bootstrap.
 */

import type { DMChannel, NonThreadGuildBasedChannel } from "discord.js";
import { getVcLogSettings, setVcLogNotifyChannel } from "./vcReward.js";
import { getGuildSettings, setBanLogChannelId, setLeaveLogChannelId } from "./economy.js";
import { logger } from "./logger.js";

export async function handleChannelDelete(
  channel: DMChannel | NonThreadGuildBasedChannel,
): Promise<void> {
  // DM channels have no guildId — ignore them.
  if (!("guildId" in channel) || !channel.guildId) return;

  const guildId = channel.guildId;

  // ── VC ログ通知チャンネル ─────────────────────────────────────────────────
  try {
    const logSettings = await getVcLogSettings(guildId);
    if (logSettings.notifyChannelId === channel.id) {
      await setVcLogNotifyChannel(guildId, null);
      logger.warn(
        `[vclog] 通知チャンネル ${channel.id} がギルド ${guildId} で削除されたため notifyChannelId を自動クリアしました。` +
        ` /vclog channel set で再設定してください。`,
      );
    }
  } catch (err) {
    logger.error(
      `[vclog] ChannelDelete: 通知チャンネル設定のクリアに失敗 (guild=${guildId}, channel=${channel.id})`,
      err,
    );
  }

  // ── BAN ログチャンネル ────────────────────────────────────────────────────
  try {
    const guildSettings = await getGuildSettings(guildId);
    if (guildSettings.banLogChannelId === channel.id) {
      await setBanLogChannelId(guildId, null);
      logger.warn(
        `[bannotify] BAN ログチャンネル ${channel.id} がギルド ${guildId} で削除されたため banLogChannelId を自動クリアしました。` +
        ` 再設定してください。`,
      );
    }

    // ── 退出ログチャンネル ──────────────────────────────────────────────────
    if (guildSettings.leaveLogChannelId === channel.id) {
      await setLeaveLogChannelId(guildId, null);
      logger.warn(
        `[leavelog] 退出ログチャンネル ${channel.id} がギルド ${guildId} で削除されたため leaveLogChannelId を自動クリアしました。` +
        ` 再設定してください。`,
      );
    }
  } catch (err) {
    logger.error(
      `[economy] ChannelDelete: banLog/leaveLog チャンネル設定のクリアに失敗 (guild=${guildId}, channel=${channel.id})`,
      err,
    );
  }
}
