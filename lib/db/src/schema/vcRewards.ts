import {
  pgTable,
  text,
  integer,
  timestamp,
  primaryKey,
} from "drizzle-orm/pg-core";
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
