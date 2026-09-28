import { sql } from "drizzle-orm";
import {
  boolean,
  bigint,
  integer,
  index,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** Guild configuration for the bounty-point feature. */
export const bountySettingsTable = pgTable("bounty_settings", {
  guildId: text("guild_id").primaryKey(),
  crewRoleId: text("crew_role_id").notNull(),
  logChannelId: text("log_channel_id").notNull(),
  tierRoleIds: text("tier_role_ids").array().notNull().default(sql`'{}'::text[]`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type BountySettings = typeof bountySettingsTable.$inferSelect;

/** Dedicated bounty points, separate from wallet currency. */
export const bountyPointsTable = pgTable(
  "bounty_points",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    points: integer("points").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId] })],
);
export type BountyPoints = typeof bountyPointsTable.$inferSelect;

/** Immutable change history; dedupeKey is used for idempotent monthly payouts. */
export const bountyPointLedgerTable = pgTable(
  "bounty_point_ledger",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    delta: integer("delta").notNull(),
    before: integer("before").notNull(),
    after: integer("after").notNull(),
    reason: text("reason").notNull(),
    actorId: text("actor_id"),
    dedupeKey: text("dedupe_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("bounty_point_ledger_dedupe_idx").on(table.guildId, table.userId, table.dedupeKey),
    index("bounty_point_ledger_user_idx").on(table.guildId, table.userId),
  ],
);

export const bountyVcRatesTable = pgTable(
  "bounty_vc_rates",
  {
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    ratePerHour: integer("rate_per_hour").notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.channelId] })],
);

/** Current voice eligibility and last processed instant for each user. */
export const bountyVoicePresenceTable = pgTable(
  "bounty_voice_presence",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    channelId: text("channel_id"),
    eligible: boolean("eligible").notNull().default(false),
    accruedAt: timestamp("accrued_at", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId] })],
);

/** Completed-second progress toward a whole-hour award, scoped to one VC. */
export const bountyVcProgressTable = pgTable(
  "bounty_vc_progress",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    channelId: text("channel_id").notNull(),
    accumulatedSeconds: integer("accumulated_seconds").notNull().default(0),
    pendingPointSeconds: bigint("pending_point_seconds", { mode: "number" }).notNull().default(0),
    pointRemainder: integer("point_remainder").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId, table.channelId] })],
);

export const bountyMonthlyRatesTable = pgTable(
  "bounty_monthly_rates",
  {
    guildId: text("guild_id").notNull(),
    roleId: text("role_id").notNull(),
    points: integer("points").notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.roleId] })],
);

/** Immutable monthly-rate revisions used to safely settle overdue periods. */
export const bountyMonthlyRateHistoryTable = pgTable(
  "bounty_monthly_rate_history",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    roleId: text("role_id").notNull(),
    points: integer("points").notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("bounty_monthly_rate_history_lookup_idx")
      .on(table.guildId, table.roleId, table.effectiveAt, table.id),
  ],
);

/** A payout period is completed even when its eligible-member set is empty. */
export const bountyMonthlyPayoutsTable = pgTable(
  "bounty_monthly_payouts",
  {
    guildId: text("guild_id").notNull(),
    monthKey: text("month_key").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.monthKey] })],
);

/** Durable audit messages remain pending until the bot confirms delivery. */
export const bountyAuditOutboxTable = pgTable(
  "bounty_audit_outbox",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    ledgerId: integer("ledger_id").notNull().references(() => bountyPointLedgerTable.id),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("bounty_audit_outbox_ledger_idx").on(table.ledgerId),
    index("bounty_audit_outbox_pending_idx").on(table.guildId, table.sentAt, table.id),
  ],
);