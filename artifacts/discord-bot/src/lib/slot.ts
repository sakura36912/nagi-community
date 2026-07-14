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
        CASE WHEN ${emojiId} = ANY(fixed_emoji_ids)
          THEN fixed_emoji_ids
          ELSE array_append(fixed_emoji_ids, ${emojiId})
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
      fixedEmojiIds: sql`array_remove(fixed_emoji_ids, ${emojiId})`,
      emojiWeights: sql`emoji_weights - ${emojiId}`,
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
      fixedEmojiIds: sql`'{}'::text[]`,
      emojiWeights: sql`'{}'::jsonb`,
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
          ? sql`emoji_weights - ${emojiId}`
          : sql`jsonb_set(emoji_weights, ${`{${emojiId}}`}, ${String(weight)}::jsonb)`,
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
  // Build a SQL expression that replaces element at position `lines` (1-based index = lines+1).
  // PostgreSQL arrays are 1-indexed.
  const [row] = await db
    .update(slotSettingsTable)
    .set({
      payoutMultipliers: sql`
        payout_multipliers[:${lines}] ||
        ARRAY[${multiplier}]::integer[] ||
        payout_multipliers[${lines + 2}:]
      `,
    })
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
