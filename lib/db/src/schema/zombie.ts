import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { ZombieConfig, ZombieGame } from "../zombieRules";
export const zombieConfigsTable = pgTable("zombie_configs", {
  guildId: text("guild_id").primaryKey(), config: jsonb("config").$type<ZombieConfig>().notNull(),
});
/** One current event per guild; the full event remains in history after the next start. */
export const zombieGamesTable = pgTable("zombie_games", {
  id: text("id").primaryKey(), guildId: text("guild_id").notNull(), state: jsonb("state").$type<ZombieGame>().notNull(),
});
export const zombieOperationsTable = pgTable("zombie_operations", {
  id: text("id").primaryKey(), guildId: text("guild_id").notNull(), actor: text("actor").notNull(),
  action: text("action").notNull(), gameId: text("game_id").notNull(),
});
export interface ZombieJob {
  gameId: string; kind: "dm" | "request" | "audit" | "announce" | "rules" | "result";
  userId?: string; version?: number; text?: string; requestId?: string; channelId?: string;
  expiresAt?: number;
}
export const zombieJobsTable = pgTable("zombie_jobs", {
  id: text("id").primaryKey(), guildId: text("guild_id").notNull(), payload: jsonb("payload").$type<ZombieJob>().notNull(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }), nextAt: timestamp("next_at", { withTimezone: true }).notNull().defaultNow(),
  error: text("error"),
});
