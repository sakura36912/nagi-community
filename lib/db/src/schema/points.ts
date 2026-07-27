import {
  pgTable,
  text,
  integer,
  serial,
  timestamp,
  primaryKey,
  unique,
  index,
} from "drizzle-orm/pg-core";

// ─── Point Settings ───────────────────────────────────────────────────────────

/** Per-guild configuration for the point system. */
export const pointSettingsTable = pgTable("point_settings", {
  guildId: text("guild_id").primaryKey(),
  /** Points awarded once when a user starts boosting the server. */
  boostPoints: integer("boost_points").notNull().default(0),
  /** Last time role-tenure batch was run (to prevent double-awards). */
  roleTenureLastAwardedAt: timestamp("role_tenure_last_awarded_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
export type PointSettings = typeof pointSettingsTable.$inferSelect;

// ─── VC Category Configs ──────────────────────────────────────────────────────

/** Points per hour per VC category. */
export const pointVcCategoryConfigsTable = pgTable(
  "point_vc_category_configs",
  {
    id:             serial("id").primaryKey(),
    guildId:        text("guild_id").notNull(),
    categoryId:     text("category_id").notNull(),
    pointsPerHour:  integer("points_per_hour").notNull().default(100),
  },
  (t) => [unique().on(t.guildId, t.categoryId)],
);
export type PointVcCategoryConfig = typeof pointVcCategoryConfigsTable.$inferSelect;

// ─── VC Sessions ──────────────────────────────────────────────────────────────

/** Active VC session for point tracking (one row while the user is in VC). */
export const pointVcSessionsTable = pgTable(
  "point_vc_sessions",
  {
    guildId:    text("guild_id").notNull(),
    userId:     text("user_id").notNull(),
    categoryId: text("category_id").notNull(),
    joinedAt:   timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.userId] })],
);
export type PointVcSession = typeof pointVcSessionsTable.$inferSelect;

// ─── Role Tenure Configs ──────────────────────────────────────────────────────

/** Per-guild tracked roles for role-tenure daily point awards. */
export const pointRoleConfigsTable = pgTable(
  "point_role_configs",
  {
    id:          serial("id").primaryKey(),
    guildId:     text("guild_id").notNull(),
    roleId:      text("role_id").notNull(),
    /** Points awarded per day the user holds this role. */
    pointsPerDay: integer("points_per_day").notNull().default(10),
  },
  (t) => [unique().on(t.guildId, t.roleId)],
);
export type PointRoleConfig = typeof pointRoleConfigsTable.$inferSelect;

// ─── Event Rank Configs ───────────────────────────────────────────────────────

/** Points awarded per event result rank, per guild. */
export const pointRankConfigsTable = pgTable(
  "point_rank_configs",
  {
    guildId: text("guild_id").notNull(),
    rank:    integer("rank").notNull(),
    points:  integer("points").notNull(),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.rank] })],
);
export type PointRankConfig = typeof pointRankConfigsTable.$inferSelect;

// ─── Point Balances ───────────────────────────────────────────────────────────

/** Cumulative point balance per (guild, user). */
export const pointBalancesTable = pgTable(
  "point_balances",
  {
    guildId:   text("guild_id").notNull(),
    userId:    text("user_id").notNull(),
    balance:   integer("balance").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.userId] })],
);
export type PointBalance = typeof pointBalancesTable.$inferSelect;

// ─── Point Transactions ───────────────────────────────────────────────────────

/**
 * Audit log of every point change.
 * type: 'vc_time' | 'role_tenure' | 'boost' | 'event_result' | 'bounty_post' | 'bounty_award' | 'bounty_refund' | 'manual'
 */
export const pointTransactionsTable = pgTable(
  "point_transactions",
  {
    id:        serial("id").primaryKey(),
    guildId:   text("guild_id").notNull(),
    userId:    text("user_id").notNull(),
    amount:    integer("amount").notNull(),
    type:      text("type").notNull(),
    note:      text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("point_tx_guild_user_idx").on(t.guildId, t.userId)],
);
export type PointTransaction = typeof pointTransactionsTable.$inferSelect;
