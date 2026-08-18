import { pgTable, text, timestamp, jsonb, integer } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Per-guild slot machine configuration.
 * fixed_emoji_ids: Discord custom emoji IDs to use as slot symbols.
 * Empty array = auto-select from all guild emojis each spin.
 * emoji_weights: map of emojiId → weight (integer ≥ 1).
 *   Default weight = 1. Higher = appears more often on the reels.
 */
export const slotSettingsTable = pgTable("slot_settings", {
  guildId: text("guild_id").primaryKey(),
  /** Ordered list of emoji IDs pinned as slot symbols. Empty = auto mode. */
  fixedEmojiIds: text("fixed_emoji_ids")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  /**
   * Ordered list of guild sticker IDs used as slot symbols.
   * When non-empty, sticker mode takes priority over emoji mode.
   */
  stickerIds: text("sticker_ids")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  /**
   * emojiId/stickerId → weight mapping.
   * Weight controls how many times the symbol appears in the reel pool.
   * e.g. weight=5 means that symbol is 5× more likely than weight=1.
   */
  emojiWeights: jsonb("emoji_weights")
    .$type<Record<string, number>>()
    .notNull()
    .default({}),
  /**
   * Net profit multiplier per number of winning paylines (index 0–5).
   *   index 0 = 0 wins → net -1× bet (always lose; configurable for 1–5 only)
   *   index 1 = 1 win  → net +multiplier× bet  (default +1)
   *   …
   *   index 5 = 5 wins → net +multiplier× bet  (default +34, jackpot)
   */
  payoutMultipliers: integer("payout_multipliers")
    .array()
    .notNull()
    .default(sql`'{-1,1,5,11,19,34}'::integer[]`),
  /**
   * Text channel ID to send a jackpot notification when 5 paylines win.
   * Null = no notification.
   */
  jackpotChannelId: text("jackpot_channel_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type SlotSettings = typeof slotSettingsTable.$inferSelect;
