import {
  pgTable,
  text,
  integer,
  serial,
  timestamp,
  primaryKey,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// One row per guild, holding that server's custom currency configuration.
export const guildSettingsTable = pgTable("guild_settings", {
  guildId: text("guild_id").primaryKey(),
  currencyName: text("currency_name").notNull().default("円"),
  dailyAmount: integer("daily_amount").notNull().default(500),
  // How often (in minutes) role-based auto-rewards are paid out.
  // Default: 43200 = 30 days (monthly salary distribution).
  rewardIntervalMinutes: integer("reward_interval_minutes").notNull().default(43200),
  // When role-based auto-rewards were last distributed for this guild.
  lastRewardAt: timestamp("last_reward_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertGuildSettingsSchema = createInsertSchema(
  guildSettingsTable,
).omit({ createdAt: true, updatedAt: true });
export type InsertGuildSettings = z.infer<typeof insertGuildSettingsSchema>;
export type GuildSettings = typeof guildSettingsTable.$inferSelect;

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
// `effectType`, when set, tells the bot to apply a special effect on
// purchase instead of (or in addition to) just adding it to inventory.
// Currently supported: "nickname_change" — lets the buyer set their own
// server nickname.
export const shopItemsTable = pgTable("shop_items", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  price: integer("price").notNull(),
  effectType: text("effect_type"),
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
export const inventoryItemsTable = pgTable(
  "inventory_items",
  {
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
  },
  (table) => [unique().on(table.guildId, table.userId, table.shopItemId)],
);

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

// Per-role auto-reward amounts. Members holding a configured role
// automatically receive its amount every `rewardIntervalMinutes` (see
// guildSettingsTable). Members with multiple configured roles get the sum.
export const roleRewardsTable = pgTable(
  "role_rewards",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    roleId: text("role_id").notNull(),
    amount: integer("amount").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique().on(table.guildId, table.roleId)],
);

export const insertRoleRewardSchema = createInsertSchema(roleRewardsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertRoleReward = z.infer<typeof insertRoleRewardSchema>;
export type RoleReward = typeof roleRewardsTable.$inferSelect;
