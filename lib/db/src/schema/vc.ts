import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Tracks VC channels that have been renamed with a scheduled auto-delete.
// Bot requires ManageChannels permission to rename and delete channels.
export const vcSchedulesTable = pgTable("vc_schedules", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull().unique(),
  channelName: text("channel_name").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  /** Discord user ID of whoever triggered the rename (for pre-expiry DM). Nullable for older rows. */
  userId: text("user_id"),
  /** Set when a pre-expiry warning DM has been sent so we don't send it twice. */
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertVcScheduleSchema = createInsertSchema(vcSchedulesTable)
  .omit({ id: true, createdAt: true })
  .extend({ channelName: z.string().trim().min(1) });
export type InsertVcSchedule = z.infer<typeof insertVcScheduleSchema>;
export type VcSchedule = typeof vcSchedulesTable.$inferSelect;
