import {
  boolean,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  primaryKey,
  unique,
} from "drizzle-orm/pg-core";

export const randomMatchSettingsTable = pgTable("random_match_settings", {
  guildId: text("guild_id").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  categoryId: text("category_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const randomMatchQueueTable = pgTable(
  "random_match_queue",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    preference: text("preference").notNull().default("any"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId] })],
);

export const randomMatchesTable = pgTable(
  "random_matches",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    userAId: text("user_a_id").notNull(),
    userBId: text("user_b_id").notNull(),
    channelId: text("channel_id").unique(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    deleteAt: timestamp("delete_at", { withTimezone: true }),
  },
  (table) => [
    unique("random_matches_guild_channel_id").on(table.guildId, table.channelId),
  ],
);

export const randomMatchBlocksTable = pgTable(
  "random_match_blocks",
  {
    guildId: text("guild_id").notNull(),
    blockerId: text("blocker_id").notNull(),
    blockedId: text("blocked_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.blockerId, table.blockedId] })],
);

export const randomMatchReportsTable = pgTable("random_match_reports", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  matchId: integer("match_id"),
  reporterId: text("reporter_id").notNull(),
  reportedId: text("reported_id").notNull(),
  reason: text("reason").notNull(),
  status: text("status").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type RandomMatchSettings = typeof randomMatchSettingsTable.$inferSelect;
export type RandomMatchQueue = typeof randomMatchQueueTable.$inferSelect;
export type RandomMatch = typeof randomMatchesTable.$inferSelect;
export type RandomMatchBlock = typeof randomMatchBlocksTable.$inferSelect;
export type RandomMatchReport = typeof randomMatchReportsTable.$inferSelect;