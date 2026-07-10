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
  const wallet = await getOrCreateWallet(guildId, userId);
  const now = Date.now();

  if (wallet.lastDailyAt) {
    const elapsed = now - wallet.lastDailyAt.getTime();
    if (elapsed < DAILY_COOLDOWN_MS) {
      return { ok: false, msRemaining: DAILY_COOLDOWN_MS - elapsed };
    }
  }

  const [updated] = await db
    .update(walletsTable)
    .set({
      balance: sql`${walletsTable.balance} + ${DAILY_AMOUNT}`,
      lastDailyAt: new Date(now),
    })
    .where(and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId)))
    .returning();

  if (!updated) {
    throw new Error("Failed to update wallet for daily claim");
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

  const sender = await getOrCreateWallet(guildId, fromUserId);
  if (sender.balance < amount) {
    return { ok: false, reason: `残高が不足しています(所持: ${sender.balance}${CURRENCY_NAME})。` };
  }

  await getOrCreateWallet(guildId, toUserId);

  await db.transaction(async (tx) => {
    await tx
      .update(walletsTable)
      .set({ balance: sql`${walletsTable.balance} - ${amount}` })
      .where(and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, fromUserId)));

    await tx
      .update(walletsTable)
      .set({ balance: sql`${walletsTable.balance} + ${amount}` })
      .where(and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, toUserId)));
  });

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

  const wallet = await getOrCreateWallet(guildId, userId);
  if (wallet.balance < item.price) {
    return { ok: false, reason: `残高が不足しています(所持: ${wallet.balance}${CURRENCY_NAME}、必要: ${item.price}${CURRENCY_NAME})。` };
  }

  await db.transaction(async (tx) => {
    await tx
      .update(walletsTable)
      .set({ balance: sql`${walletsTable.balance} - ${item.price}` })
      .where(and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId)));

    const [existingInventory] = await tx
      .select()
      .from(inventoryItemsTable)
      .where(
        and(
          eq(inventoryItemsTable.guildId, guildId),
          eq(inventoryItemsTable.userId, userId),
          eq(inventoryItemsTable.shopItemId, item.id),
        ),
      );

    if (existingInventory) {
      await tx
        .update(inventoryItemsTable)
        .set({ quantity: sql`${inventoryItemsTable.quantity} + 1` })
        .where(eq(inventoryItemsTable.id, existingInventory.id));
    } else {
      await tx.insert(inventoryItemsTable).values({
        guildId,
        userId,
        shopItemId: item.id,
        quantity: 1,
      });
    }
  });

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
