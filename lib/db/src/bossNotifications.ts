import { and, eq, lte, sql } from "drizzle-orm";
import { db } from "./index";
import { bossBattlesTable as battles, bossEventsTable as events } from "./schema/boss";
import { ensureBossSchema } from "./bossSchema";
import { bossMembers } from "./bossStore";

export async function dueBossGuilds(now = new Date()) {
  await ensureBossSchema();
  const result = await db.execute<{ guild_id: string }>(sql`
    SELECT guild_id FROM boss_events WHERE status = 'active' AND ends_at <= ${now}
    UNION SELECT guild_id FROM boss_battles WHERE
      (status = 'active' AND ends_at <= ${now}) OR
      (status = 'waiting' AND (lobby_ends_at <= ${now} OR ends_at <= ${now}))
  `);
  return result.rows.map(row => row.guild_id);
}
export async function pendingBossNotices(now = new Date()) {
  await ensureBossSchema();
  return db.select({ id: battles.id }).from(battles).where(and(
    sql`${battles.noticeState} IS DISTINCT FROM ${battles.status}`,
    lte(battles.noticeNextAt, now),
  )).orderBy(battles.noticeNextAt).limit(10);
}
export async function getBossBattleBundle(battleId: string) {
  await ensureBossSchema();
  const [battle] = await db.select().from(battles).where(eq(battles.id, battleId));
  if (!battle) return undefined;
  const [event] = await db.select().from(events).where(eq(events.id, battle.eventId));
  if (!event) return undefined;
  return { battle, event, members: await bossMembers(db, battle.id) };
}
export type BossNoticeBundle = NonNullable<Awaited<ReturnType<typeof getBossBattleBundle>>>;
/** DBロックで送信を直列化。失敗時はバックオフし、決済・報酬を再実行しない。 */
export async function deliverBossNotice(id: string, send: (bundle: BossNoticeBundle) => Promise<string>, now = new Date()) {
  await ensureBossSchema();
  return db.transaction(async tx => {
    const lock = await tx.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${JSON.stringify(["boss-notice", id])}, 0)) AS locked`);
    if (!lock.rows[0]?.locked) return;
    const [battle] = await tx.select().from(battles).where(eq(battles.id, id));
    if (!battle || battle.noticeState === battle.status || battle.noticeNextAt > now) return;
    const [event] = await tx.select().from(events).where(eq(events.id, battle.eventId));
    if (!event) return;
    try {
      const messageId = await send({ battle, event, members: await bossMembers(tx, id) });
      await tx.update(battles).set({ noticeState: battle.status, noticeMessageId: messageId, noticeAttempts: 0 })
        .where(eq(battles.id, id));
    } catch (error) {
      const attempts = Math.min(20, battle.noticeAttempts + 1);
      await tx.update(battles).set({ noticeAttempts: attempts,
        noticeNextAt: new Date(now.getTime() + Math.min(3600, 15 * 2 ** attempts) * 1000) }).where(eq(battles.id, id));
      return { error };
    }
    return undefined;
  });
}
