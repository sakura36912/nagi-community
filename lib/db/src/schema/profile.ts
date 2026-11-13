import { customType, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { ProfileSettings } from "../profileRules";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const profileSettingsTable = pgTable("profile_settings", {
  guildId: text("guild_id").primaryKey(),
  settings: jsonb("settings").$type<ProfileSettings>().notNull().default(sql`'{}'::jsonb`),
});

export const profileBackgroundsTable = pgTable("profile_backgrounds", {
  guildId: text("guild_id").primaryKey(),
  imageData: bytea("image_data").notNull(),
  contentType: text("content_type").notNull(),
});
