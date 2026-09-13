/**
 * validateConfiguredChannels
 *
 * Startup validation pass called from the Events.ClientReady handler in
 * index.ts.  When the bot was offline while a channel was deleted, the
 * ChannelDelete handler never fired and the stale ID remains in the database.
 * This function replicates the same auto-clear + warn logic so that a restart
 * always leaves the bot in a consistent state.
 *
 * Design notes
 * ────────────
 * The functions accept a `resolveChannel` callback instead of a raw Guild
 * object so that they can be exercised in unit tests without a live Discord
 * client.  The callback should return `true` when the channel still exists and
 * `false` (or throw) when it is confirmed gone or unreachable.
 *
 * runStartupChannelValidation is exported so the startup iteration loop
 * (ClientReady → all cached guilds) can also be unit-tested independently
 * of the Discord event system.
 */

import { getVcLogSettings, setVcLogNotifyChannel } from "./vcReward.js";
import {
  getGuildSettings,
  setBanLogChannelId,
  setLeaveLogChannelId,
  setReturnLogChannelId,
} from "./economy.js";
import { logger } from "./logger.js";

/**
 * Run startup channel validation for every guild in the provided iterable.
 *
 * This is the entry point called from the ClientReady handler so that the
 * per-guild iteration logic can be exercised in unit tests without a live
 * Discord client.  Each guild is processed independently: an error in one
 * guild does not prevent the rest from being validated.
 *
 * @param guilds          Iterable of guild-like objects with at least an `id`.
 * @param resolverFactory Given a guild object, returns the `resolveChannel`
 *                        callback suitable for that guild.
 */
export async function runStartupChannelValidation<G extends { id: string }>(
  guilds: Iterable<G>,
  resolverFactory: (guild: G) => (channelId: string) => Promise<boolean>,
): Promise<void> {
  for (const guild of guilds) {
    try {
      await validateGuildConfiguredChannels(guild.id, resolverFactory(guild));
    } catch (err) {
      logger.error(`[startup] チャンネル検証中にエラーが発生しました (guild=${guild.id})`, err);
    }
  }
}

/**
 * Validate every configured channel ID for `guildId` against the live guild
 * channel cache.  Any ID that no longer resolves is cleared with the same
 * auto-clear + warn logic used by the ChannelDelete handler.
 *
 * @param guildId        Discord guild snowflake.
 * @param resolveChannel Returns `true` when the channel exists, `false` when it
 *                       is confirmed gone.  Should throw only on transient /
 *                       network errors — callers may choose to swallow those.
 */
export async function validateGuildConfiguredChannels(
  guildId: string,
  resolveChannel: (channelId: string) => Promise<boolean>,
): Promise<void> {
  // ── VC ログ通知チャンネル ───────────────────────────────────────────────────
  try {
    const logSettings = await getVcLogSettings(guildId);
    if (logSettings.notifyChannelId) {
      const exists = await resolveChannel(logSettings.notifyChannelId).catch(() => {
        // Transient lookup failure — skip clearing to avoid false positives.
        logger.error(
          `[vclog] startup validation: チャンネル ${logSettings.notifyChannelId} の確認中にエラーが発生したためスキップします (guild=${guildId})`,
        );
        return true; // treat as "still exists" so we don't clear it spuriously
      });
      if (!exists) {
        try {
          await setVcLogNotifyChannel(guildId, null);
          logger.warn(
            `[vclog] 起動時検証: 通知チャンネル ${logSettings.notifyChannelId} がギルド ${guildId} に存在しないため notifyChannelId を自動クリアしました。` +
            ` /vclog channel set で再設定してください。`,
          );
        } catch (err) {
          logger.error(
            `[vclog] startup validation: notifyChannelId のクリアに失敗 (guild=${guildId}, channel=${logSettings.notifyChannelId})`,
            err,
          );
        }
      }
    }
  } catch (err) {
    logger.error(
      `[vclog] startup validation: 通知チャンネル設定の読み込みに失敗 (guild=${guildId})`,
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
      `[economy] startup validation: ギルド設定の読み込みに失敗 (guild=${guildId})`,
      err,
    );
  }

  if (guildSettings === null) return;

  // ── BAN ログチャンネル ────────────────────────────────────────────────────
  if (guildSettings.banLogChannelId) {
    const banChannelId = guildSettings.banLogChannelId;
    const exists = await resolveChannel(banChannelId).catch(() => {
      logger.error(
        `[bannotify] startup validation: チャンネル ${banChannelId} の確認中にエラーが発生したためスキップします (guild=${guildId})`,
      );
      return true;
    });
    if (!exists) {
      try {
        await setBanLogChannelId(guildId, null);
        logger.warn(
          `[bannotify] 起動時検証: BAN ログチャンネル ${banChannelId} がギルド ${guildId} に存在しないため banLogChannelId を自動クリアしました。` +
          ` 再設定してください。`,
        );
      } catch (err) {
        logger.error(
          `[economy] startup validation: banLogChannelId のクリアに失敗 (guild=${guildId}, channel=${banChannelId})`,
          err,
        );
      }
    }
  }

  // ── 退出ログチャンネル ────────────────────────────────────────────────────
  if (guildSettings.leaveLogChannelId) {
    const leaveChannelId = guildSettings.leaveLogChannelId;
    const exists = await resolveChannel(leaveChannelId).catch(() => {
      logger.error(
        `[leavelog] startup validation: チャンネル ${leaveChannelId} の確認中にエラーが発生したためスキップします (guild=${guildId})`,
      );
      return true;
    });
    if (!exists) {
      try {
        await setLeaveLogChannelId(guildId, null);
        logger.warn(
          `[leavelog] 起動時検証: 退出ログチャンネル ${leaveChannelId} がギルド ${guildId} に存在しないため leaveLogChannelId を自動クリアしました。` +
          ` 再設定してください。`,
        );
      } catch (err) {
        logger.error(
          `[economy] startup validation: leaveLogChannelId のクリアに失敗 (guild=${guildId}, channel=${leaveChannelId})`,
          err,
        );
      }
    }
  }

  // ── 出戻りログチャンネル ────────────────────────────────────────────────
  if (guildSettings.returnLogChannelId) {
    const returnChannelId = guildSettings.returnLogChannelId;
    const exists = await resolveChannel(returnChannelId).catch(() => {
      logger.error(
        `[returnlog] startup validation: チャンネル ${returnChannelId} の確認中にエラーが発生したためスキップします (guild=${guildId})`,
      );
      return true;
    });
    if (!exists) {
      try {
        await setReturnLogChannelId(guildId, null);
        logger.warn(
          `[returnlog] 起動時検証: 出戻りログチャンネル ${returnChannelId} がギルド ${guildId} に存在しないため returnLogChannelId を自動クリアしました。再設定してください。`,
        );
      } catch (err) {
        logger.error(
          `[economy] startup validation: returnLogChannelId のクリアに失敗 (guild=${guildId}, channel=${returnChannelId})`,
          err,
        );
      }
    }
  }
}
