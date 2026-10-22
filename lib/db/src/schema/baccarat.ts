import { pgTable, text, integer, timestamp, primaryKey } from "drizzle-orm/pg-core";

/**
 * バカラのドロー待ちセッション。
 * ボット再起動後もボタン操作を継続できるように DB に永続化する。
 * expiresAt を過ぎたレコードは起動時のクリーンアップで削除される。
 */
export const baccaratSessionsTable = pgTable("baccarat_sessions", {
  guildId:      text("guild_id").notNull(),
  userId:       text("user_id").notNull(),
  bet:          integer("bet").notNull(),
  betOn:        text("bet_on").notNull(),          // "player" | "banker" | "tie"
  playerHand:   text("player_hand").notNull(),     // JSON: Card[]
  bankerHand:   text("banker_hand").notNull(),     // JSON: Card[]
  deck:         text("deck").notNull(),            // JSON: Card[]
  currencyName: text("currency_name").notNull(),
  expiresAt:    timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.guildId, table.userId] }),
]);
