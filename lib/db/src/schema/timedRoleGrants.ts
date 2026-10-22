import {
  integer,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

/** ショップアイテム購入で付与された期限付きロールを管理するテーブル */
export const timedRoleGrantsTable = pgTable(
  "timed_role_grants",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    roleId: text("role_id").notNull(),
    /** 付与元のeffectType（例: eval_resurface） */
    effectType: text("effect_type").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("timed_role_grants_guild_user_role").on(t.guildId, t.userId, t.roleId)],
);

export type TimedRoleGrant = typeof timedRoleGrantsTable.$inferSelect;

/** 管理者が設定した、ロール付与時点から始まる自動解除期間 */
export const timedRoleConfigsTable = pgTable(
  "timed_role_configs",
  {
    guildId: text("guild_id").notNull(),
    roleId: text("role_id").notNull(),
    durationSeconds: integer("duration_seconds").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.guildId, t.roleId] })],
);

export type TimedRoleConfig = typeof timedRoleConfigsTable.$inferSelect;
