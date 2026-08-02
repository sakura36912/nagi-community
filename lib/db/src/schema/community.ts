import {
  pgTable,
  text,
  serial,
  timestamp,
  boolean,
  integer,
  unique,
} from "drizzle-orm/pg-core";

// ─── Events ─────────────────────────────────────────────────────────────────

/** Per-guild configuration for event notifications. */
export const communityEventSettingsTable = pgTable("community_event_settings", {
  guildId: text("guild_id").primaryKey(),
  /** Channel where new event announcements are posted. */
  notifyChannelId: text("notify_channel_id"),
  /** Role mentioned when a new event is announced or reminder fires. */
  notifyRoleId: text("notify_role_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type CommunityEventSettings = typeof communityEventSettingsTable.$inferSelect;

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
  /** Set when the 24-hour-before reminder has been sent. */
  reminder24hSentAt: timestamp("reminder_24h_sent_at", { withTimezone: true }),
  /** Set when participation points have been awarded to all RSVP'd members. */
  participationPointsAwardedAt: timestamp("participation_points_awarded_at", { withTimezone: true }),
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
  /** ButtonStyle value for the panel button: 1=Primary 2=Secondary 3=Success 4=Danger */
  panelButtonStyle: integer("panel_button_style"),
  /** Emoji shown on the panel button (unicode or <:name:id>). */
  panelButtonEmoji: text("panel_button_emoji"),
  /** First message posted inside the newly created ticket channel. */
  welcomeMessage: text("welcome_message"),
  /** Title of the welcome embed inside the ticket channel. */
  welcomeEmbedTitle: text("welcome_embed_title"),
  /** Hex color of the welcome embed, e.g. "#5865F2". */
  welcomeEmbedColor: text("welcome_embed_color"),
  /** Role allowed to rename ticket channels (in addition to admins). */
  renameRoleId: text("rename_role_id"),
  /** Discord category channel ID where ticket channels are created. */
  categoryId: text("category_id"),
  /** Prefix for ticket channel names, e.g. "ticket" → ticket-username. */
  channelNamePrefix: text("channel_name_prefix"),
  /** Whether to mention the ticket creator in the welcome message. Default true. */
  mentionUser: boolean("mention_user").notNull().default(true),
  /** Whether to mention the staff role in the welcome message. Default true. */
  mentionStaff: boolean("mention_staff").notNull().default(true),
  /** Label on the close button. */
  closeButtonLabel: text("close_button_label"),
  /** ButtonStyle value for the close button: 1=Primary 2=Secondary 3=Success 4=Danger */
  closeButtonStyle: integer("close_button_style"),
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
  /** True when the session belongs to a user with the 追放者 role — tracked separately from the main ranking. */
  isExile: boolean("is_exile").notNull().default(false),
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

/**
 * Global VC tracking opt-out, keyed only by user_id.
 * A row with optedOut=true here suppresses VC session recording in ALL guilds,
 * taking priority over the per-guild communityVcPrivacyTable.
 * Toggling back to optedOut=false (or deleting the row) restores per-guild rules.
 */
export const communityVcPrivacyGlobalTable = pgTable("community_vc_privacy_global", {
  userId: text("user_id").primaryKey(),
  optedOut: boolean("opted_out").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CommunityVcPrivacyGlobal = typeof communityVcPrivacyGlobalTable.$inferSelect;

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
  /**
   * Discord category channel ID whose text channels are searched for
   * self-introduction messages when building an eval sheet.
   * Null means the self-intro field is omitted.
   */
  rosterCategoryId: text("roster_category_id"),
  /**
   * How many days before endDate the forum-thread reminder is posted.
   * 0 (default) = on the deadline day itself.
   */
  reminderDaysBefore: integer("reminder_days_before").notNull().default(0),
  /**
   * Text channel ID where a role-mention notification is posted at the start of
   * the deadline day (JST 0:00). Null disables the notification.
   */
  deadlineNotifyChannelId: text("deadline_notify_channel_id"),
  /**
   * Role ID to mention in the deadline notification message.
   * Null posts without a role mention.
   */
  deadlineNotifyRoleId: text("deadline_notify_role_id"),
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
  /** Set to true by the economy bot when endDate is extended; community bot re-renders the embed then resets this. */
  needsUpdate: boolean("needs_update").notNull().default(false),
  /** Set when the end-of-period reminder has been posted in the forum thread. */
  reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
  /** Number of times the eval period has been extended via a purchase. Resets when a new sheet is created. */
  extensionCount: integer("extension_count").notNull().default(0),
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
  /** Channel where member-leave log embeds are posted. Null = disabled. */
  leaveLogChannelId: text("leave_log_channel_id"),
  /**
   * How many days of completed VC sessions to keep for this guild.
   * Null means use the system default of 180 days.
   * Must be between 1 and 3650.
   */
  vcSessionRetentionDays: integer("vc_session_retention_days"),
  /** Channel where admin VC record deletions are logged. Null = disabled. */
  auditLogChannelId: text("audit_log_channel_id"),
  /** Discord category channel ID. When set, only VC sessions in this category are tracked. */
  trackedVcCategoryId: text("tracked_vc_category_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type CommunityRankingSettings = typeof communityRankingSettingsTable.$inferSelect;

// ─── Ticket Panels ───────────────────────────────────────────────────────────

/**
 * Per-panel visual configuration.
 * One guild can have multiple panels, each with its own appearance.
 * Structural settings (staff role, category, channel prefix, mentions) stay in
 * community_ticket_settings.
 */
export const communityTicketPanelsTable = pgTable("community_ticket_panels", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  /** Admin-visible name to identify this panel. */
  name: text("name").notNull(),
  panelTitle: text("panel_title"),
  panelDescription: text("panel_description"),
  panelButtonLabel: text("panel_button_label"),
  /** ButtonStyle value: 1=Primary 2=Secondary 3=Success 4=Danger */
  panelButtonStyle: integer("panel_button_style"),
  panelButtonEmoji: text("panel_button_emoji"),
  welcomeMessage: text("welcome_message"),
  welcomeEmbedTitle: text("welcome_embed_title"),
  welcomeEmbedColor: text("welcome_embed_color"),
  closeButtonLabel: text("close_button_label"),
  closeButtonStyle: integer("close_button_style"),
  /** Role IDs to mention when a ticket is opened from this panel. */
  mentionRoleIds: text("mention_role_ids").array(),
  /** Discord category channel ID where tickets from this panel are created. Overrides global setting. */
  categoryId: text("category_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CommunityTicketPanel = typeof communityTicketPanelsTable.$inferSelect;

// ─── Pre-ban ─────────────────────────────────────────────────────────────────

/**
 * Users pre-banned per guild.
 * When a pre-banned user joins, the bot automatically bans them.
 */
export const communityPrebansTable = pgTable(
  "community_prebans",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    /** Discord user ID to ban on join. */
    userId: text("user_id").notNull(),
    /** Optional reason shown in the Discord ban log. */
    reason: text("reason"),
    /** Staff member who issued this pre-ban. */
    addedBy: text("added_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.guildId, table.userId)],
);

export type CommunityPreban = typeof communityPrebansTable.$inferSelect;
