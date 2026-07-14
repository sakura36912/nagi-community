import { pgTable, text, serial, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// One row per scheduled VC deletion. The bot renames the channel immediately
// when the schedule is created, then deletes it when scheduledDeleteAt elapses.
// Only one active schedule per channel is allowed (unique on guildId + channelId).
export const vcSchedulesTable = pgTable(
  "vc_schedules",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    // The name the channel was given when the schedule was created.
    newName: text("new_name").notNull(),
    // The channel's name before we renamed it (used when cancelling).
    originalName: text("original_name").notNull(),
    scheduledDeleteAt: timestamp("scheduled_delete_at", { withTimezone: true }).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.guildId, table.channelId)],
);

export const insertVcScheduleSchema = createInsertSchema(vcSchedulesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertVcSchedule = z.infer<typeof insertVcScheduleSchema>;
export type VcSchedule = typeof vcSchedulesTable.$inferSelect;
