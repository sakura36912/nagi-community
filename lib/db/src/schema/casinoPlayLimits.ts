import { integer, pgTable, primaryKey, text } from "../sqliteColumns";

/** Per-guild daily play cap for each supported casino game. Missing rows mean unlimited. */
export const casinoPlayLimitsTable = pgTable(
  "casino_play_limits",
  {
    guildId: text("guild_id").notNull(),
    game: text("game").notNull(),
    dailyLimit: integer("daily_limit").notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.game] })],
);

/** Number of paid rounds started by a member for a game on a JST calendar date. */
export const casinoDailyPlayCountsTable = pgTable(
  "casino_daily_play_counts",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    game: text("game").notNull(),
    date: text("date").notNull(), // YYYY-MM-DD in JST
    playCount: integer("play_count").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId, table.game, table.date] })],
);