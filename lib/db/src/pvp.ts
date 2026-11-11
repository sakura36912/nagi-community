import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "./index";
import { pvpDuelsTable as duels, pvpActiveUsersTable as slots, pvpActionsTable as actions, type PvpDuel, type RpgCard } from "./schema/pvp";
import { walletsTable, transactionsTable } from "./schema/economy";
import { forgeWeaponsTable } from "./schema/forge";
import { bossFeesTable } from "./schema/boss";
import { FORGE_MAX_INT, forgeRoll, isForgeWeaponType } from "./forgeRules";
import { PvpError, pvpCombat } from "./pvpRules";
import { queueRpgCard } from "./rpgNotices";
import type { BossFighter } from "./bossRules";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Action = "accept" | "decline" | "cancel" | "surrender" | "attack" | "heal";
async function withGuild<T>(guildId: string, work: (tx: Tx) => Promise<T>) {
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["pvp-guild", guildId])}, 0))`);
    return work(tx);
  });
}
const walletWhere = (guildId: string, userId: string) => and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId));
async function fighter(tx: Tx, guildId: string, userId: string): Promise<BossFighter> {
  const [weapon] = await tx.select().from(forgeWeaponsTable).where(and(eq(forgeWeaponsTable.guildId, guildId),
    eq(forgeWeaponsTable.userId, userId))).for("share");
  const [wallet] = await tx.select().from(walletsTable).where(walletWhere(guildId, userId));
  if (!weapon || !isForgeWeaponType(weapon.weaponType)) throw new PvpError("両者とも先に武器を選択してください。");
  if (!wallet || wallet.balance < 1) throw new PvpError("参加時の所持金は1以上必要です。");
  return {
    userId, displayName: userId, hp: wallet.balance, maxHp: wallet.balance, damage: 0, attackCount: 0,
    effects: { shield: false, bleedTicks: 0, vulnerableTicks: 0 },
    weapon: { weaponType: weapon.weaponType, weaponLevel: weapon.weaponLevel, attack: weapon.attack,
      defense: weapon.defense, roleMultiplier: 1 },
  };
}
function integer(value: number, min: number, max: number) {
  if (!Number.isInteger(value) || value < min || value > max) throw new PvpError(`${min}〜${max}の整数で指定してください。`);
}
export function pvpPublicCard(duel: PvpDuel): RpgCard {
  const state = duel.state;
  const status = duel.status as "pending" | "active" | "finished";
  const label = status === "pending" ? "対戦受付中" : status === "active" ? "戦闘中" : state.winnerId ? "決着" : "終了・賞金返却";
  return {
    title: `⚔️ 懸賞金PvP — ${label}`, color: status === "finished" ? 0x2ecc71 : 0xd49b43,
    description: [
      `募集者 <@${duel.hostId}> vs <@${duel.opponentId}>`,
      `賞金：**$${duel.prize.toLocaleString("ja-JP")}**（募集者のみ負担・預かり済み）`,
      ...state.lines,
      ...(state.winnerId ? [`🏆 勝者：<@${state.winnerId}>`,
        state.winnerId === duel.hostId ? "賞金は募集者へ返却済みです。" : "賞金は勝者の銀行残高へ加算済みです。"] : []),
      ...(!state.winnerId && status === "finished" ? ["預かり賞金は募集者へ返却済みです。"] : []),
      ...(state.reason ? [state.reason] : []),
      status === "pending"
        ? `相手の承諾期限：<t:${Math.floor(duel.expiresAt.getTime() / 1000)}:R>\n相手の賭け金は不要です。両者とも本船員・武器・所持金1以上が必要です。`
        : status === "active" ? `終了：<t:${Math.floor(duel.expiresAt.getTime() / 1000)}:R>` : "",
    ].filter(Boolean).join("\n"),
    fields: [
      ...state.players.map(p => ({ name: p.userId === duel.hostId ? "募集者HP" : "対戦相手HP",
        value: `<@${p.userId}>\n${p.hp.toLocaleString("ja-JP")} / ${p.maxHp.toLocaleString("ja-JP")}`, inline: true })),
      { name: "戦闘ルール", value: `攻撃：無料・5秒間隔\n回復：${state.healCost ? `$${state.healCost.toLocaleString("ja-JP")}・30秒間隔` : "料金未設定のため使用不可"}・最大HPの10%\n時間切れは引き分け・賞金返却。HP減少で所持金は減りません。` },
    ],
    duelId: duel.id, phase: status,
  };
}
async function save(tx: Tx, duel: PvpDuel, noticeId: string) {
  await tx.update(duels).set({ state: duel.state, status: duel.status, expiresAt: duel.expiresAt }).where(eq(duels.id, duel.id));
  await queueRpgCard(tx, noticeId, duel.guildId, duel.channelId, pvpPublicCard(duel));
}
/** Conditional balance update, ledger, terminal state and slot release are one transaction. */
async function finish(tx: Tx, duel: PvpDuel, reason: string, now: Date, winnerId?: string) {
  if (duel.status === "finished") return;
  const recipient = winnerId ?? duel.hostId;
  await tx.insert(walletsTable).values({ guildId: duel.guildId, userId: recipient, balance: 0 }).onConflictDoNothing();
  const [wallet] = await tx.update(walletsTable).set({ balance: sql`${walletsTable.balance} + ${duel.prize}`, updatedAt: now })
    .where(and(walletWhere(duel.guildId, recipient), sql`${walletsTable.balance} <= ${FORGE_MAX_INT - duel.prize}`)).returning();
  if (!wallet) throw new PvpError("残高上限により賞金を精算できません。賞金は預かり状態を維持しています。管理者に残高の確認を依頼してください。");
  await tx.insert(transactionsTable).values({ guildId: duel.guildId, userId: recipient, amount: duel.prize,
    reason: winnerId && winnerId !== duel.hostId ? "懸賞金PvP 勝利賞金" : "懸賞金PvP 賞金返却",
    sessionKey: `pvp-settle:${duel.id}` });
  duel.status = "finished"; duel.state.winnerId = winnerId; duel.state.reason = reason;
  await tx.delete(slots).where(and(eq(slots.guildId, duel.guildId), eq(slots.duelId, duel.id)));
}
export async function advancePvpGuild(guildId: string, now = new Date()) {
  const rows = await db.select({ id: duels.id }).from(duels).where(and(eq(duels.guildId, guildId),
    inArray(duels.status, ["pending", "active"]), lte(duels.expiresAt, now)));
  const failures: { duelId: string; error: unknown }[] = [];
  // One overflow must not roll back unrelated players' refunds in this guild.
  for (const row of rows) {
    try {
      await withGuild(guildId, async tx => {
        const [duel] = await tx.select().from(duels).where(eq(duels.id, row.id));
        if (!duel || duel.status === "finished" || duel.expiresAt > now) return;
        await finish(tx, duel, duel.status === "pending" ? "承諾期限終了・対戦不成立" : "制限時間終了・引き分け", now);
        await save(tx, duel, `pvp-expire:${duel.id}`);
      });
    } catch (error) {
      failures.push({ duelId: row.id, error });
    }
  }
  return failures;
}
export async function createPvpDuel(input: {
  id: string; guildId: string; channelId: string; hostId: string; opponentId: string; prize: number; durationMinutes: number;
}, now = new Date()) {
  integer(input.prize, 1, FORGE_MAX_INT); integer(input.durationMinutes, 1, 180);
  if (input.hostId === input.opponentId) throw new PvpError("自分自身とは対戦できません。");
  await advancePvpGuild(input.guildId, now);
  return withGuild(input.guildId, async tx => {
    const [existing] = await tx.select().from(duels).where(eq(duels.id, input.id));
    if (existing) {
      if (existing.guildId !== input.guildId || existing.hostId !== input.hostId || existing.opponentId !== input.opponentId
        || existing.prize !== input.prize || existing.channelId !== input.channelId) throw new PvpError("操作の識別情報が一致しません。");
      return existing;
    }
    const busy = await tx.select().from(slots).where(and(eq(slots.guildId, input.guildId),
      inArray(slots.userId, [input.hostId, input.opponentId])));
    if (busy.length) throw new PvpError("どちらかが既にPvPの受付・対戦中です。");
    // Host HP uses the pre-deposit wallet, so posting a prize itself does not reduce maximum HP.
    const host = await fighter(tx, input.guildId, input.hostId);
    await fighter(tx, input.guildId, input.opponentId);
    const [wallet] = await tx.update(walletsTable).set({ balance: sql`${walletsTable.balance} - ${input.prize}`, updatedAt: now })
      .where(and(walletWhere(input.guildId, input.hostId), sql`${walletsTable.balance} >= ${input.prize}`)).returning();
    if (!wallet) throw new PvpError("募集者の賞金残高が不足しています。");
    await tx.insert(transactionsTable).values({ guildId: input.guildId, userId: input.hostId, amount: -input.prize,
      reason: "懸賞金PvP 賞金預かり", sessionKey: `pvp-escrow:${input.id}` });
    const [fees] = await tx.select().from(bossFeesTable).where(eq(bossFeesTable.guildId, input.guildId));
    const [duel] = await tx.insert(duels).values({
      ...input, status: "pending", expiresAt: new Date(now.getTime() + 120_000),
      state: { players: [host], healCost: fees?.healCost && fees.healCost > 0 ? fees.healCost : null,
        durationMinutes: input.durationMinutes, lines: ["相手の承諾後に対戦を開始します。承諾前は募集者が取り消せます。"] },
    }).returning();
    await tx.insert(slots).values([input.hostId, input.opponentId].map(userId => ({ guildId: input.guildId, userId, duelId: input.id })));
    await queueRpgCard(tx, `pvp-create:${input.id}`, input.guildId, input.channelId, pvpPublicCard(duel!));
    return duel!;
  });
}
export async function getPvpDuel(guildId: string, userId: string) {
  const [slot] = await db.select().from(slots).where(and(eq(slots.guildId, guildId), eq(slots.userId, userId)));
  if (!slot) throw new PvpError("受付中・対戦中のPvPがありません。");
  const [duel] = await db.select().from(duels).where(and(eq(duels.id, slot.duelId), eq(duels.guildId, guildId)));
  if (!duel) throw new PvpError("対戦情報が見つかりません。");
  return duel;
}
export async function performPvpAction(
  id: string, guildId: string, userId: string, duelId: string, action: Action, now = new Date(), roll = forgeRoll,
) {
  await advancePvpGuild(guildId, now);
  return withGuild(guildId, async tx => {
    const [duel] = await tx.select().from(duels).where(and(eq(duels.id, duelId), eq(duels.guildId, guildId)));
    if (!duel || ![duel.hostId, duel.opponentId].includes(userId)) throw new PvpError("この対戦は操作できません。");
    const [previous] = await tx.select().from(actions).where(eq(actions.id, id));
    if (previous) {
      if (previous.guildId !== guildId || previous.userId !== userId || previous.duelId !== duelId || previous.action !== action) {
        throw new PvpError("操作の識別情報が一致しません。");
      }
      return { duel, repeated: true };
    }
    if (duel.status === "finished") throw new PvpError("この対戦は既に終了しています。賞金は精算済みです。");
    if (duel.expiresAt <= now) throw new PvpError("対戦期限は終了しました。賞金の返却を再試行中です。管理者に残高上限などの確認を依頼してください。");
    if (["accept", "decline", "cancel"].includes(action)) {
      if (duel.status !== "pending") throw new PvpError("開始後は取り消せません。終了する場合は降参してください。");
      if (action === "cancel" ? userId !== duel.hostId : userId !== duel.opponentId) throw new PvpError("このボタンは本人のみ操作できます。");
      if (action === "accept") {
        duel.state.players.push(await fighter(tx, guildId, userId));
        duel.status = "active"; duel.expiresAt = new Date(now.getTime() + duel.state.durationMinutes * 60_000);
        duel.state.lines = ["対戦開始！ 両者が攻撃・回復ボタン、または /pvp コマンドで操作できます。"];
      } else {
        await finish(tx, duel, action === "cancel" ? "募集者が取り消しました。" : "相手が辞退しました。", now);
      }
    } else {
      if (duel.status !== "active") throw new PvpError("相手の承諾を待ってください。");
      if (action === "surrender") {
        await finish(tx, duel, `<@${userId}>が降参しました。`, now, userId === duel.hostId ? duel.opponentId : duel.hostId);
        duel.state.lines = [];
      } else {
        if (action !== "attack" && action !== "heal") throw new PvpError("未対応の操作です。");
        if (action === "heal" && !duel.state.healCost) throw new PvpError("回復料金が未設定のため回復できません。管理者に設定を依頼してください。");
        const player = duel.state.players.find(p => p.userId === userId)!;
        const [weapon] = await tx.select().from(forgeWeaponsTable).where(and(eq(forgeWeaponsTable.guildId, guildId),
          eq(forgeWeaponsTable.userId, userId))).for("share");
        if (weapon?.weaponType === player.weapon.weaponType) {
          player.weapon.attack = weapon.attack; player.weapon.weaponLevel = weapon.weaponLevel;
        }
        const combat = pvpCombat(duel.state.players, userId, action, now, roll);
        if (combat.paidHeal) {
          const cost = duel.state.healCost!;
          const [wallet] = await tx.update(walletsTable).set({ balance: sql`${walletsTable.balance} - ${cost}`, updatedAt: now })
            .where(and(walletWhere(guildId, userId), sql`${walletsTable.balance} >= ${cost}`)).returning();
          if (!wallet) throw new PvpError("残高不足です。回復・課金・クールタイム変更はしていません。");
          await tx.insert(transactionsTable).values({ guildId, userId, amount: -cost, reason: "懸賞金PvP 回復",
            sessionKey: `pvp-heal:${id}` });
        }
        duel.state.players = combat.players;
        duel.state.lines = [`<@${userId}>の${action === "attack" ? "攻撃" : "回復"}！`, ...combat.lines];
        if (combat.winnerId) await finish(tx, duel, "相手のHPを0にしました。", now, combat.winnerId);
      }
    }
    await tx.insert(actions).values({ id, guildId, userId, duelId, action });
    await save(tx, duel, `pvp-action:${id}`);
    return { duel, repeated: false };
  });
}
export async function duePvpGuilds(now = new Date()) {
  const rows = await db.selectDistinct({ guildId: duels.guildId }).from(duels)
    .where(and(inArray(duels.status, ["pending", "active"]), lte(duels.expiresAt, now))).limit(100);
  return rows.map(row => row.guildId);
}
