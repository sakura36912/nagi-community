import {
  pgTable,
  text,
  integer,
  serial,
  timestamp,
  boolean,
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
  // Monthly debit rule: members with this role are charged this amount on the
  // 25th of each Japan calendar month.
  monthlyDebitRoleId: text("monthly_debit_role_id"),
  monthlyDebitAmount: integer("monthly_debit_amount"),
  lastMonthlyDebitAt: timestamp("last_monthly_debit_at", { withTimezone: true }),
  // Discord category channel ID where private VCs (vcshop) are created.
  vcCategoryId: text("vc_category_id"),
  // Discord category channel ID where 裏フリールーム VCs (urashop) are created.
  uraCategoryId: text("ura_category_id"),
  // Discord text/voice channel ID that urashop buyers get ViewChannel access to.
  uraChannelId: text("ura_channel_id"),

  // Discord text channel ID where ban notifications are posted.
  banLogChannelId: text("ban_log_channel_id"),
  // Discord text channel ID where return notifications are posted.
  returnLogChannelId: text("return_log_channel_id"),
  // Comma-separated role IDs excluded from return notifications.
  returnLogExcludedRoleIds: text("return_log_excluded_role_ids"),
  // Discord text channel ID where promotion notifications are posted.
  promotionLogChannelId: text("promotion_log_channel_id"),
  // Role ID watched for promotion notifications.
  promotionWatchRoleId: text("promotion_watch_role_id"),
  // Role ID allowed to post bounties.
  bountyPosterRoleId: text("bounty_poster_role_id"),
  // Discord text channel ID where leave notifications are posted.
  leaveLogChannelId: text("leave_log_channel_id"),

  // Discord text channel ID where 管理者指定ボイメ chest wins are announced.
  voimeNotifyChannelId: text("voime_notify_channel_id"),

  // How many minutes before a VC rename schedule expires to send the warning DM.
  // Defaults to 10 minutes (matches the original hardcoded value).
  vcWarnBeforeMinutes: integer("vc_warn_before_minutes").notNull().default(10),

  // Comma-separated list of VC channel names treated as "tavern" for chest tracking.
  // NULL means use the hardcoded default list (大酒場🍺, 小酒場🍺).
  chestTavernChannelNames: text("chest_tavern_channel_names"),

  // Discord text channel ID where chest open results are logged.
  // NULL means no logging.
  chestLogChannelId: text("chest_log_channel_id"),
  // Discord text channel ID where evaluation advice-ticket purchases are logged.
  // NULL means no logging.
  adviceLogChannelId: text("advice_log_channel_id"),

  // Blackjack suit custom emojis (Discord emoji strings, e.g. "<:spade:123>").
  // NULL means use the default Unicode emoji (♠️ ♥️ ♦️ ♣️).
  bjSuitSpade:   text("bj_suit_spade"),
  bjSuitHeart:   text("bj_suit_heart"),
  bjSuitDiamond: text("bj_suit_diamond"),
  bjSuitClub:    text("bj_suit_club"),

  // Per-guild casino max bet. NULL means use the hardcoded default (100,000).
  casinoMaxBet: integer("casino_max_bet"),
  // High-and-low win probability percentage. NULL means use the default (50%).
  highlowWinRate: integer("highlow_win_rate"),

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
  // Nullable for legacy rows created before exit-time role tracking was added.
  leftWithWaitingRole:    boolean("left_with_waiting_role"),
  leftWithPostIslandRole: boolean("left_with_post_island_role"),
  // JSON array of role names captured at the time of exit.
  leftRoleSnapshot: text("left_role_snapshot"),
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
  sortOrder: integer("sort_order").notNull().default(0),
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
  /**
   * Opaque idempotency key used by automated payouts (e.g. VC salary).
   * The partial unique index created by the database setup keeps non-NULL keys
   * unique so duplicate event firings cannot produce a second credit. NULL for
   * all manually-created transactions.
   */
  sessionKey: text("session_key"),
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
  /** Shop category that created this session ("vc" | "island" | "ura"). Used to decide panel and cleanup behavior. */
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
  (table) => [unique("shop_license_config_guild_id_squad_role_id_key").on(table.guildId, table.squadRoleId)],
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
