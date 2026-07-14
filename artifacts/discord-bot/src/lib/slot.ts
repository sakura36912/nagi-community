import { eq, sql } from "drizzle-orm";
import { db, slotSettingsTable, type SlotSettings } from "@workspace/db";

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

/** Add an emoji ID to the fixed pool (no-op if already present). */
export async function addSlotEmoji(
  guildId: string,
  emojiId: string,
): Promise<SlotSettings> {
  // Ensure row exists.
  await getSlotSettings(guildId);
  const [row] = await db
    .update(slotSettingsTable)
    .set({
      fixedEmojiIds: sql`
        CASE WHEN ${emojiId} = ANY(fixed_emoji_ids)
          THEN fixed_emoji_ids
          ELSE array_append(fixed_emoji_ids, ${emojiId})
        END
      `,
    })
    .where(eq(slotSettingsTable.guildId, guildId))
    .returning();
  return row!;
}

/** Remove an emoji ID from the fixed pool. */
export async function removeSlotEmoji(
  guildId: string,
  emojiId: string,
): Promise<SlotSettings> {
  await getSlotSettings(guildId);
  const [row] = await db
    .update(slotSettingsTable)
    .set({
      fixedEmojiIds: sql`array_remove(fixed_emoji_ids, ${emojiId})`,
    })
    .where(eq(slotSettingsTable.guildId, guildId))
    .returning();
  return row!;
}

/** Reset to auto mode (use all guild emojis). */
export async function clearSlotEmojis(guildId: string): Promise<SlotSettings> {
  await getSlotSettings(guildId);
  const [row] = await db
    .update(slotSettingsTable)
    .set({ fixedEmojiIds: sql`'{}'::text[]` })
    .where(eq(slotSettingsTable.guildId, guildId))
    .returning();
  return row!;
}
