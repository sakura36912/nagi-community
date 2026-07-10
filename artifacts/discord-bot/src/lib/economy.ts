import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  walletsTable,
  shopItemsTable,
  inventoryItemsTable,
  transactionsTable,
  type Wallet,
  type ShopItem,
} from "@workspace/db";

export const CURRENCY_NAME = "円";
export const DAILY_AMOUNT = 500;
export const DAILY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export async function getOrCreateWallet(
  guildId: string,
  userId: string,
): Promise<Wallet> {
  const [existing] = await db
    .select()
    .from(walletsTable)
    .where(and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId)));

  if (existing) {
    return existing;
  }

  const [created] = await db
    .insert(walletsTable)
    .values({ guildId, userId, balance: 0 })
    .onConflictDoNothing()
    .returning();

  if (created) {
    return created;
  }

  // Row was created concurrently by another interaction; fetch it.
  const [wallet] = await db
    .select()
    .from(walletsTable)
    .where(and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId)));

  if (!wallet) {
    throw new Error("Failed to create or fetch wallet");
  }

  return wallet;
}

export async function recordTransaction(
  guildId: string,
  userId: string,
  amount: number,
  reason: string,
  relatedUserId?: string,
): Promise<void> {
  await db.insert(transactionsTable).values({
    guildId,
    userId,
    amount,
    reason,
    relatedUserId: relatedUserId ?? null,
  });
}

export async function claimDaily(
  guildId: string,
  userId: string,
): Promise<{ ok: true; balance: number } | { ok: false; msRemaining: number }> {
  await getOrCreateWallet(guildId, userId);
  const now = new Date();
  const cutoff = new Date(now.getTime() - DAILY_COOLDOWN_MS);

  // Conditional update: only succeeds if the cooldown has actually elapsed,
  // checked atomically in the same statement to prevent concurrent double-claims.
  const [updated] = await db
    .update(walletsTable)
    .set({
      balance: sql`${walletsTable.balance} + ${DAILY_AMOUNT}`,
      lastDailyAt: now,
    })
    .where(
      and(
        eq(walletsTable.guildId, guildId),
        eq(walletsTable.userId, userId),
        sql`(${walletsTable.lastDailyAt} IS NULL OR ${walletsTable.lastDailyAt} <= ${cutoff})`,
      ),
    )
    .returning();

  if (!updated) {
    const [wallet] = await db
      .select()
      .from(walletsTable)
      .where(and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId)));

    const elapsed = wallet?.lastDailyAt ? now.getTime() - wallet.lastDailyAt.getTime() : DAILY_COOLDOWN_MS;
    return { ok: false, msRemaining: Math.max(DAILY_COOLDOWN_MS - elapsed, 0) };
  }

  await recordTransaction(guildId, userId, DAILY_AMOUNT, "daily");

  return { ok: true, balance: updated.balance };
}

export async function transfer(
  guildId: string,
  fromUserId: string,
  toUserId: string,
  amount: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (amount <= 0) {
    return { ok: false, reason: "金額は1以上を指定してください。" };
  }
  if (fromUserId === toUserId) {
    return { ok: false, reason: "自分自身には送金できません。" };
  }

  await getOrCreateWallet(guildId, fromUserId);
  await getOrCreateWallet(guildId, toUserId);

  // Debit is conditional on sufficient balance, checked atomically in the
  // same statement so concurrent transfers can't overdraw the sender.
  const insufficientFunds = await db.transaction(async (tx) => {
    const [debited] = await tx
      .update(walletsTable)
      .set({ balance: sql`${walletsTable.balance} - ${amount}` })
      .where(
        and(
          eq(walletsTable.guildId, guildId),
          eq(walletsTable.userId, fromUserId),
          sql`${walletsTable.balance} >= ${amount}`,
        ),
      )
      .returning();

    if (!debited) {
      return true;
    }

    await tx
      .update(walletsTable)
      .set({ balance: sql`${walletsTable.balance} + ${amount}` })
      .where(and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, toUserId)));

    return false;
  });

  if (insufficientFunds) {
    const sender = await getOrCreateWallet(guildId, fromUserId);
    return { ok: false, reason: `残高が不足しています(所持: ${sender.balance}${CURRENCY_NAME})。` };
  }

  await recordTransaction(guildId, fromUserId, -amount, "transfer", toUserId);
  await recordTransaction(guildId, toUserId, amount, "transfer", fromUserId);

  return { ok: true };
}

