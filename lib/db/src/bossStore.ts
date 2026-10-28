import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "./index";
import { walletsTable, transactionsTable } from "./schema/economy";
import { bossEventsTable as events, bossBattlesTable as battles, bossMembersTable as members,
  bossActiveUsersTable as active, bossActionsTable as actions, type BossBattle } from "./schema/boss";
import { ensureBossSchema } from "./bossSchema";
import { BossError, splitBossReward, type BossActionResult, type BattleStatus } from "./bossRules";
import { FORGE_MAX_INT } from "./forgeRules";

export type BossTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export async function withBossGuild<T>(guildId: string, work: (tx: BossTx) => Promise<T>) {
  await ensureBossSchema();
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["boss-guild", guildId])}, 0))`);
    return work(tx);
  });
}
export async function bossMembers(tx: BossTx | typeof db, battleId: string) {
  return tx.select().from(members).where(eq(members.battleId, battleId));
}
export async function activeBossEvent(tx: BossTx | typeof db, guildId: string) {
  const [event] = await tx.select().from(events).where(and(eq(events.guildId, guildId), eq(events.status, "active")));
  return event;
}
export async function previousBossAction(tx: BossTx, id: string, guildId: string, userId: string, action: string) {
  const [row] = await tx.select().from(actions).where(eq(actions.id, id));
  if (!row) return undefined;
  if (row.guildId !== guildId || row.userId !== userId || row.action !== action) throw new BossError("操作の識別情報が一致しません。");
  return { ...row.result, repeated: true };
}
export async function recordBossAction(tx: BossTx, id: string, guildId: string, userId: string, action: string, result: BossActionResult) {
  await tx.insert(actions).values({ id, guildId, userId, action, result });
  return result;
}
export async function finishBossBattle(
  tx: BossTx, battle: BossBattle, status: BattleStatus, reason: string, now: Date,
) {
  if (!["waiting", "active"].includes(battle.status)) return battle;
  let rewards: { userId: string; amount: number }[] = [];
  if (status === "won") {
    const [event] = await tx.select().from(events).where(eq(events.id, battle.eventId));
    if (!event) throw new BossError("開催情報が見つかりません。");
    const players = await bossMembers(tx, battle.id);
    rewards = splitBossReward(event.config.reward * (event.config.special === "double_reward" ? 2 : 1), players.map(p => p.userId));
    for (const reward of rewards) {
      await tx.insert(walletsTable).values({ guildId: battle.guildId, userId: reward.userId, balance: 0 }).onConflictDoNothing();
      const [wallet] = await tx.update(walletsTable).set({
        balance: sql`${walletsTable.balance} + ${reward.amount}`, updatedAt: now,
      }).where(and(eq(walletsTable.guildId, battle.guildId), eq(walletsTable.userId, reward.userId),
        sql`${walletsTable.balance} <= ${FORGE_MAX_INT - reward.amount}`)).returning();
      if (!wallet) throw new BossError("参加者の残高上限により報酬を加算できません。今回の操作は課金せず取り消しました。管理者に残高の確認を依頼してください。");
      await tx.insert(transactionsTable).values({ guildId: battle.guildId, userId: reward.userId, amount: reward.amount,
        reason: `ボス討伐報酬（${battle.mode === "solo" ? "ソロ" : "パーティ均等分配"}）`,
        sessionKey: `boss-reward:${battle.id}:${reward.userId}` });
    }
  }
  const [finished] = await tx.update(battles).set({ status, reason, rewards, finishedAt: now, noticeNextAt: now })
    .where(eq(battles.id, battle.id)).returning();
  await tx.delete(active).where(and(eq(active.guildId, battle.guildId), eq(active.battleId, battle.id)));
  return finished!;
}
/** 受付開始・期限処理を毎回DBから復元する。メモリ内タイマーだけに依存しない。 */
export async function advanceBossGuild(guildId: string, now = new Date()) {
  return withBossGuild(guildId, async tx => {
    const event = await activeBossEvent(tx, guildId);
    if (event && event.endsAt <= now) await tx.update(events).set({ status: "ended" }).where(eq(events.id, event.id));
    const open = await tx.select().from(battles).where(and(eq(battles.guildId, guildId), inArray(battles.status, ["waiting", "active"])));
    for (const battle of open) {
      if (battle.endsAt <= now) {
        await finishBossBattle(tx, battle, battle.status === "waiting" ? "cancelled" : "failed", "制限時間終了", now);
      } else if (battle.status === "waiting" && battle.lobbyEndsAt && battle.lobbyEndsAt <= now) {
        const count = (await bossMembers(tx, battle.id)).length;
        if (count >= 2 && count <= 4) await tx.update(battles).set({ status: "active", startedAt: now, noticeNextAt: now })
          .where(eq(battles.id, battle.id));
        else await finishBossBattle(tx, battle, "cancelled", "受付終了時に2人以上集まりませんでした", now);
      }
    }
  });
}
