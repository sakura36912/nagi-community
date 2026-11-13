import { index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import type { PvpState } from "../pvpRules";

/** prize is retained only for settling pre-bounty-version duels that already escrowed money. */
export const pvpDuelsTable = pgTable("pvp_duels", {
  id: text("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull(),
  hostId: text("host_id").notNull(),
  opponentId: text("opponent_id").notNull(),
  prize: integer("prize").notNull(),
  state: jsonb("state").$type<PvpState>().notNull(),
  status: text("status").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("pvp_duels_expiry_idx").on(t.status, t.expiresAt)]);
export const insertPvpDuelSchema = createInsertSchema(pvpDuelsTable);
export type PvpDuel = typeof pvpDuelsTable.$inferSelect;

/** Per-member fixed bounty; this value never changes when a duel settles. */
export const pvpBountiesTable = pgTable("pvp_bounties", {
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  amount: integer("amount").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.guildId, t.userId] })]);
export const insertPvpBountySchema = createInsertSchema(pvpBountiesTable);
export type PvpBounty = typeof pvpBountiesTable.$inferSelect;

export const pvpActiveUsersTable = pgTable("pvp_active_users", {
  guildId: text("guild_id").notNull(), userId: text("user_id").notNull(), duelId: text("duel_id").notNull(),
}, t => [primaryKey({ columns: [t.guildId, t.userId] })]);
export const pvpActionsTable = pgTable("pvp_actions", {
  id: text("id").primaryKey(), guildId: text("guild_id").notNull(), userId: text("user_id").notNull(),
  action: text("action").notNull(), duelId: text("duel_id").notNull(),
});

export interface RpgCard {
  forgeOwnerId?: string;
  title: string; description: string; color: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  duelId?: string; phase?: "pending" | "active" | "finished";
}
/** Wallet changes and public cards are committed together; failed sends can retry after reboot. */
export const rpgNoticesTable = pgTable("rpg_notices", {
  id: text("id").primaryKey(), guildId: text("guild_id").notNull(), channelId: text("channel_id").notNull(),
  card: jsonb("card").$type<RpgCard>().notNull(),
  attempts: integer("attempts").notNull().default(0),
  nextAt: timestamp("next_at", { withTimezone: true }).notNull().defaultNow(),
  messageId: text("message_id"),
}, t => [index("rpg_notices_due_idx").on(t.nextAt)]);
