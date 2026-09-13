/**
 * handleChannelDelete
 *
 * Called from the Events.ChannelDelete listener in index.ts.
 * Extracted into its own module so it can be unit-tested independently
 * of the Discord client bootstrap.
 */

import type { DMChannel, NonThreadGuildBasedChannel } from "discord.js";
import { getVcLogSettings, setVcLogNotifyChannel } from "./vcReward.js";
import { getGuildSettings, setBanLogChannelId, setLeaveLogChannelId, setReturnLogChannelId } from "./economy.js";
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

  // ── ギルド設定を一度だけ読み込む ─────────────────────────────────────────
  let guildSettings: {
    banLogChannelId: string | null;
    leaveLogChannelId: string | null;
    returnLogChannelId: string | null;
  } | null =
    null;
  try {
    guildSettings = await getGuildSettings(guildId);
  } catch (err) {
    logger.error(
      `[economy] ChannelDelete: ギルド設定の読み込みに失敗 (guild=${guildId}, channel=${channel.id})`,
      err,
    );
  }

  if (guildSettings === null) return;

  // ── BAN ログチャンネル ────────────────────────────────────────────────────
  if (guildSettings.banLogChannelId === channel.id) {
    try {
      await setBanLogChannelId(guildId, null);
      logger.warn(
        `[bannotify] BAN ログチャンネル ${channel.id} がギルド ${guildId} で削除されたため banLogChannelId を自動クリアしました。` +
        ` 再設定してください。`,
      );
    } catch (err) {
      logger.error(
        `[economy] ChannelDelete: banLogChannelId のクリアに失敗 (guild=${guildId}, channel=${channel.id})`,
        err,
      );
    }
  }

  // ── 退出ログチャンネル ──────────────────────────────────────────────────
  if (guildSettings.leaveLogChannelId === channel.id) {
    try {
      await setLeaveLogChannelId(guildId, null);
      logger.warn(
        `[leavelog] 退出ログチャンネル ${channel.id} がギルド ${guildId} で削除されたため leaveLogChannelId を自動クリアしました。` +
        ` 再設定してください。`,
      );
    } catch (err) {
      logger.error(
        `[economy] ChannelDelete: leaveLogChannelId のクリアに失敗 (guild=${guildId}, channel=${channel.id})`,
        err,
      );
    }
  }

  // ── 出戻りログチャンネル ────────────────────────────────────────────────
  if (guildSettings.returnLogChannelId === channel.id) {
    try {
      await setReturnLogChannelId(guildId, null);
      logger.warn(
        `[returnlog] 出戻りログチャンネル ${channel.id} がギルド ${guildId} で削除されたため returnLogChannelId を自動クリアしました。再設定してください。`,
      );
    } catch (err) {
      logger.error(
        `[economy] ChannelDelete: returnLogChannelId のクリアに失敗 (guild=${guildId}, channel=${channel.id})`,
        err,
      );
    }
  }
}
