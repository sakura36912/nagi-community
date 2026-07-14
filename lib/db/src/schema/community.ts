import {
  pgTable,
  text,
  serial,
  timestamp,
  integer,
  unique,
  boolean,
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

/** Reason a temp VC was removed from the DB / deleted from Discord. */
export type TempVcDeletionReason =
  | "empty_leave"       // last user left → channel deleted
  | "bot_restart"       // channel was empty when bot restarted → channel deleted
  | "stale_guild_gone"  // guild no longer found on restart → DB record cleaned up only
  | "stale_channel_gone"; // channel already deleted before bot could act → DB record cleaned up only

/** Audit log of every temp VC removal. */
export const communityTempVcDeletionLogTable = pgTable("community_tempvc_deletion_log", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull(),
  channelName: text("channel_name").notNull(),
  ownerId: text("owner_id").notNull(),
  reason: text("reason").$type<TempVcDeletionReason>().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CommunityTempVcDeletionLog = typeof communityTempVcDeletionLogTable.$inferSelect;

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

/** Staff role configuration and custom messages for the ticket system. */
export const communityTicketSettingsTable = pgTable("community_ticket_settings", {
  guildId: text("guild_id").primaryKey(),
  staffRoleId: text("staff_role_id"),
  /** Title shown on the panel embed. */
  panelTitle: text("panel_title"),
  /** Description shown on the panel embed. */
  panelDescription: text("panel_description"),
  /** Label on the "create ticket" button. */
  panelButtonLabel: text("panel_button_label"),
  /** First message posted inside the newly created ticket channel. */
  welcomeMessage: text("welcome_message"),
  /** Role allowed to rename ticket channels (in addition to admins). */
  renameRoleId: text("rename_role_id"),
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

// ─── VC Privacy Opt-out ──────────────────────────────────────────────────────

/**
 * Users who have opted out of VC time tracking.
 *
 * Scope: per-guild (guild_id + user_id composite key).
 * Rationale: each guild is an independent community; opt-out in server A does not
 * automatically apply to server B. Users who care about privacy across all servers
 * must run /privacy optout in each one. A future global opt-out table (keyed only
 * by user_id) could be added to complement this per-guild table if cross-guild
 * privacy becomes a requirement.
 *
 * Rejoining a server: the row persists in the DB after a user leaves, so if they
 * rejoin the same guild their opt-out preference is restored automatically.
 *
 * Toggle design: using optedOut=true/false on a row (rather than row presence/absence)
 * so toggling back to opt-in does not lose the row and allows auditing.
 */
export const communityVcPrivacyTable = pgTable(
  "community_vc_privacy",
  {
    guildId: text("guild_id").notNull(),
    userId: text("user_id").notNull(),
    optedOut: boolean("opted_out").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.guildId, table.userId)],
);

export type CommunityVcPrivacy = typeof communityVcPrivacyTable.$inferSelect;

// ─── Eval Sheets ─────────────────────────────────────────────────────────────

/** Per-guild configuration for eval sheets. */
export const communitySheetSettingsTable = pgTable("community_sheet_settings", {
  guildId: text("guild_id").primaryKey(),
  nameboardUrl: text("nameboard_url"),
  /**
   * Forum channel ID where auto-generated eval sheets are posted.
   * Null means the auto-post feature is disabled.
   */
  forumChannelId: text("forum_channel_id"),
  /**
   * Comma-separated list of role IDs whose assignment triggers auto sheet creation.
   * Example: "123456789,987654321"
   */
  triggerRoleIds: text("trigger_role_ids"),
  /**
   * Number of days the auto-generated eval period covers (counting back from role
   * assignment date). Defaults to 14 when the feature is enabled.
   */
  evalPeriodDays: integer("eval_period_days").notNull().default(14),
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

// ─── Role Buttons ────────────────────────────────────────────────────────────

/**
 * Each row is one button in a role-button panel.
 * Multiple rows can share the same messageId (= one panel with many buttons).
 */
export const communityRoleButtonsTable = pgTable("community_role_buttons", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  channelId: text("channel_id").notNull(),
  messageId: text("message_id").notNull(),
  /** Discord role ID granted/revoked when this button is pressed. */
  roleId: text("role_id").notNull(),
  /** Label shown on the button (max 80 chars). */
  label: text("label").notNull(),
  /** ButtonStyle value: 1=Primary 2=Secondary 3=Success 4=Danger */
  style: integer("style").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CommunityRoleButton = typeof communityRoleButtonsTable.$inferSelect;

// ─── Daily Ranking Post ──────────────────────────────────────────────────────

/** Per-guild configuration for the daily VC ranking auto-post. */
export const communityRankingSettingsTable = pgTable("community_ranking_settings", {
  guildId: text("guild_id").primaryKey(),
  /** Channel where the daily ranking embed is posted. Null = disabled. */
  channelId: text("channel_id"),
  /** Aggregation period: "today" | "week" | "month" | "all". */
  period: text("period").notNull().default("all"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type CommunityRankingSettings = typeof communityRankingSettingsTable.$inferSelect;