export async function getLeaderboard(
  guildId: string,
  limit = 10,
): Promise<Wallet[]> {
  return db
    .select()
    .from(walletsTable)
    .where(eq(walletsTable.guildId, guildId))
    .orderBy(desc(walletsTable.balance))
    .limit(limit);
}

export async function listShopItems(guildId: string): Promise<ShopItem[]> {
  return db
    .select()
    .from(shopItemsTable)
    .where(eq(shopItemsTable.guildId, guildId))
    .orderBy(shopItemsTable.price);
}

export async function addShopItem(
  guildId: string,
  name: string,
  price: number,
  description: string | null,
): Promise<ShopItem> {
  const [item] = await db
    .insert(shopItemsTable)
    .values({ guildId, name, price, description })
    .returning();

  if (!item) {
    throw new Error("Failed to create shop item");
  }

  return item;
}

export async function removeShopItem(
  guildId: string,
  itemId: number,
): Promise<boolean> {
  const deleted = await db
    .delete(shopItemsTable)
    .where(and(eq(shopItemsTable.guildId, guildId), eq(shopItemsTable.id, itemId)))
    .returning();

  return deleted.length > 0;
}

export async function buyItem(
  guildId: string,
  userId: string,
  itemId: number,
): Promise<{ ok: true; item: ShopItem } | { ok: false; reason: string }> {
  const [item] = await db
    .select()
    .from(shopItemsTable)
    .where(and(eq(shopItemsTable.guildId, guildId), eq(shopItemsTable.id, itemId)));

  if (!item) {
    return { ok: false, reason: "そのアイテムは見つかりませんでした。" };
  }

  await getOrCreateWallet(guildId, userId);

  // Debit is conditional on sufficient balance, checked atomically in the
  // same statement so concurrent purchases can't overspend.
  const insufficientFunds = await db.transaction(async (tx) => {
    const [debited] = await tx
      .update(walletsTable)
      .set({ balance: sql`${walletsTable.balance} - ${item.price}` })
      .where(
        and(
          eq(walletsTable.guildId, guildId),
          eq(walletsTable.userId, userId),
          sql`${walletsTable.balance} >= ${item.price}`,
        ),
      )
      .returning();

    if (!debited) {
      return true;
    }

    // Rely on the (guildId, userId, shopItemId) unique constraint so
    // concurrent first-time purchases increment instead of duplicating rows.
    await tx
      .insert(inventoryItemsTable)
      .values({ guildId, userId, shopItemId: item.id, quantity: 1 })
      .onConflictDoUpdate({
        target: [
          inventoryItemsTable.guildId,
          inventoryItemsTable.userId,
          inventoryItemsTable.shopItemId,
        ],
        set: { quantity: sql`${inventoryItemsTable.quantity} + 1` },
      });

    return false;
  });

  if (insufficientFunds) {
    const wallet = await getOrCreateWallet(guildId, userId);
    return {
      ok: false,
      reason: `残高が不足しています(所持: ${wallet.balance}${CURRENCY_NAME}、必要: ${item.price}${CURRENCY_NAME})。`,
    };
  }

  await recordTransaction(guildId, userId, -item.price, `shop:${item.name}`);

  return { ok: true, item };
}

export async function listInventory(
  guildId: string,
  userId: string,
): Promise<Array<{ item: ShopItem; quantity: number }>> {
  const rows = await db
    .select({ item: shopItemsTable, quantity: inventoryItemsTable.quantity })
    .from(inventoryItemsTable)
    .innerJoin(shopItemsTable, eq(inventoryItemsTable.shopItemId, shopItemsTable.id))
    .where(and(eq(inventoryItemsTable.guildId, guildId), eq(inventoryItemsTable.userId, userId)));

  return rows;
}
