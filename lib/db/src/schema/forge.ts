import { integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

export const forgeWeaponsTable = pgTable("forge_weapons", {
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  weaponType: text("weapon_type").notNull(),
  weaponLevel: integer("weapon_level").notNull().default(1),
  attack: integer("attack").notNull(),
  defense: integer("defense").notNull(),
  skill: text("skill").notNull(),
  version: integer("version").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.guildId, t.userId] })]);
export const insertForgeWeaponSchema = createInsertSchema(forgeWeaponsTable);
export type ForgeWeapon = typeof forgeWeaponsTable.$inferSelect;

export const forgeUpgradeSettingsTable = pgTable("forge_upgrade_settings", {
  guildId: text("guild_id").notNull(),
  level: integer("level").notNull(),
  cost: integer("cost"),
  successRate: integer("success_rate"),
}, t => [primaryKey({ columns: [t.guildId, t.level] })]);
export const insertForgeUpgradeSettingSchema = createInsertSchema(forgeUpgradeSettingsTable);

/** 確認パネルは再起動後も検証できるようDBへ保存する。 */
export const forgeUpgradeRequestsTable = pgTable("forge_upgrade_requests", {
  id: text("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  weaponVersion: integer("weapon_version").notNull(),
  weaponType: text("weapon_type").notNull(),
  weaponLevel: integer("weapon_level").notNull(),
  cost: integer("cost").notNull(),
  successRate: integer("success_rate").notNull(),
  state: text("state").notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export type ForgeActionResult = {
  action: string; weaponType?: string; level?: number; success?: boolean;
  cost?: number; balance?: number; reset?: boolean;
};
/** 監査記録と重複防止を兼用。同一操作を再受信しても課金しない。 */
export const forgeActionsTable = pgTable("forge_actions", {
  id: text("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  result: jsonb("result").$type<ForgeActionResult>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
