import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

// One row per configured text trigger per guild.
export const textTriggersTable = pgTable("text_triggers", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  // Exact text that must match the full message content.
  triggerText: text("trigger_text").notNull(),
  // Channel to watch; null = any channel in the guild.
  watchChannelId: text("watch_channel_id"),
  // Channel where the notification embed is sent.
  notifyChannelId: text("notify_channel_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TextTrigger = typeof textTriggersTable.$inferSelect;
