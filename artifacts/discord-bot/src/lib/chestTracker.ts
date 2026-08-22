/**
 * 宝箱用の酒場VC滞在時間トラッカー。
 * VC報酬設定とは完全に独立しており、チャンネル名「酒場」への接続のみを追跡する。
 * Bot 再起動時にリセットされるが、DB の accumulated_seconds は維持される。
 */
import type { Guild } from "discord.js";
import { addChestVcSeconds } from "./vcReward";
import { getGuildSettings } from "./economy";
import { logger } from "./logger";

/**
 * 酒場チャンネルとして認識するデフォルトチャンネル名（完全一致）。
 * guild_settings.chest_tavern_channel_names が未設定のときのフォールバック。
 * チャンネル名を変更するには /宝箱 set-channels コマンドを使用すること。
 */
export const TAVERN_CHANNEL_NAMES = new Set(["大酒場🍺", "小酒場🍺"]);

/** `${guildId}:${userId}` → 酒場への入室時刻 */
const tavernJoinedAt = new Map<string, Date>();

/**
 * フラッシュ済みだが DB への加算がまだ完了していない秒数。
 *
 * flushAllTavernSessions は二重加算を避けるため先に joinedAt を更新する。
 * DB の書き込みが完了するまでこの秒数を別管理し、読み取り時に含めることで
 * 「メモリ上はリセット済み・DB上は未反映」という短い期間にも累積時間が減らないようにする。
 */
const pendingFlushSeconds = new Map<string, number>();

function tavernKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

/**
 * ギルド固有の酒場チャンネル名セットを返す。
 * DB に設定値があればそれを使い、なければ TAVERN_CHANNEL_NAMES にフォールバックする。
 */
export async function getTavernChannelNames(guildId: string): Promise<Set<string>> {
  try {
    const settings = await getGuildSettings(guildId);
    if (settings.chestTavernChannelNames) {
      const names = settings.chestTavernChannelNames
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (names.length > 0) return new Set(names);
    }
  } catch (err) {
    logger.warn(`[chest] getTavernChannelNames DB error for ${guildId}, using defaults`, err);
  }
  return TAVERN_CHANNEL_NAMES;
}

/** 指定チャンネルが酒場かどうかを返す（ギルド固有設定を参照）。 */
export async function isTavernChannel(guildId: string, guild: Guild, channelId: string): Promise<boolean> {
  // キャッシュになければ API から取得（hub 生成直後など未キャッシュのケース対策）
  const ch = guild.channels.cache.get(channelId)
    ?? await guild.channels.fetch(channelId).catch(() => null);
  if (!ch) return false;
  const names = await getTavernChannelNames(guildId);
  return names.has(ch.name);
}

/** 酒場に入室したとき呼ぶ */
export function onTavernJoin(guildId: string, userId: string): void {
  const key = tavernKey(guildId, userId);
  if (tavernJoinedAt.has(key)) {
    logger.warn(
      `[chest] onTavernJoin: ${key} already tracked (double-join without leave) — skipping to avoid overwriting existing session`,
    );
    return;
  }
  tavernJoinedAt.set(key, new Date());
}

/**
 * 酒場から退出（または酒場外へ移動）したとき呼ぶ。
 * DB に accumulated_seconds を加算する。
 */
export async function onTavernLeave(guildId: string, userId: string): Promise<void> {
  const key = tavernKey(guildId, userId);
  const joined = tavernJoinedAt.get(key);
  if (!joined) return; // 追跡していなかった場合はスキップ
  tavernJoinedAt.delete(key);
  const seconds = Math.floor((Date.now() - joined.getTime()) / 1000);
  if (seconds <= 0) return;
  try {
    await addChestVcSeconds(guildId, userId, seconds);
  } catch (err) {
    logger.error(`[chest] onTavernLeave addChestVcSeconds error for ${userId} in ${guildId}`, err);
  }
}

/** 現在のセッションで酒場に滞在している秒数を返す（退出済みの場合は 0）。 */
export function getCurrentTavernSeconds(guildId: string, userId: string): number {
  const joined = tavernJoinedAt.get(tavernKey(guildId, userId));
  if (!joined) return 0;
  return Math.floor((Date.now() - joined.getTime()) / 1000);
}

/** DB へのフラッシュ処理中で、まだ DB の累積値に反映されていない秒数を返す。 */
export function getPendingTavernSeconds(guildId: string, userId: string): number {
  return pendingFlushSeconds.get(tavernKey(guildId, userId)) ?? 0;
}

/**
 * 現在酒場に在室している全ユーザーの累積時間を DB へ書き出す。
 * Bot 再起動時にメモリが消えて時間が失われるのを防ぐため、定期的に呼ぶこと。
 * 書き出し後は joinedAt をリセットするので二重カウントは起きない。
 */
export async function flushAllTavernSessions(): Promise<void> {
  const now = new Date();
  const entries = [...tavernJoinedAt.entries()];
  if (entries.length === 0) return;
  await Promise.allSettled(
    entries.map(async ([key, joined]) => {
      const seconds = Math.floor((now.getTime() - joined.getTime()) / 1000);
      if (seconds <= 0) return;
      // joinedAt を今の時刻にリセット（退出時に二重カウントされないよう）
      tavernJoinedAt.set(key, now);
      pendingFlushSeconds.set(key, (pendingFlushSeconds.get(key) ?? 0) + seconds);
      const [guildId, userId] = key.split(":");
      try {
        await addChestVcSeconds(guildId, userId, seconds);
      } finally {
        const pending = (pendingFlushSeconds.get(key) ?? 0) - seconds;
        if (pending > 0) {
          pendingFlushSeconds.set(key, pending);
        } else {
          pendingFlushSeconds.delete(key);
        }
      }
    }),
  );
}
