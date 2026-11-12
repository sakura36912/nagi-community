import { integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
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
/** A vet proposes care; only the owner may approve the exact quoted charge. */
export const petTreatmentRequestsTable = pgTable("pet_treatment_requests", {
  id: text("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  ownerId: text("owner_id").notNull(),
  vetId: text("vet_id").notNull(),
  petId: text("pet_id").notNull(),
  price: integer("price").notNull(),
  hunger: integer("hunger").notNull(),
  state: text("state").notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
