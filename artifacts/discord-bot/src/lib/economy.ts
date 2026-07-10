import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  walletsTable,
  shopItemsTable,
  inventoryItemsTable,
  transactionsTable,
  guildSettingsTable,
  type Wallet,
  type ShopItem,
  type GuildSettings,
} from "@workspace/db";

export const DEFAULT_CURRENCY_NAME = "円";
export const DEFAULT_DAILY_AMOUNT = 500;
export const DAILY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// Shop item effect types recognized by the bot.
export const NICKNAME_CHANGE_EFFECT = "nickname_change";

export async function getGuildSettings(guildId: string): Promise<GuildSettings> {
  const [existing] = await db
    .select()
    .from(guildSettingsTable)
    .where(eq(guildSettingsTable.guildId, guildId));

  if (existing) {
    return existing;
  }

  const [created] = await db
    .insert(guildSettingsTable)
    .values({ guildId })
    .onConflictDoNothing()
    .returning();

  if (created) {
    return created;
  }

  const [settings] = await db
    .select()
    .from(guildSettingsTable)
    .where(eq(guildSettingsTable.guildId, guildId));

  if (!settings) {
    throw new Error("Failed to create or fetch guild settings");
  }

  return settings;
}

export async function createOrUpdateCurrency(
  guildId: string,
  currencyName: string,
  dailyAmount?: number,
): Promise<GuildSettings> {
  const [settings] = await db
    .insert(guildSettingsTable)
    .values({
      guildId,
      currencyName,
      ...(dailyAmount !== undefined ? { dailyAmount } : {}),
    })
    .onConflictDoUpdate({
      target: guildSettingsTable.guildId,
      set: {
        currencyName,
        ...(dailyAmount !== undefined ? { dailyAmount } : {}),
      },
    })
    .returning();

  if (!settings) {
    throw new Error("Failed to create or update guild currency settings");
  }

  return settings;
}

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
  dailyAmount: number,
): Promise<{ ok: true; balance: number } | { ok: false; msRemaining: number }> {
  await getOrCreateWallet(guildId, userId);
  const now = new Date();
  const cutoff = new Date(now.getTime() - DAILY_COOLDOWN_MS);

  // Conditional update: only succeeds if the cooldown has actually elapsed,
  // checked atomically in the same statement to prevent concurrent double-claims.
  const [updated] = await db
    .update(walletsTable)
    .set({
      balance: sql`${walletsTable.balance} + ${dailyAmount}`,
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

  await recordTransaction(guildId, userId, dailyAmount, "daily");

  return { ok: true, balance: updated.balance };
}

export async function transfer(
  guildId: string,
  fromUserId: string,
  toUserId: string,
  amount: number,
  currencyName: string,
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
    return { ok: false, reason: `残高が不足しています(所持: ${sender.balance}${currencyName})。` };
  }

  await recordTransaction(guildId, fromUserId, -amount, "transfer", toUserId);
  await recordTransaction(guildId, toUserId, amount, "transfer", fromUserId);

  return { ok: true };
}

export async function giveCurrency(
  guildId: string,
  userId: string,
  amount: number,
  currencyName: string,
): Promise<{ ok: true; balance: number } | { ok: false; reason: string }> {
  if (amount === 0) {
    return { ok: false, reason: "金額には0以外の値を指定してください。" };
  }

  await getOrCreateWallet(guildId, userId);

  // Conditional on non-negative resulting balance so an admin can't push a
  // user's balance below zero with a negative grant.
  const [updated] = await db
    .update(walletsTable)
    .set({ balance: sql`${walletsTable.balance} + ${amount}` })
    .where(
      and(
        eq(walletsTable.guildId, guildId),
        eq(walletsTable.userId, userId),
        sql`${walletsTable.balance} + ${amount} >= 0`,
      ),
    )
    .returning();

  if (!updated) {
    const wallet = await getOrCreateWallet(guildId, userId);
    return { ok: false, reason: `残高が不足しています(所持: ${wallet.balance}${currencyName})。` };
  }

  await recordTransaction(guildId, userId, amount, "admin-give");

  return { ok: true, balance: updated.balance };
}

export async function getLeaderboard(
  guildId: string,
  limit?: number,
): Promise<Wallet[]> {
  const query = db
    .select()
    .from(walletsTable)
    .where(eq(walletsTable.guildId, guildId))
    .orderBy(desc(walletsTable.balance));

  return limit === undefined ? query : query.limit(limit);
}

export async function listShopItems(guildId: string): Promise<ShopItem[]> {
  return db
    .select()
    .from(shopItemsTable)
    .where(eq(shopItemsTable.guildId, guildId))
    .orderBy(shopItemsTable.price);
}

export async function getShopItem(guildId: string, itemId: number): Promise<ShopItem | undefined> {
  const [item] = await db
    .select()
    .from(shopItemsTable)
    .where(and(eq(shopItemsTable.guildId, guildId), eq(shopItemsTable.id, itemId)));

  return item;
}

export async function addShopItem(
  guildId: string,
  name: string,
  price: number,
  description: string | null,
  effectType: string | null = null,
): Promise<ShopItem> {
  const [item] = await db
    .insert(shopItemsTable)
    .values({ guildId, name, price, description, effectType })
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
  currencyName: string,
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
      reason: `残高が不足しています(所持: ${wallet.balance}${currencyName}、必要: ${item.price}${currencyName})。`,
    };
  }

  await recordTransaction(guildId, userId, -item.price, `shop:${item.name}`);

  return { ok: true, item };
}

// Reverses a buyItem() purchase: refunds the price and removes one unit of
// inventory (deleting the row if it drops to zero). Used when a purchase's
// side effect (e.g. applying a shop item's effect) fails after charging.
export async function refundPurchase(
  guildId: string,
  userId: string,
  item: ShopItem,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(walletsTable)
      .set({ balance: sql`${walletsTable.balance} + ${item.price}` })
      .where(and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId)));

    const [inventoryRow] = await tx
      .select()
      .from(inventoryItemsTable)
      .where(
        and(
          eq(inventoryItemsTable.guildId, guildId),
          eq(inventoryItemsTable.userId, userId),
          eq(inventoryItemsTable.shopItemId, item.id),
        ),
      );

    if (inventoryRow) {
      if (inventoryRow.quantity <= 1) {
        await tx.delete(inventoryItemsTable).where(eq(inventoryItemsTable.id, inventoryRow.id));
      } else {
        await tx
          .update(inventoryItemsTable)
          .set({ quantity: sql`${inventoryItemsTable.quantity} - 1` })
          .where(eq(inventoryItemsTable.id, inventoryRow.id));
      }
    }
  });

  await recordTransaction(guildId, userId, item.price, `refund:${item.name}`);
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
