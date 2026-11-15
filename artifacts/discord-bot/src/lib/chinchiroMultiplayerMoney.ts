import { and, eq, sql } from "drizzle-orm";
import {
  CHINCHIRO_MAX_BET,
  db, walletsTable, transactionsTable, chinchiroTablePlayersTable,
  type ChinchiroTable, type ChinchiroTablePlayer,
} from "@workspace/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const LIMIT = 2_147_483_647;
const MAX_MULTIPLIER = 5;

/** Dealer receives a quarter of each participant's net loss, rounded down. */
export function dealerTransferAmount(net: Record<string, number>): number {
  return Object.values(net).reduce((total, change) =>
    total + Math.floor(Math.max(0, -change) / 4), 0);
}

/** Reserve the full worst-case loss before any dice are rolled. */
export function exposure(table: ChinchiroTable, playerId: string, bet: number, playerCount: number): number {
  const amount = bet * MAX_MULTIPLIER * (playerId === table.parentId ? playerCount - 1 : 1);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > LIMIT) {
    throw new Error("賭け金と参加人数から算出した最大損失額が上限を超えています。");
  }
  return amount;
}

async function changeBalance(tx: Tx, guildId: string, userId: string, amount: number) {
  if (!Number.isSafeInteger(amount) || Math.abs(amount) > LIMIT) throw new Error("残高変更額が不正です。");
  if (amount === 0) return;
  await tx.insert(walletsTable).values({ guildId, userId }).onConflictDoNothing();
  const [wallet] = await tx.update(walletsTable)
    .set({ balance: sql`${walletsTable.balance} + ${amount}` })
    .where(and(
      eq(walletsTable.guildId, guildId),
      eq(walletsTable.userId, userId),
      amount < 0
        ? sql`${walletsTable.balance} >= ${-amount}`
        : sql`${walletsTable.balance} <= ${LIMIT - amount}`,
    ))
    .returning({ balance: walletsTable.balance });
  if (!wallet) throw new Error(amount < 0 ? "賭け金を預かるための残高が不足しています。" : "払戻後の残高が上限を超えます。");
}

export async function reserveBet(
  tx: Tx, table: ChinchiroTable, player: ChinchiroTablePlayer, bet: number, playerCount: number,
) {
  if (!Number.isSafeInteger(bet) || bet < 1 || bet > CHINCHIRO_MAX_BET) {
    throw new Error("チンチロの最大掛け金は50,000です。");
  }
  const previous = player.bet ? exposure(table, player.userId, player.bet, playerCount) : 0;
  const next = exposure(table, player.userId, bet, playerCount);
  const delta = next - previous;
  if (table.testMode === 1 || delta === 0) return;
  await changeBalance(tx, table.guildId, player.userId, -delta);
  await tx.insert(transactionsTable).values({
    guildId: table.guildId, userId: player.userId, amount: -delta,
    reason: `複数人チンチロ #${table.id} 第${table.round}回 最大損失額の預かり（賭け: ${bet}）`,
    relatedUserId: table.ownerId,
  });
}

/** Called under the table row lock, while a round is still betting or rolling. */
export async function refundOpenRound(tx: Tx, table: ChinchiroTable) {
  if (table.testMode === 1 || !["betting", "rolling"].includes(table.status)) return;
  const players = await tx.select().from(chinchiroTablePlayersTable)
    .where(and(eq(chinchiroTablePlayersTable.tableId, table.id), eq(chinchiroTablePlayersTable.active, 1)));
  for (const player of players) {
    if (!player.bet) continue;
    const amount = exposure(table, player.userId, player.bet, players.length);
    await changeBalance(tx, table.guildId, player.userId, amount);
    await tx.insert(transactionsTable).values({
      guildId: table.guildId, userId: player.userId, amount,
      reason: `複数人チンチロ #${table.id} 第${table.round}回 中止返金`,
      relatedUserId: table.ownerId,
      sessionKey: `chinchiro-mp:${table.id}:${table.round}:refund:${player.userId}`,
    });
  }
}

/** Settlement and the FINISHED transition must commit in the same database transaction. */
export async function settleRound(
  tx: Tx, table: ChinchiroTable, players: ChinchiroTablePlayer[], net: Record<string, number>,
) {
  if (table.testMode === 1) return;
  let dealerIncome = 0;
  for (const player of players) {
    if (!player.bet) throw new Error("精算対象の賭け金がありません。");
    const reserved = exposure(table, player.userId, player.bet, players.length);
    const change = net[player.userId];
    if (!Number.isSafeInteger(change) || Math.abs(change) > reserved) {
      throw new Error("チンチロの結果金額が不正です。");
    }
    const loss = Math.max(0, -change);
    const credit = reserved - loss + Math.max(0, change);
    if (loss > reserved || !Number.isSafeInteger(credit) || credit > LIMIT) {
      throw new Error("預かり額を超える損失または払戻上限超過です。");
    }
    dealerIncome += Math.floor(loss / 4);
    if (credit > 0) {
      await changeBalance(tx, table.guildId, player.userId, credit);
      await tx.insert(transactionsTable).values({
        guildId: table.guildId, userId: player.userId, amount: credit,
        reason: `複数人チンチロ #${table.id} 第${table.round}回 精算（損益: ${change}）`,
        relatedUserId: table.ownerId,
        sessionKey: `chinchiro-mp:${table.id}:${table.round}:payout:${player.userId}`,
      });
    }
  }
  if (dealerIncome > 0) {
    if (dealerIncome > LIMIT) throw new Error("ディーラーの受取額が上限を超えています。");
    await changeBalance(tx, table.guildId, table.ownerId, dealerIncome);
    await tx.insert(transactionsTable).values({
      guildId: table.guildId, userId: table.ownerId, amount: dealerIncome,
      reason: `複数人チンチロ #${table.id} 第${table.round}回 敗者負け額の25%受取`,
      sessionKey: `chinchiro-mp:${table.id}:${table.round}:dealer`,
    });
  }
}