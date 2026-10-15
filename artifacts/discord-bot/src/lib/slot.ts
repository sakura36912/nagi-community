import { eq, sql } from "drizzle-orm";
import { db, slotSettingsTable, type SlotSettings } from "@workspace/db";

export { type SlotSettings };

// ─── Default payout multipliers (net profit per bet) ─────────────────────────
// Index = number of winning paylines (0–5).
// index 0 is always -1 (lose bet). Indices 1–5 are configurable per guild.
export const DEFAULT_MULTIPLIERS = [-1, 1, 5, 11, 19, 34] as const;

// ─── Settings ─────────────────────────────────────────────────────────────────

export async function getSlotSettings(guildId: string): Promise<SlotSettings> {
  const [row] = await db
    .select()
    .from(slotSettingsTable)
    .where(eq(slotSettingsTable.guildId, guildId));
  if (row) return row;
  const [created] = await db
    .insert(slotSettingsTable)
    .values({ guildId })
    .returning();
  return created!;
}

// ─── Sticker list management ──────────────────────────────────────────────────

export async function addSlotSticker(
  guildId: string,
  stickerId: string,
): Promise<SlotSettings> {
  await getSlotSettings(guildId);
  const [row] = await db
    .update(slotSettingsTable)
    .set({
      stickerIds: sql`
        CASE WHEN EXISTS (SELECT 1 FROM json_each(sticker_ids) WHERE value = ${stickerId})
          THEN sticker_ids
          ELSE json_insert(sticker_ids, '$[#]', ${stickerId})
        END`,
    })
    .where(eq(slotSettingsTable.guildId, guildId))
    .returning();
  return row!;
}

export async function removeSlotSticker(
  guildId: string,
  stickerId: string,
): Promise<SlotSettings> {
  await getSlotSettings(guildId);
  const [row] = await db
    .update(slotSettingsTable)
    .set({
      stickerIds: sql`(SELECT json_group_array(value) FROM json_each(sticker_ids) WHERE value <> ${stickerId})`,
      emojiWeights: sql`json_remove(emoji_weights, ${`$."${stickerId}"`})`,
    })
    .where(eq(slotSettingsTable.guildId, guildId))
    .returning();
  return row!;
}

export async function clearSlotStickers(guildId: string): Promise<SlotSettings> {
  await getSlotSettings(guildId);
  const [row] = await db
    .update(slotSettingsTable)
    .set({
      stickerIds: [],
    })
    .where(eq(slotSettingsTable.guildId, guildId))
    .returning();
  return row!;
}

// ─── Emoji list management ────────────────────────────────────────────────────

export async function addSlotEmoji(
  guildId: string,
  emojiId: string,
): Promise<SlotSettings> {
  await getSlotSettings(guildId);
  const [row] = await db
    .update(slotSettingsTable)
    .set({
      fixedEmojiIds: sql`
        CASE WHEN EXISTS (SELECT 1 FROM json_each(fixed_emoji_ids) WHERE value = ${emojiId})
          THEN fixed_emoji_ids
          ELSE json_insert(fixed_emoji_ids, '$[#]', ${emojiId})
        END`,
    })
    .where(eq(slotSettingsTable.guildId, guildId))
    .returning();
  return row!;
}

export async function removeSlotEmoji(
  guildId: string,
  emojiId: string,
): Promise<SlotSettings> {
  await getSlotSettings(guildId);
  const [row] = await db
    .update(slotSettingsTable)
    .set({
      fixedEmojiIds: sql`(SELECT json_group_array(value) FROM json_each(fixed_emoji_ids) WHERE value <> ${emojiId})`,
      emojiWeights: sql`json_remove(emoji_weights, ${`$."${emojiId}"`})`,
    })
    .where(eq(slotSettingsTable.guildId, guildId))
    .returning();
  return row!;
}

export async function clearSlotEmojis(guildId: string): Promise<SlotSettings> {
  await getSlotSettings(guildId);
  const [row] = await db
    .update(slotSettingsTable)
    .set({
      fixedEmojiIds: [],
      emojiWeights: {},
    })
    .where(eq(slotSettingsTable.guildId, guildId))
    .returning();
  return row!;
}

// ─── Weight management ────────────────────────────────────────────────────────

/**
 * Set the reel weight for a specific emoji.
 * weight=1 is the default (removes the entry from the map to keep storage clean).
 * weight=5 means that symbol fills 5× as many slots in the reel pool.
 */
export async function setSlotEmojiWeight(
  guildId: string,
  emojiId: string,
  weight: number,
): Promise<SlotSettings> {
  await getSlotSettings(guildId);
  const [row] = await db
    .update(slotSettingsTable)
    .set({
      emojiWeights:
        weight === 1
          ? sql`json_remove(emoji_weights, ${`$."${emojiId}"`})`
          : sql`json_set(emoji_weights, ${`$."${emojiId}"`}, ${weight})`,
    })
    .where(eq(slotSettingsTable.guildId, guildId))
    .returning();
  return row!;
}

// ─── Payout management ───────────────────────────────────────────────────────

/**
 * Set the net profit multiplier for a given number of winning paylines (1–5).
 * multiplier = net profit as a multiple of the bet.
 * e.g. lines=1, multiplier=3 → winning 1 line pays back bet + 3× profit.
 * lines=0 is fixed at -1 (always lose bet) and cannot be changed.
 */
export async function setSlotPayout(
  guildId: string,
  lines: number,
  multiplier: number,
): Promise<SlotSettings> {
  await getSlotSettings(guildId);
  // SQLite JSON arrays use the same zero-based indices as JavaScript.
  const [row] = await db
    .update(slotSettingsTable)
    .set({
      payoutMultipliers: sql`json_set(payout_multipliers, ${`$[${lines}]`}, ${multiplier})`,
    })
    .where(eq(slotSettingsTable.guildId, guildId))
    .returning();
  return row!;
}

/** Set the chance of at least one winning payline. NULL restores the original draw behavior. */
export async function setSlotWinRate(
  guildId: string,
  winRate: number | null,
): Promise<SlotSettings> {
  await getSlotSettings(guildId);
  const [row] = await db
    .update(slotSettingsTable)
    .set({ winRate })
    .where(eq(slotSettingsTable.guildId, guildId))
    .returning();
  return row!;
}

// ─── Jackpot channel management ──────────────────────────────────────────────

/**
 * Set (or clear) the jackpot notification channel for a guild.
 * Pass null to disable notifications.
 */
export async function setSlotJackpotChannel(
  guildId: string,
  channelId: string | null,
): Promise<SlotSettings> {
  await getSlotSettings(guildId);
  const [row] = await db
    .update(slotSettingsTable)
    .set({ jackpotChannelId: channelId })
    .where(eq(slotSettingsTable.guildId, guildId))
    .returning();
  return row!;
}

/** Resolve the multiplier array, falling back to defaults for missing elements. */
export function resolveMultipliers(stored: number[] | null): number[] {
  const base = [...DEFAULT_MULTIPLIERS] as number[];
  if (!stored) return base;
  for (let i = 0; i < base.length; i++) {
    if (stored[i] !== undefined) base[i] = stored[i]!;
  }
  return base;
}
