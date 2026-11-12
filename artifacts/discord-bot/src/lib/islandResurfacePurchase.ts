import type { Guild } from "discord.js";
import { logger } from "./logger";

/** Check current membership before any debit, including old panels and legacy items. */
export async function islandResurfacePurchaseError(
  guild: Guild | null,
  userId: string,
  item: { name: string; effectType?: string | null },
): Promise<string | null> {
  if (item.effectType !== "eval_resurface" && item.name !== "オチテモータ島浮上券") return null;
  try {
    if (!guild) throw new Error("Guild unavailable");
    const member = await guild.members.fetch({ user: userId, force: true });
    if (member.roles.cache.some(role => role.name === "本船員")) return null;
    return "❌ オチテモータ島浮上券は本船員ロールを持つメンバーのみ購入できます。引き落としは行っていません。";
  } catch (error) {
    logger.error("[shop] Failed to check island resurface buyer role", error);
    return "本船員ロールの所持を確認できませんでした。引き落としは行っていません。時間をおいて再実行してください。";
  }
}
