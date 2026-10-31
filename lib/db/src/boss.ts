import { and, eq, inArray } from "drizzle-orm";
import { db } from "./index";
import { forgeWeaponsTable } from "./schema/forge";
import { bossFeesTable as fees, bossEventsTable as events, bossBattlesTable as battles,
  bossActiveUsersTable as active, bossMembersTable as members, bossJoinRequestsTable as requests,
  bossActionsTable as actions } from "./schema/boss";
import { BossError, bossInteger, validateBossConfig, type BossConfig, type BossMode, type BossType } from "./bossRules";
import { ensureBossSchema } from "./bossSchema";
import { advanceBossGuild, withBossGuild, activeBossEvent, bossMembers, previousBossAction, recordBossAction, finishBossBattle } from "./bossStore";
import { isForgeWeaponType } from "./forgeRules";
export { advanceBossGuild } from "./bossStore";

export async function getBossFees(guildId: string) {
  await ensureBossSchema();
  const [row] = await db.select().from(fees).where(eq(fees.guildId, guildId));
  return { attackCost: 0, healCost: row?.healCost ?? null };
}
export async function configureBossFees(guildId: string, patch: { attackCost?: number; healCost?: number }) {
  if (patch.attackCost !== undefined) bossInteger(patch.attackCost);
  if (patch.healCost !== undefined) bossInteger(patch.healCost);
  if ((patch.attackCost ?? 0) !== 0) {
    throw new BossError("攻撃は無料です。攻撃料金は0以外に設定できません。");
  }
  if (patch.healCost === 0) {
    throw new BossError("回復料金は1以上で設定してください。");
  }
  if (patch.attackCost === undefined && patch.healCost === undefined) return getBossFees(guildId);
  return withBossGuild(guildId, async tx => {
    const [row] = await tx.insert(fees).values({ guildId, ...patch })
      .onConflictDoUpdate({ target: fees.guildId, set: patch }).returning();
    return row!;
  });
}
export async function createBossEvent(id: string, guildId: string, channelId: string, bossType: BossType, config: BossConfig, now = new Date()) {
  validateBossConfig(bossType, config);
  await advanceBossGuild(guildId, now);
  return withBossGuild(guildId, async tx => {
    const [previous] = await tx.select().from(events).where(eq(events.id, id));
    if (previous) {
      if (previous.guildId !== guildId) throw new BossError("開催情報が一致しません。");
      return previous;
    }
    if (await activeBossEvent(tx, guildId)) throw new BossError("このサーバーでは既にボスイベントが開催中です。");
    const [event] = await tx.insert(events).values({ id, guildId, channelId, bossType, config, createdAt: now,
      endsAt: new Date(now.getTime() + config.durationSeconds * 1000) }).returning();
    return event!;
  });
}
export async function endBossEvent(guildId: string, now = new Date(), operation?: { id: string; actorId: string }) {
  await advanceBossGuild(guildId, now);
  return withBossGuild(guildId, async tx => {
    if (operation) {
      const previous = await previousBossAction(tx, `end:${operation.id}`, guildId, operation.actorId, "end");
      if (previous) {
        const [ended] = await tx.select().from(events).where(eq(events.id, previous.battleId));
        return ended!;
      }
    }
    const event = await activeBossEvent(tx, guildId);
    if (!event) throw new BossError("開催中のイベントがありません。");
    await tx.update(events).set({ status: "ended" }).where(eq(events.id, event.id));
    const open = await tx.select().from(battles).where(and(eq(battles.eventId, event.id), inArray(battles.status, ["waiting", "active"])));
    for (const battle of open) await finishBossBattle(tx, battle, battle.status === "waiting" ? "cancelled" : "failed", "管理者による強制終了", now);
    if (operation) await recordBossAction(tx, `end:${operation.id}`, guildId, operation.actorId, "end", {
      battleId: event.id, mode: "solo", state: "cancelled", bossHp: 0, messages: ["管理者によるイベント終了"],
    });
    return event;
  });
}
export async function getBossInfo(guildId: string, now = new Date()) {
  await advanceBossGuild(guildId, now);
  const event = await activeBossEvent(db, guildId);
  if (!event) return undefined;
  const open = await db.select().from(battles).where(and(eq(battles.eventId, event.id), inArray(battles.status, ["waiting", "active"])));
  const players = open.length ? await db.select().from(members).where(inArray(members.battleId, open.map(b => b.id))) : [];
  return { event, battles: open, members: players };
}
export async function createBossJoinRequest(id: string, guildId: string, userId: string, mode: BossMode, now = new Date()) {
  if (!["solo", "party"].includes(mode)) throw new BossError("参加モードが不正です。");
  await advanceBossGuild(guildId, now);
  return withBossGuild(guildId, async tx => {
    const event = await activeBossEvent(tx, guildId);
    if (!event || event.endsAt <= now) throw new BossError("開催中のイベントがありません。");
    const [busy] = await tx.select().from(active).where(and(eq(active.guildId, guildId), eq(active.userId, userId)));
    if (busy) throw new BossError("既に別の討伐へ参加中です。終了してから参加してください。");
    const [weapon] = await tx.select().from(forgeWeaponsTable).where(and(eq(forgeWeaponsTable.guildId, guildId), eq(forgeWeaponsTable.userId, userId)));
    if (!weapon) throw new BossError("参加には武器が必要です。先に /武器選択 を使用してください。");
    const [lobby] = mode === "party" ? await tx.select().from(battles).where(and(eq(battles.eventId, event.id), eq(battles.status, "waiting"))) : [];
    const [currentFees] = await tx.select().from(fees).where(eq(fees.guildId, guildId));
    // Zero is a historical storage sentinel: attacks can start, healing stays disabled.
    const attackCost = 0, healCost = lobby?.healCost ?? currentFees?.healCost ?? 0;
    const [request] = await tx.insert(requests).values({ id, guildId, userId, eventId: event.id, mode,
      battleId: lobby?.id ?? null, attackCost, healCost, expiresAt: new Date(Math.min(event.endsAt.getTime(), now.getTime() + 120000)) }).returning();
    return { request: request!, event, lobby };
  });
}
export async function confirmBossJoin(
  id: string, guildId: string, userId: string, displayName: string, roleIds: string[], now = new Date(),
) {
  await advanceBossGuild(guildId, now);
  return withBossGuild(guildId, async tx => {
    const previous = await previousBossAction(tx, `join:${id}`, guildId, userId, "join");
    if (previous) return previous;
    const [request] = await tx.select().from(requests).where(eq(requests.id, id));
    if (!request || request.guildId !== guildId || request.userId !== userId) throw new BossError("この参加確認は操作できません。");
    if (request.expiresAt <= now) throw new BossError("参加確認の期限切れです。/参加 からやり直してください。");
    const event = await activeBossEvent(tx, guildId);
    if (!event || event.id !== request.eventId || event.endsAt <= now) throw new BossError("このイベントの受付は終了しています。");
    const [busy] = await tx.select().from(active).where(and(eq(active.guildId, guildId), eq(active.userId, userId)));
    if (busy) throw new BossError("既に討伐へ参加中です。");
    const [weapon] = await tx.select().from(forgeWeaponsTable).where(and(eq(forgeWeaponsTable.guildId, guildId), eq(forgeWeaponsTable.userId, userId))).for("share");
    if (!weapon || !isForgeWeaponType(weapon.weaponType)) throw new BossError("使用可能な武器がありません。");
    let [battle] = request.mode === "party" ? await tx.select().from(battles).where(and(eq(battles.eventId, event.id), eq(battles.status, "waiting"))) : [];
    if (request.battleId && battle?.id !== request.battleId) throw new BossError("確認中にパーティ受付が終了しました。/参加 から確認し直してください。");
    if (battle) {
      if (!battle.lobbyEndsAt || battle.lobbyEndsAt <= now || (await bossMembers(tx, battle.id)).length >= 4) throw new BossError("このパーティの受付は終了しています。");
      if (battle.healCost !== request.healCost) throw new BossError("回復料金が変わりました。/参加 から確認し直してください。");
    } else {
      const [currentFees] = await tx.select().from(fees).where(eq(fees.guildId, guildId));
      if ((currentFees?.healCost ?? 0) !== request.healCost) throw new BossError("回復料金が変更されました。/参加 から確認し直してください。");
      const hp = request.mode === "solo" ? event.config.soloHp : event.config.partyHp;
      const [created] = await tx.insert(battles).values({ id, eventId: event.id, guildId, mode: request.mode,
        status: request.mode === "solo" ? "active" : "waiting", maxHp: hp, currentHp: hp,
        attackCost: 0, healCost: request.healCost,
        startedAt: request.mode === "solo" ? now : null,
        lobbyEndsAt: request.mode === "party" ? new Date(Math.min(event.endsAt.getTime(), now.getTime() + event.config.lobbySeconds * 1000)) : null,
        endsAt: event.endsAt, noticeNextAt: now }).returning();
      battle = created!;
    }
    await tx.insert(members).values({ battleId: battle.id, guildId, userId, displayName: displayName.slice(0, 80),
      hp: event.config.playerHp, maxHp: event.config.playerHp,
      weapon: { weaponType: weapon.weaponType, weaponLevel: weapon.weaponLevel, attack: weapon.attack,
        defense: weapon.defense, roleMultiplier: event.config.bonusRoleId && roleIds.includes(event.config.bonusRoleId) ? event.config.roleMultiplier : 1 } });
    await tx.insert(active).values({ guildId, userId, battleId: battle.id });
    if (battle.mode === "party" && (await bossMembers(tx, battle.id)).length === 4) {
      const [started] = await tx.update(battles).set({ status: "active", startedAt: now, noticeNextAt: now })
        .where(eq(battles.id, battle.id)).returning();
      battle = started!;
    }
    return recordBossAction(tx, `join:${id}`, guildId, userId, "join", {
      battleId: battle.id, mode: battle.mode, state: battle.status, bossHp: battle.currentHp,
      messages: [battle.status === "waiting" ? "パーティ受付中です。4人で即開始、期限時に2〜3人なら開始します。1人ならキャンセルされます。" : "討伐開始！ /攻撃・/回復 が使用できます。"],
    });
  });
}

export async function cancelBossJoinRequest(id: string, guildId: string, userId: string) {
  return withBossGuild(guildId, async tx => {
    const [processed] = await tx.select().from(actions).where(eq(actions.id, `join:${id}`));
    if (processed) throw new BossError("この参加は確定済みです。討伐中の離脱はできません。");
    const [request] = await tx.select().from(requests).where(eq(requests.id, id));
    if (!request || request.guildId !== guildId || request.userId !== userId) throw new BossError("この参加確認は操作できません。");
    await tx.delete(requests).where(eq(requests.id, id));
  });
}
