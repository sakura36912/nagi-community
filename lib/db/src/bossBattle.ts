import { and, eq, sql } from "drizzle-orm";
import { walletsTable, transactionsTable } from "./schema/economy";
import { bossEventsTable as events, bossBattlesTable as battles, bossMembersTable as members,
  bossActiveUsersTable as active } from "./schema/boss";
import { advanceBossGuild, withBossGuild, bossMembers, previousBossAction, recordBossAction, finishBossBattle } from "./bossStore";
import { BossError, bossPlayerAttack, bossHealing, bossCounter, bossCooldownSeconds, type BossActionResult } from "./bossRules";
import { forgeRoll, isForgeWeaponType } from "./forgeRules";
import { forgeWeaponsTable } from "./schema/forge";
import { bossCombo, bossAttackPresentation, type BossAttackPresentation } from "./bossAttackEffects";

/** 攻撃無料・回復課金・個別クールタイム・勝利報酬を同時に確定する。 */
export async function performBossAction(
  id: string, guildId: string, userId: string, action: "attack" | "heal",
  options: { now?: Date; roll?: () => number } = {},
) {
  const now = options.now ?? new Date(), roll = options.roll ?? forgeRoll;
  await advanceBossGuild(guildId, now);
  return withBossGuild(guildId, async tx => {
    const previous = await previousBossAction(tx, id, guildId, userId, action);
    if (previous) return previous;
    const [membership] = await tx.select().from(active).where(and(eq(active.guildId, guildId), eq(active.userId, userId)));
    if (!membership) throw new BossError("討伐に参加していません。/参加 を使用してください。");
    const [battle] = await tx.select().from(battles).where(eq(battles.id, membership.battleId));
    if (!battle || battle.status !== "active" || battle.endsAt <= now) throw new BossError("戦闘中ではありません。受付中または終了済みです。");
    const [event] = await tx.select().from(events).where(eq(events.id, battle.eventId));
    if (!event || event.status !== "active") throw new BossError("イベントは終了しています。");
    let players = await bossMembers(tx, battle.id);
    const player = players.find(p => p.userId === userId);
    if (!player || player.hp <= 0) throw new BossError("戦闘不能のため行動できません。パーティの終了を待ってください。");
    const readyKey = action === "attack" ? "attackReadyAt" : "healReadyAt";
    const readyAt = player.effects[readyKey] ?? 0;
    if (readyAt > now.getTime()) throw new BossError(`次の${action === "attack" ? "攻撃" : "回復"}まで${Math.ceil((readyAt - now.getTime()) / 1000)}秒お待ちください。`);
    const paid = action === "attack" ? 0 : battle.healCost;
    if (action === "heal" && paid <= 0) throw new BossError("この討伐の有料回復料金が未設定です。管理者にお問い合わせください。");
    const messages: string[] = [];
    let bossHp = battle.currentHp, damage = 0, healed = 0, critical = false, skill: string | undefined;
    let presentation: BossAttackPresentation | undefined;
    if (action === "attack") {
      // Refresh only the selected weapon's offensive growth. HP, role bonus,
      // weapon type and defensive snapshot stay fixed at participation.
      // A shared lock gives this action one consistent committed upgrade.
      const [weapon] = await tx.select().from(forgeWeaponsTable).where(and(
        eq(forgeWeaponsTable.guildId, guildId), eq(forgeWeaponsTable.userId, userId),
      )).for("share");
      if (weapon?.weaponType === player.weapon.weaponType) {
        player.weapon = { ...player.weapon, weaponLevel: weapon.weaponLevel, attack: weapon.attack };
      }
      const attack = bossPlayerAttack(player, event.config, roll);
      if (!isForgeWeaponType(player.weapon.weaponType)) throw new BossError("未対応の武器です。");
      const combo = bossCombo(player.weapon.weaponType, attack.damage, bossHp, roll);
      damage = combo.damage;
      bossHp -= damage; critical = attack.critical; skill = attack.skill;
      const narration = bossAttackPresentation(player.weapon.weaponType, event.bossType, combo,
        { critical, finished: bossHp === 0, maxHp: battle.maxHp, effects: player.effects }, roll);
      presentation = narration.presentation;
      player.effects = narration.effects;
      player.attackCount++;
      player.damage += damage;
      if (!Number.isSafeInteger(player.damage)) throw new BossError("累計ダメージが上限に達しました。管理者にお問い合わせください。");
      if (attack.shield) player.effects = { ...player.effects, shield: true };
      if (attack.supportHeal) {
        const ally = [...players].filter(p => p.hp > 0 && p.hp < p.maxHp).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
        if (ally) {
          const recovery = Math.min(ally.maxHp - ally.hp, Math.max(1, Math.floor(ally.maxHp * 0.2)) * (event.config.special === "double_heal" ? 2 : 1));
          ally.hp += recovery;
          messages.push(`ヒール：${ally.displayName}のHPが${recovery}回復`);
        }
      }
    } else {
      healed = bossHealing(player, event.config);
      if (healed <= 0) throw new BossError("HPが満タンです。料金は消費していません。");
      player.hp += healed;
    }
    // Free attacks never create or mutate a wallet, even for legacy paid battles.
    let [wallet] = await tx.select().from(walletsTable)
      .where(and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId)));
    if (action === "heal") {
      [wallet] = await tx.update(walletsTable)
        .set({ balance: sql`${walletsTable.balance} - ${paid}`, updatedAt: now })
        .where(and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId),
          sql`${walletsTable.balance} >= ${paid}`)).returning();
      if (!wallet) throw new BossError("残高が不足しています。HPとクールタイムは変更していません。");
    }
    player.effects = { ...player.effects, [readyKey]: now.getTime() + bossCooldownSeconds(event.config, action) * 1000 };
    const actionCount = battle.actionCount + 1;
    let counterTurn = battle.counterTurn;
    if (bossHp > 0 && actionCount % event.config.counterEvery === 0) {
      counterTurn++;
      const counter = bossCounter(event.bossType, bossHp, battle.maxHp, counterTurn, players, event.config, roll);
      bossHp = counter.hp;
      players = counter.fighters.map(p => ({ ...players.find(old => old.userId === p.userId)!, ...p }));
      messages.push(...counter.messages);
    }
    for (const p of players) {
      await tx.update(members).set({ hp: p.hp, damage: p.damage, attackCount: p.attackCount, effects: p.effects, weapon: p.weapon })
        .where(and(eq(members.battleId, battle.id), eq(members.userId, p.userId)));
    }
    const [updated] = await tx.update(battles).set({ currentHp: bossHp, actionCount, counterTurn }).where(eq(battles.id, battle.id)).returning();
    await tx.insert(transactionsTable).values({ guildId, userId, amount: -paid,
      reason: `ボス${action === "attack" ? "攻撃" : "回復"} ${battle.id}`, sessionKey: `boss-action:${id}` });
    let finished = updated!;
    if (bossHp <= 0) finished = await finishBossBattle(tx, finished, "won", "討伐成功", now);
    else if (players.every(p => p.hp <= 0)) finished = await finishBossBattle(tx, finished, "failed", "全員が戦闘不能", now);
    const result: BossActionResult = {
      battleId: battle.id, mode: battle.mode, state: finished.status, bossHp,
      damage, healed, critical, skill, paid, balance: wallet?.balance ?? 0,
      userHp: players.find(p => p.userId === userId)?.hp, messages,
      ...(presentation ? { presentation } : {}),
    };
    if (finished.status === "won") {
      const reward = finished.rewards.find(r => r.userId === userId)?.amount ?? 0;
      result.balance = (wallet?.balance ?? 0) + reward;
      messages.push(`討伐成功！報酬合計はパーティ人数で均等分配し、残高へ加算済みです。`);
    }
    return recordBossAction(tx, id, guildId, userId, action, result);
  });
}
