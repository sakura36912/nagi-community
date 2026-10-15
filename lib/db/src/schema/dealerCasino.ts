import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "../sqliteColumns";
import { sql } from "drizzle-orm";

/**
 * Rules that the specification explicitly leaves undecided remain NULL. The
 * game layer must refuse to use a feature until its required setting is set.
 */
export const dealerCasinoSettingsTable = pgTable("dealer_casino_settings", {
  guildId: text("guild_id").primaryKey(),
  minBet: integer("min_bet").notNull().default(1000),
  maxBet: integer("max_bet").notNull().default(10000),
  voiceChannelId: text("voice_channel_id"),
  dealerRoleId: text("dealer_role_id"),
  directorRoleId: text("director_role_id"),
  adminRoleId: text("admin_role_id"),
  logChannelId: text("log_channel_id"),
  maxPlayers: integer("max_players"),
  chohanMultipliers: jsonb("chohan_multipliers").$type<Record<string, number> | null>(),
  chohanMaxStreakMultiplier: numeric("chohan_max_streak_multiplier", { precision: 12, scale: 6, mode: "number" }),
  streakRetentionSeconds: integer("streak_retention_seconds"),
  pokerBaseMultiplier: numeric("poker_base_multiplier", { precision: 12, scale: 6, mode: "number" }),
  pokerBonusEnabled: integer("poker_bonus_enabled"),
  pokerBonusMultipliers: jsonb("poker_bonus_multipliers").$type<Record<string, number> | null>(),
  pokerDealerQualificationEnabled: integer("poker_dealer_qualification_enabled"),
  pokerDealerQualificationRank: text("poker_dealer_qualification_rank"),
  pokerDealerMinimumHighCard: integer("poker_dealer_minimum_high_card"),
  pokerAceLowEnabled: integer("poker_ace_low_enabled"),
  pokerTimeoutSeconds: integer("poker_timeout_seconds").notNull().default(60),
  chohanEnabled: integer("chohan_enabled"),
  pokerEnabled: integer("poker_enabled"),
  activityPointsPerGame: integer("activity_points_per_game"),
}, (table) => [
  check(
    "dealer_casino_settings_minimum_high_card_check",
    sql`${table.pokerDealerMinimumHighCard} IS NULL OR ${table.pokerDealerMinimumHighCard} BETWEEN 2 AND 14`,
  ),
]);

export type DealerCasinoSettings = typeof dealerCasinoSettingsTable.$inferSelect;

export const dealerCasinoGamesTable = pgTable(
  "dealer_casino_games",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    gameType: text("game_type").notNull(),
    dealerId: text("dealer_id").notNull(),
    channelId: text("channel_id").notNull(),
    voiceChannelId: text("voice_channel_id").notNull(),
    panelMessageId: text("panel_message_id"),
    state: text("state").notNull().default("RECRUITING"),
    result: jsonb("result").$type<Record<string, unknown> | null>(),
    dealerCards: jsonb("dealer_cards").$type<string[] | null>(),
    actionDeadline: timestamp("action_deadline", { withTimezone: true }),
    sessionEnded: integer("session_ended").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => [
    check("dealer_casino_games_type_check", sql`${table.gameType} IN ('chohan', 'poker')`),
    check(
      "dealer_casino_games_state_check",
      sql`${table.state} IN ('RECRUITING', 'CLOSED', 'PLAYING', 'RESULT', 'PAYOUT', 'FINISHED', 'CANCELLED')`,
    ),
    check("dealer_casino_games_session_ended_check", sql`${table.sessionEnded} IN (0, 1)`),
    uniqueIndex("dealer_casino_one_active_game_per_guild")
      .on(table.guildId)
      .where(sql`${table.state} IN ('RECRUITING', 'CLOSED', 'PLAYING', 'RESULT', 'PAYOUT')`),
    index("dealer_casino_games_guild_created_idx").on(table.guildId, table.createdAt),
  ],
);

export type DealerCasinoGame = typeof dealerCasinoGamesTable.$inferSelect;

export const dealerCasinoBetsTable = pgTable(
  "dealer_casino_bets",
  {
    id: serial("id").primaryKey(),
    gameId: integer("game_id")
      .notNull()
      .references(() => dealerCasinoGamesTable.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    betAmount: integer("bet_amount").notNull(),
    choice: text("choice"),
    state: text("state").notNull().default("ACTIVE"),
    cards: jsonb("cards").$type<string[] | null>(),
    handRank: text("hand_rank"),
    playerAction: text("player_action"),
    result: text("result"),
    payout: integer("payout").notNull().default(0),
    winStreak: integer("win_streak"),
    multiplier: numeric("multiplier", { precision: 12, scale: 6, mode: "number" }),
    betRevision: integer("bet_revision").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("dealer_casino_bets_amount_check", sql`${table.betAmount} > 0`),
    check(
      "dealer_casino_bets_state_check",
      sql`${table.state} IN ('ACTIVE', 'FOLDED', 'WON', 'LOST', 'DRAW', 'REFUNDED')`,
    ),
    uniqueIndex("dealer_casino_bets_game_user_unique").on(table.gameId, table.userId),
    index("dealer_casino_bets_game_idx").on(table.gameId),
  ],
);

export type DealerCasinoBet = typeof dealerCasinoBetsTable.$inferSelect;

export const dealerCasinoStreaksTable = pgTable(
  "dealer_casino_streaks",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    winStreak: integer("win_streak").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("dealer_casino_streaks_count_check", sql`${table.winStreak} >= 0`),
    uniqueIndex("dealer_casino_streaks_guild_user_unique").on(table.guildId, table.userId),
  ],
);

export const dealerCasinoStatsTable = pgTable(
  "dealer_casino_stats",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    chohanGames: integer("chohan_games").notNull().default(0),
    pokerGames: integer("poker_games").notNull().default(0),
    playersServed: integer("players_served").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("dealer_casino_stats_guild_user_unique").on(table.guildId, table.userId),
  ],
);

export const dealerCasinoSettlementsTable = pgTable(
  "dealer_casino_settlements",
  {
    id: serial("id").primaryKey(),
    gameId: integer("game_id")
      .notNull()
      .references(() => dealerCasinoGamesTable.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    betId: integer("bet_id")
      .notNull()
      .references(() => dealerCasinoBetsTable.id, { onDelete: "cascade" }),
    payout: integer("payout").notNull(),
    result: text("result").notNull(),
    streakUpdated: integer("streak_updated").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("dealer_casino_settlements_game_user_unique").on(table.gameId, table.userId),
    index("dealer_casino_settlements_game_idx").on(table.gameId),
  ],
);