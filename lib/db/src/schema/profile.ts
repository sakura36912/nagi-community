import { jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { ProfileSettings } from "../profileRules";

export const profileSettingsTable = pgTable("profile_settings", {
  guildId: text("guild_id").primaryKey(),
  settings: jsonb("settings").$type<ProfileSettings>().notNull().default(sql`'{}'::jsonb`),
});
