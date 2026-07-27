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
  // How often (in minutes) role-based auto-rewards are paid out (interval mode).
  rewardIntervalMinutes: integer("reward_interval_minutes").notNull().default(43200),
  // If set (1–31), rewards are paid on this calendar day each month instead of
  // using the interval. Takes priority over rewardIntervalMinutes.
  rewardDayOfMonth: integer("reward_day_of_month"),
  // When role-based auto-rewards were last distributed for this guild.
  lastRewardAt: timestamp("last_reward_at", { withTimezone: true }),
  // Discord category channel ID where private VCs (vcshop) are created.
  vcCategoryId: text("vc_category_id"),
  // Discord category channel ID where 裏フリールーム VCs (urashop) are created.
  uraCategoryId: text("ura_category_id"),
  // Discord text/voice channel ID that urashop buyers get ViewChannel access to.
  uraChannelId: text("ura_channel_id"),

  // Discord text channel ID where ban notifications are posted.
  banLogChannelId: text("ban_log_channel_id"),
  // Discord text channel ID where leave notifications are posted.
  leaveLogChannelId: text("leave_log_channel_id"),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// Tracks every join/leave event per member per guild (for rejoin count display).
export const memberJoinHistoryTable = pgTable("member_join_history", {
  id:       serial("id").primaryKey(),
  guildId:  text("guild_id").notNull(),
  userId:   text("user_id").notNull(),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  leftAt:   timestamp("left_at",   { withTimezone: true }),
});
export type MemberJoinHistory = typeof memberJoinHistoryTable.$inferSelect;

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
    initialIssuedAt: timestamp("initial_issued_at", { withTimezone: true }),
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
// `category` groups items into separate shops (e.g. "general", "group",
// "vc", "ura"). Each shop command filters by its own category.
export const shopItemsTable = pgTable("shop_items", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  price: integer("price").notNull(),
  effectType: text("effect_type"),
  targetRoleId: text("target_role_id"),
  category: text("category").notNull().default("general"),
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

// Tracks active time-limited private VC channels so the scheduler can
// delete them when their lease expires.
export const privateVcSessionsTable = pgTable("private_vc_sessions", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull().unique(),
  userId: text("user_id").notNull(),
  /** Shop category that created this session ("vc" | "ura"). Used to decide cleanup actions. */
  category: text("category").notNull().default("vc"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPrivateVcSessionSchema = createInsertSchema(privateVcSessionsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertPrivateVcSession = z.infer<typeof insertPrivateVcSessionSchema>;
export type PrivateVcSession = typeof privateVcSessionsTable.$inferSelect;

// ─── Squad Treasuries (隊金庫) ────────────────────────────────────────────────

/**
 * One row per squad treasury. Linked to a Discord role that identifies
 * squad membership. leaderRoleId (if set) can withdraw; otherwise only admins can.
 */
export const squadTreasuriesTable = pgTable(
  "squad_treasuries",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    /** Discord role whose members belong to this squad. */
    roleId: text("role_id").notNull(),
    /** Optional role allowed to withdraw (squad leader). */
    leaderRoleId: text("leader_role_id"),
    /** Display name of the treasury (e.g. "桜雅隊"). */
    name: text("name").notNull(),
    balance: integer("balance").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [unique().on(table.guildId, table.roleId)],
);

export type SquadTreasury = typeof squadTreasuriesTable.$inferSelect;

/** Ledger for every deposit/withdrawal. amount > 0 = deposit, < 0 = withdrawal. */
export const squadTreasuryTxTable = pgTable("squad_treasury_transactions", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  treasuryId: integer("treasury_id")
    .notNull()
    .references(() => squadTreasuriesTable.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  amount: integer("amount").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SquadTreasuryTx = typeof squadTreasuryTxTable.$inferSelect;

// ─── Shop License Config (個人ショップ開業設定) ───────────────────────────────

/**
 * Maps a squad role to the shop-license role to assign on purchase.
 * One row per (guild, squad role) pair.
 */
export const shopLicenseConfigTable = pgTable(
  "shop_license_config",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    /** Discord role that identifies squad membership. */
    squadRoleId: text("squad_role_id").notNull(),
    /** Role to assign when the user buys a shop-license item. */
    licenseRoleId: text("license_role_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.guildId, table.squadRoleId)],
);

export type ShopLicenseConfig = typeof shopLicenseConfigTable.$inferSelect;

// ─── Group Shop Sales Log (隊別売上記録) ─────────────────────────────────────

/**
 * One row per group-shop purchase. Squad role is captured at purchase time so
 * the report stays accurate even if a member's roles change later.
 */
export const groupShopSalesTable = pgTable("group_shop_sales", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  itemId: integer("item_id").notNull(),
  itemName: text("item_name").notNull(),
  squadRoleId: text("squad_role_id").notNull(),
  amount: integer("amount").notNull(),
  purchasedAt: timestamp("purchased_at", { withTimezone: true }).notNull().defaultNow(),
});

export type GroupShopSale = typeof groupShopSalesTable.$inferSelect;
