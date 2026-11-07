import { and, eq, sql } from "drizzle-orm";
import { db, transactionsTable, walletsTable } from "@workspace/db";

// Both amount and balance are PostgreSQL INTEGER columns.
export const MAX_GRANT_AMOUNT = 2_147_483_647;

/** A ledger reservation and wallet credit commit or roll back together. */
export async function grantAdminCurrency(
  guildId: string,
  userId: string,
  adminId: string,
  amount: number,
  interactionId: string,
): Promise<{ balance: number; duplicate: boolean }> {
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_GRANT_AMOUNT) {
    throw new Error("付与額は1〜2,147,483,647の整数で指定してください。");
  }
  return db.transaction(async (tx) => {
    const [reservation] = await tx.insert(transactionsTable).values({
      guildId,
      userId,
      amount,
      reason: "admin-give",
      relatedUserId: adminId,
      sessionKey: `admin-give:${guildId}:${interactionId}`,
    }).onConflictDoNothing().returning();

    if (!reservation) {
      const [wallet] = await tx.select().from(walletsTable).where(and(
        eq(walletsTable.guildId, guildId),
        eq(walletsTable.userId, userId),
      ));
      if (!wallet) throw new Error("処理済みの付与に対応する残高を確認できません。");
      return { balance: wallet.balance, duplicate: true };
    }

    await tx.insert(walletsTable).values({ guildId, userId, balance: 0 }).onConflictDoNothing();
    const [wallet] = await tx.update(walletsTable).set({
      balance: sql`${walletsTable.balance} + ${amount}`,
    }).where(and(
      eq(walletsTable.guildId, guildId),
      eq(walletsTable.userId, userId),
      sql`${walletsTable.balance} <= ${MAX_GRANT_AMOUNT - amount}`,
    )).returning();
    if (!wallet) throw new Error("付与後の残高が上限を超えるため、付与していません。");
    return { balance: wallet.balance, duplicate: false };
  });
}
