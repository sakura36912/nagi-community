import { integer, pgTable, text, serial, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Per-role eval sheet config: maps one Discord role to one forum channel.
 * Multiple rows per guild = multiple forum-role bindings.
 */
export const evalSheetConfigTable = pgTable(
  "eval_sheet_configs",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    roleId: text("role_id").notNull(),
    forumChannelId: text("forum_channel_id").notNull(),
    /** Number of days the eval period covers when this role triggers a sheet. */
    evalPeriodDays: integer("eval_period_days").notNull().default(14),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.guildId, table.roleId)],
);

export const insertEvalSheetConfigSchema = createInsertSchema(evalSheetConfigTable).omit({
  id: true,
  createdAt: true,
});
export type InsertEvalSheetConfig = z.infer<typeof insertEvalSheetConfigSchema>;
export type EvalSheetConfig = typeof evalSheetConfigTable.$inferSelect;

// Tracks which users already have an eval sheet for a given role,
// so we never create duplicates even if the role is removed and re-added.
export const evalSheetsTable = pgTable(
  "eval_sheets",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    roleId: text("role_id").notNull(),
    threadId: text("thread_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.guildId, table.userId, table.roleId)],
);

export const insertEvalSheetSchema = createInsertSchema(evalSheetsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertEvalSheet = z.infer<typeof insertEvalSheetSchema>;
export type EvalSheet = typeof evalSheetsTable.$inferSelect;
