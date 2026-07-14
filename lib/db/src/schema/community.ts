import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  unique,
} from "drizzle-orm/pg-core";

// ─── Temp VC ────────────────────────────────────────────────────────────────

/** Which channel is the lobby (joining it auto-creates a temp VC). */
export const communityTempVcSettingsTable = pgTable("community_tempvc_settings", {
  guildId: text("guild_id").primaryKey(),
  lobbyChannelId: text("lobby_channel_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** Currently live temp VC channels. */
export const communityTempVcsTable = pgTable("community_temp_vcs", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull().unique(),
  ownerId: text("owner_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CommunityTempVcSettings = typeof communityTempVcSettingsTable.$inferSelect;
export type CommunityTempVc = typeof communityTempVcsTable.$inferSelect;

// ─── Events ─────────────────────────────────────────────────────────────────

/** Community events with participation panels. */
export const communityEventsTable = pgTable("community_events", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull(),
  messageId: text("message_id"),
  title: text("title").notNull(),
  description: text("description"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Users who have RSVP'd to an event. */
export const communityEventParticipantsTable = pgTable(
  "community_event_participants",
  {
    eventId: integer("event_id")
      .notNull()
      .references(() => communityEventsTable.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.eventId, table.userId)],
);

export type CommunityEvent = typeof communityEventsTable.$inferSelect;
export type CommunityEventParticipant = typeof communityEventParticipantsTable.$inferSelect;

// ─── Tickets ─────────────────────────────────────────────────────────────────

/** Staff role configuration for the ticket system. */
export const communityTicketSettingsTable = pgTable("community_ticket_settings", {
  guildId: text("guild_id").primaryKey(),
  staffRoleId: text("staff_role_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** Open ticket channels. */
export const communityTicketsTable = pgTable("community_tickets", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull().unique(),
  userId: text("user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CommunityTicketSettings = typeof communityTicketSettingsTable.$inferSelect;
export type CommunityTicket = typeof communityTicketsTable.$inferSelect;

// ─── VC Sessions (ranking) ───────────────────────────────────────────────────

/** Each row is one continuous VC session. leftAt=NULL means still in VC. */
export const communityVcSessionsTable = pgTable("community_vc_sessions", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  channelId: text("channel_id").notNull(),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull(),
  leftAt: timestamp("left_at", { withTimezone: true }),
});

export type CommunityVcSession = typeof communityVcSessionsTable.$inferSelect;

// ─── Eval Sheets ─────────────────────────────────────────────────────────────

/** Per-guild nameboard URL used on eval sheets. */
export const communitySheetSettingsTable = pgTable("community_sheet_settings", {
  guildId: text("guild_id").primaryKey(),
  nameboardUrl: text("nameboard_url"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** Eval sheets created via /sheet create. */
export const communitySheetsTable = pgTable("community_sheets", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  userId: text("user_id").notNull(),
  startDate: timestamp("start_date", { withTimezone: true }).notNull(),
  endDate: timestamp("end_date", { withTimezone: true }).notNull(),
  channelId: text("channel_id"),
  messageId: text("message_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CommunitySheetSettings = typeof communitySheetSettingsTable.$inferSelect;
export type CommunitySheet = typeof communitySheetsTable.$inferSelect;
