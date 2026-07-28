import {
  pgTable,
  text,
  integer,
  serial,
  timestamp,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Tracks users currently in a voice channel for the VC-time reward system.
 * One row per (guildId, userId) — upserted on join, deleted on leave.
 */
export const vcPresenceTable = pgTable(
  "vc_presence",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    channelId: text("channel_id").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId] })],
);

export type VcPresence = typeof vcPresenceTable.$inferSelect;

/**
 * Per-guild configuration for VC-time rewards.
 * ratePerHour = 0 means the feature is disabled for that guild.
 */
export const vcRewardSettingsTable = pgTable("vc_reward_settings", {
  guildId: text("guild_id").primaryKey(),
  /** Coins earned per hour of continuous VC time. 0 = disabled. */
  ratePerHour: integer("rate_per_hour").notNull().default(0),
  /** Minimum continuous minutes required before any reward is paid. */
  minMinutes: integer("min_minutes").notNull().default(5),
  /**
   * Allowlist of Discord category channel IDs.
   * Empty array = all categories are eligible.
   * Non-empty = only VCs whose parentId is in this list earn rewards.
   */
  includedCategoryIds: text("included_category_ids")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertVcRewardSettingsSchema = createInsertSchema(
  vcRewardSettingsTable,
).omit({ updatedAt: true });
export type InsertVcRewardSettings = z.infer<typeof insertVcRewardSettingsSchema>;
export type VcRewardSettings = typeof vcRewardSettingsTable.$inferSelect;

// ─── VC Session Log ───────────────────────────────────────────────────────────

/** Per-guild config: which categories to log VC stay time for. */
export const vcSessionLogSettingsTable = pgTable("vc_session_log_settings", {
  guildId: text("guild_id").primaryKey(),
  /** Category IDs to track. Empty = logging disabled. */
  categoryIds: text("category_ids")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  /** Channel ID to post real-time join/leave notifications. Null = disabled. */
  notifyChannelId: text("notify_channel_id"),
});
export type VcSessionLogSettings = typeof vcSessionLogSettingsTable.$inferSelect;

/** Tracks users currently in a logged VC. One row per (guildId, userId). */
export const vcLogPresenceTable = pgTable(
  "vc_log_presence",
  {
    guildId:    text("guild_id").notNull(),
    userId:     text("user_id").notNull(),
    channelId:  text("channel_id").notNull(),
    categoryId: text("category_id").notNull(),
    joinedAt:   timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.userId] })],
);
export type VcLogPresence = typeof vcLogPresenceTable.$inferSelect;

/** Completed VC session records. */
export const vcSessionLogsTable = pgTable(
  "vc_session_logs",
  {
    id:              serial("id").primaryKey(),
    guildId:         text("guild_id").notNull(),
    userId:          text("user_id").notNull(),
    channelId:       text("channel_id").notNull(),
    categoryId:      text("category_id").notNull(),
    joinedAt:        timestamp("joined_at", { withTimezone: true }).notNull(),
    leftAt:          timestamp("left_at",   { withTimezone: true }).notNull(),
    durationSeconds: integer("duration_seconds").notNull(),
  },
  (t) => [
    index("vc_session_logs_guild_user_idx").on(t.guildId, t.userId),
    index("vc_session_logs_joined_at_idx").on(t.joinedAt),
  ],
);
export type VcSessionLog = typeof vcSessionLogsTable.$inferSelect;
