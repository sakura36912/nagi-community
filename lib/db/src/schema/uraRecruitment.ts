import {
  boolean,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

export const uraRecruitmentSettingsTable = pgTable("ura_recruitment_settings", {
  guildId: text("guild_id").primaryKey(),
  recruitmentChannelId: text("recruitment_channel_id"),
  vcCategoryId: text("vc_category_id"),
  logChannelId: text("log_channel_id"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const uraRecruitmentsTable = pgTable("ura_recruitments", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  recruitmentChannelId: text("recruitment_channel_id").notNull(),
  messageId: text("message_id"),
  ownerId: text("owner_id").notNull(),
  type: text("type").notNull(),
  note: text("note").notNull(),
  status: text("status").notNull().default("open"),
  selectedApplicantId: text("selected_applicant_id"),
  vcChannelId: text("vc_channel_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

export const uraApplicationsTable = pgTable(
  "ura_recruitment_applications",
  {
    id: serial("id").primaryKey(),
    recruitmentId: integer("recruitment_id").notNull(),
    guildId: text("guild_id").notNull(),
    applicantId: text("applicant_id").notNull(),
    note: text("note").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("ura_recruitment_applications_unique").on(table.recruitmentId, table.applicantId)],
);

export const uraBlocksTable = pgTable(
  "ura_recruitment_blocks",
  {
    guildId: text("guild_id").notNull(),
    blockerId: text("blocker_id").notNull(),
    blockedId: text("blocked_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("ura_recruitment_blocks_unique").on(table.guildId, table.blockerId, table.blockedId)],
);

export const uraMatchesTable = pgTable("ura_recruitment_matches", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  recruitmentId: integer("recruitment_id").notNull(),
  hostId: text("host_id").notNull(),
  guestId: text("guest_id").notNull(),
  channelId: text("channel_id").unique(),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  deleteAt: timestamp("delete_at", { withTimezone: true }),
});

export const uraReportsTable = pgTable("ura_recruitment_reports", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  matchId: integer("match_id").notNull(),
  reporterId: text("reporter_id").notNull(),
  reportedId: text("reported_id").notNull(),
  reason: text("reason").notNull(),
  details: text("details").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UraRecruitmentSettings = typeof uraRecruitmentSettingsTable.$inferSelect;
export type UraRecruitment = typeof uraRecruitmentsTable.$inferSelect;
export type UraApplication = typeof uraApplicationsTable.$inferSelect;
export type UraMatch = typeof uraMatchesTable.$inferSelect;