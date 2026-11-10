import { getTotalChestVcSeconds } from "./vcReward";
import { getCurrentTavernSeconds, getPendingTavernSeconds } from "./chestTracker";
import { logger } from "./logger";

export const VOYAGE_JOURNAL_REQUIRED_SECONDS = 100 * 60 * 60;

/** Uses the same cumulative tavern time as the chest tracker, not spent chest credits. */
export async function voyageJournalPurchaseError(
  guildId: string, userId: string, itemName: string,
): Promise<string | null> {
  if (itemName !== "航海日誌") return null;
  try {
    const saved = await getTotalChestVcSeconds(guildId, userId);
    const total = saved + getPendingTavernSeconds(guildId, userId) + getCurrentTavernSeconds(guildId, userId);
    if (!Number.isFinite(total) || total < 0) throw new Error("Invalid tavern time");
    if (total >= VOYAGE_JOURNAL_REQUIRED_SECONDS) return null;
    const hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60);
    return `航海日誌は酒場VCの累計参加時間が100時間以上のメンバーのみ購入できます。現在: ${hours}時間${minutes}分。引き落としは行っていません。`;
  } catch (error) {
    logger.error("[shop] Failed to check voyage journal tavern time", error);
    return "酒場VCの累計参加時間を確認できませんでした。購入は行っていません。時間をおいて再実行してください。";
  }
}
