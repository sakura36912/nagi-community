/**
 * 宝箱用の酒場VC滞在時間トラッカー。
 * VC報酬設定とは完全に独立しており、チャンネル名「酒場」への接続のみを追跡する。
 * Bot 再起動時にリセットされるが、DB の accumulated_seconds は維持される。
 */
import type { Guild } from "discord.js";
import { addChestVcSeconds } from "./vcReward";
import { logger } from "./logger";

/** 酒場チャンネルとして認識するチャンネル名（完全一致）。複数指定可。 */
const TAVERN_CHANNEL_NAMES = new Set(["大酒場🍺", "小酒場🍺"]);

/** `${guildId}:${userId}` → 酒場への入室時刻 */
const tavernJoinedAt = new Map<string, Date>();

function tavernKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

/** 指定チャンネルが酒場（大酒場🍺 / 小酒場🍺）かどうかを返す */
export function isTavernChannel(guild: Guild, channelId: string): boolean {
  const ch = guild.channels.cache.get(channelId);
  return ch != null && TAVERN_CHANNEL_NAMES.has(ch.name);
}

/** 酒場に入室したとき呼ぶ */
export function onTavernJoin(guildId: string, userId: string): void {
  tavernJoinedAt.set(tavernKey(guildId, userId), new Date());
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
