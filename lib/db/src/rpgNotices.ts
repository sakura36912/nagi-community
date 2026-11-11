import { and, eq, isNull, lte } from "drizzle-orm";
import { db } from "./index";
import { rpgNoticesTable as notices, type RpgCard } from "./schema/pvp";
import { FORGE_WEAPONS, isForgeWeaponType } from "./forgeRules";
import type { ForgeActionResult } from "./schema/forge";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export async function queueRpgCard(tx: Tx, id: string, guildId: string, channelId: string, card: RpgCard) {
  await tx.insert(notices).values({ id, guildId, channelId, card }).onConflictDoNothing();
}
export async function queueForgeCard(tx: Tx, id: string, guildId: string, userId: string, channelId: string, result: ForgeActionResult) {
  if (!result.weaponType || !isForgeWeaponType(result.weaponType)) throw new Error("Invalid public weapon result");
  const weapon = FORGE_WEAPONS[result.weaponType];
  await queueRpgCard(tx, `forge-public:${id}`, guildId, channelId, {
    title: result.action === "select" ? "⚔️ 武器を選択しました" : result.success ? "✨ 武器強化成功！" : "🔨 武器強化失敗",
    description: `<@${userId}>\n${result.action === "upgrade" && !result.success ? "費用は消費しました。レベル低下・武器破壊はありません。" : ""}`,
    color: result.action === "select" ? 0xd49b43 : result.success ? 0x2ecc71 : 0xe67e22,
    fields: [
      { name: "武器", value: weapon.name, inline: true },
      { name: "レベル", value: `Lv${result.level}`, inline: true },
      { name: "固有スキル", value: weapon.skill },
      ...(result.action === "upgrade" ? [{ name: "強化費用", value: `$${(result.cost ?? 0).toLocaleString("ja-JP")}`, inline: true }] : []),
    ],
  });
}
export async function pendingRpgCards(now = new Date()) {
  return db.select({ id: notices.id }).from(notices)
    .where(and(isNull(notices.messageId), lte(notices.nextAt, now))).orderBy(notices.nextAt).limit(30);
}
/** Row lock prevents two recovery workers from sending concurrently; Discord nonce covers lost acknowledgements. */
export async function deliverRpgCard(id: string, send: (notice: typeof notices.$inferSelect) => Promise<string>, now = new Date()) {
  return db.transaction(async tx => {
    const [row] = await tx.select().from(notices).where(eq(notices.id, id)).for("update");
    if (!row || row.messageId || row.nextAt > now) return;
    try {
      const messageId = await send(row);
      await tx.update(notices).set({ messageId }).where(eq(notices.id, id));
      return undefined;
    } catch (error) {
      await tx.update(notices).set({ attempts: row.attempts + 1,
        nextAt: new Date(now.getTime() + Math.min(3600, 15 * 2 ** Math.min(row.attempts, 8)) * 1000) })
        .where(eq(notices.id, id));
      return { error };
    }
  });
}
