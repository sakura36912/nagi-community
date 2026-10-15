import { pgTable, text, serial, timestamp, integer, unique } from "../sqliteColumns";
import { sql } from "drizzle-orm";

// ─── Shift Settings ───────────────────────────────────────────────────────────

/** Per-guild configuration for the shift management feature. */
export const shiftSettingsTable = pgTable("shift_settings", {
  guildId: text("guild_id").primaryKey(),
  /** Channel where the weekly schedule is auto-posted every Monday 9:00 JST. */
  channelId: text("channel_id"),
  /** Currency awarded per shift when a member runs /shift add. 0 = disabled. */
  shiftRewardAmount: integer("shift_reward_amount").notNull().default(0),
  /** Role IDs allowed to use /shift submit. Empty = everyone. */
  submitRoleIds: text("submit_role_ids").array().notNull().default([]),
  /** Role IDs allowed to use /shift list. Empty = everyone. */
  listRoleIds: text("list_role_ids").array().notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type ShiftSettings = typeof shiftSettingsTable.$inferSelect;

// ─── Shifts ───────────────────────────────────────────────────────────────────

/** One shift entry per user per day. Times stored as "HH:MM" strings in JST. */
export const shiftsTable = pgTable("shifts", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  /** Date in JST as "YYYY-MM-DD". */
  date: text("date").notNull(),
  /** Start time as "HH:MM". */
  startTime: text("start_time").notNull(),
  /** End time as "HH:MM". Must be after startTime on the same day. */
  endTime: text("end_time").notNull(),
  /** Optional free-text note (max 100 chars). */
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Shift = typeof shiftsTable.$inferSelect;

// ─── Shift unavailability ─────────────────────────────────────────────────────

/** One "unavailable for the whole week" entry per user and JST week. */
export const shiftUnavailabilityTable = pgTable(
  "shift_unavailability",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    /** Saturday of the target Sat–Fri week, stored as "YYYY-MM-DD" in JST. */
    weekStart: text("week_start").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("shift_unavailability_user_week_unique").on(table.guildId, table.userId, table.weekStart)],
);

export type ShiftUnavailability = typeof shiftUnavailabilityTable.$inferSelect;
