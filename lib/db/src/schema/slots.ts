import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Per-guild slot machine configuration.
 * fixed_emoji_ids: Discord custom emoji IDs to use as slot symbols.
 * Empty array = auto-select from all guild emojis each spin.
 */
export const slotSettingsTable = pgTable("slot_settings", {
  guildId: text("guild_id").primaryKey(),
  /** Ordered list of emoji IDs pinned as slot symbols. Empty = auto mode. */
  fixedEmojiIds: text("fixed_emoji_ids")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type SlotSettings = typeof slotSettingsTable.$inferSelect;
