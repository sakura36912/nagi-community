import { index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "../sqliteColumns";

/** Independent from chinchiro_games so outstanding legacy heads remain playable. */
export const chinchiroMultiplayerSettingsTable = pgTable("chinchiro_multiplayer_settings", {
  guildId: text("guild_id").primaryKey(),
  voiceChannelId: text("voice_channel_id"),
  minBet: integer("min_bet").notNull().default(1000),
  maxBet: integer("max_bet").notNull().default(100000),
  logChannelId: text("log_channel_id"),
  testMode: integer("test_mode").notNull().default(1),
});

export const chinchiroTablesTable = pgTable("chinchiro_tables", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull(),
  messageId: text("message_id"),
  ownerId: text("owner_id").notNull(),
  parentId: text("parent_id"),
  status: text("status").notNull().default("recruiting"),
  currencyName: text("currency_name").notNull(),
  /** Snapshot at creation: changing guild settings must not change an open table's accounting. */
  testMode: integer("test_mode").notNull().default(1),
  round: integer("round").notNull().default(1),
  turnUserId: text("turn_user_id"),
  results: text("results"),
  history: text("history").notNull().default("[]"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [index("chinchiro_tables_guild_status_expiry_idx").on(t.guildId, t.status, t.expiresAt)]);

export const chinchiroTablePlayersTable = pgTable("chinchiro_table_players", {
  id: serial("id").primaryKey(),
  tableId: integer("table_id").notNull(),
  userId: text("user_id").notNull(),
  displayName: text("display_name").notNull(),
  joinOrder: integer("join_order").notNull(),
  bet: integer("bet"),
  roll: text("roll"),
  active: integer("active").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("chinchiro_table_players_table_user_unique").on(t.tableId, t.userId),
  index("chinchiro_table_players_table_order_idx").on(t.tableId, t.joinOrder),
]);

export type ChinchiroTable = typeof chinchiroTablesTable.$inferSelect;
export type ChinchiroTablePlayer = typeof chinchiroTablePlayersTable.$inferSelect;