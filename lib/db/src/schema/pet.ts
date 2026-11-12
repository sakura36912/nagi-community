import { jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import type { PetAccount, PetSettings } from "../petRules";

export const petSettingsTable = pgTable("pet_settings", {
  guildId: text("guild_id").primaryKey(),
  settings: jsonb("settings").$type<PetSettings>().notNull(),
});
/** One account and at most one embedded individual per server/member. */
export const petAccountsTable = pgTable("pet_accounts", {
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  data: jsonb("data").$type<PetAccount>().notNull(),
}, t => [primaryKey({ columns: [t.guildId, t.userId] })]);
/** Durable receipts prevent double spending and double event/quest rewards. */
export const petActionsTable = pgTable("pet_actions", {
  id: text("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  result: text("result").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
