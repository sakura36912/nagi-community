import {
  pgTable,
  text,
  integer,
  serial,
  timestamp,
  primaryKey,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// One row per Discord user (per guild), tracking their currency balance.
export const walletsTable = pgTable(
  "wallets",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    balance: integer("balance").notNull().default(0),
    lastDailyAt: timestamp("last_daily_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId] })],
);

export const insertWalletSchema = createInsertSchema(walletsTable).omit({
  createdAt: true,
  updatedAt: true,
});
export type InsertWallet = z.infer<typeof insertWalletSchema>;
export type Wallet = typeof walletsTable.$inferSelect;

// Items available for purchase in a guild's shop.
export const shopItemsTable = pgTable("shop_items", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  price: integer("price").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertShopItemSchema = createInsertSchema(shopItemsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertShopItem = z.infer<typeof insertShopItemSchema>;
export type ShopItem = typeof shopItemsTable.$inferSelect;

// Items a user owns, purchased from the shop.
export const inventoryItemsTable = pgTable("inventory_items", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  shopItemId: integer("shop_item_id")
    .notNull()
    .references(() => shopItemsTable.id, { onDelete: "cascade" }),
  quantity: integer("quantity").notNull().default(1),
  purchasedAt: timestamp("purchased_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertInventoryItemSchema = createInsertSchema(
  inventoryItemsTable,
).omit({ id: true, purchasedAt: true });
export type InsertInventoryItem = z.infer<typeof insertInventoryItemSchema>;
export type InventoryItem = typeof inventoryItemsTable.$inferSelect;

// Ledger of every balance-changing event, for auditing and history commands.
export const transactionsTable = pgTable("transactions", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  amount: integer("amount").notNull(),
  reason: text("reason").notNull(),
  relatedUserId: text("related_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertTransactionSchema = createInsertSchema(
  transactionsTable,
).omit({ id: true, createdAt: true });
export type InsertTransaction = z.infer<typeof insertTransactionSchema>;
export type Transaction = typeof transactionsTable.$inferSelect;
