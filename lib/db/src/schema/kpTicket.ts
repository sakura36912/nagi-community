import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export type KpTicketPhase = "cast" | "vip" | "guest" | "extension" | "drink" | "quantity" | "confirm" | "paid" | "cancelled";
export interface KpTicketQuote {
  itemId: number | null;
  itemName: string;
  unitPrice: number;
  quantity: number;
  vipPrice: number;
  extensionPrice: number;
  total: number;
}
export interface KpTicketSelection {
  castId?: string;
  /** Additional orders keep the cast of the buyer's paid order in this ticket. */
  fixedCastId?: string;
  serviceVersion?: 2;
  vipTier?: "shared" | "solo";
  guestId?: string;
  baseOrderId?: string;
  vipActive?: boolean;
  vipRoomId?: string;
  vip?: boolean;
  extension?: boolean;
  itemId?: number;
  quantity?: number;
  quote?: KpTicketQuote;
}

export const kpTicketSettingsTable = pgTable("kp_ticket_settings", {
  guildId: text("guild_id").primaryKey(),
  castRoleIds: text("cast_role_ids").array().notNull().default(sql`'{}'::text[]`),
  vipPrice: integer("vip_price"),
  extensionPrice: integer("extension_price"),
});

export const kpTicketPanelsTable = pgTable("kp_ticket_panels", {
  messageId: text("message_id").primaryKey(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull(),
});

export const kpTicketSessionsTable = pgTable("kp_ticket_sessions", {
  id: text("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull(),
  userId: text("user_id").notNull(),
  phase: text("phase").$type<KpTicketPhase>().notNull().default("cast"),
  version: integer("version").notNull().default(0),
  selection: jsonb("selection").$type<KpTicketSelection>().notNull().default({}),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  logMessageId: text("log_message_id"),
});

export type KpTicketSettings = typeof kpTicketSettingsTable.$inferSelect;
export type KpTicketSession = typeof kpTicketSessionsTable.$inferSelect;
