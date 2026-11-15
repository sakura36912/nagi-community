import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export type KpTicketPhase = "cast" | "cast2" | "vip" | "guest" | "extension" | "drink" | "drink2" | "quantity" | "confirm" | "paid" | "cancelled";
export interface KpTicketQuoteItem {
  customerId?: string;
  castId: string;
  itemId: number;
  itemName: string;
  unitPrice: number;
  quantity: number;
}
export interface KpTicketCustomerPayment {
  customerId: string;
  drinkPrice: number;
  vipPrice: number;
  extensionPrice: number;
  total: number;
}
export interface KpTicketQuote {
  itemId: number | null;
  itemName: string;
  unitPrice: number;
  quantity: number;
  items?: KpTicketQuoteItem[];
  customerPayments?: KpTicketCustomerPayment[];
  vipPrice: number;
  extensionPrice: number;
  total: number;
}
export interface KpTicketSelection {
  castId?: string;
  castIds?: string[];
  /** First drinks belong to a customer/cast pair. */
  drinkSelections?: { customerId?: string; castId: string; itemId: number; quantity: number }[];
  /** The order owner is first; an optional second customer pays their own share. */
  customerIds?: string[];
  /** Each customer must confirm before a two-customer order is charged. */
  paymentApprovals?: string[];
  paymentMessageId?: string;
  /** Additional orders keep the cast of the buyer's paid order in this ticket. */
  fixedCastId?: string;
  serviceVersion?: 2;
  vipTier?: "shared" | "solo";
  vipDiscountApplied?: boolean;
  /** Historical records only; current shared VIP uses customerIds. */
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
