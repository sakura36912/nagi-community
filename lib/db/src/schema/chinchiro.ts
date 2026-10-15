import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from "../sqliteColumns";

export const chinchiroGamesTable = pgTable(
  "chinchiro_games",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    messageId: text("message_id"),
    challengerId: text("challenger_id").notNull(),
    opponentId: text("opponent_id").notNull(),
    bet: integer("bet").notNull(),
    currencyName: text("currency_name").notNull(),
    status: text("status").notNull().default("pending"),
    challengerRoll: text("challenger_roll"),
    opponentRoll: text("opponent_roll"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("chinchiro_games_status_expiry_idx").on(table.status, table.expiresAt),
    index("chinchiro_games_challenger_idx").on(table.guildId, table.challengerId),
    index("chinchiro_games_opponent_idx").on(table.guildId, table.opponentId),
  ],
);

export type ChinchiroGame = typeof chinchiroGamesTable.$inferSelect;