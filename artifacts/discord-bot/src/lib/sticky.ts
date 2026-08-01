import { db, stickyMessagesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

export type StickyMessage = typeof stickyMessagesTable.$inferSelect;

/** Upsert a sticky message for a channel. Returns the saved row. */
export async function setStickyMessage(
  guildId: string,
  channelId: string,
  content: string,
): Promise<StickyMessage> {
  const [row] = await db
    .insert(stickyMessagesTable)
    .values({ guildId, channelId, content })
    .onConflictDoUpdate({
      target: [stickyMessagesTable.guildId, stickyMessagesTable.channelId],
      set: { content, lastMessageId: null, updatedAt: new Date() },
    })
    .returning();
  return row!;
}

/** Delete the sticky message setting for a channel. Returns true if one was deleted. */
export async function removeStickyMessage(
  guildId: string,
  channelId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(stickyMessagesTable)
    .where(
      and(
        eq(stickyMessagesTable.guildId, guildId),
        eq(stickyMessagesTable.channelId, channelId),
      ),
    )
    .returning({ id: stickyMessagesTable.id });
  return deleted.length > 0;
}

/** Get the sticky message for a channel, or null if none. */
export async function getStickyMessage(
  guildId: string,
  channelId: string,
): Promise<StickyMessage | null> {
  const [row] = await db
    .select()
    .from(stickyMessagesTable)
    .where(
      and(
        eq(stickyMessagesTable.guildId, guildId),
        eq(stickyMessagesTable.channelId, channelId),
      ),
    );
  return row ?? null;
}

/** List all sticky messages for a guild. */
export async function listStickyMessages(guildId: string): Promise<StickyMessage[]> {
  return db
    .select()
    .from(stickyMessagesTable)
    .where(eq(stickyMessagesTable.guildId, guildId));
}

/** Update the last message ID after re-posting the sticky. */
export async function updateStickyLastMessageId(
  guildId: string,
  channelId: string,
  lastMessageId: string,
): Promise<void> {
  await db
    .update(stickyMessagesTable)
    .set({ lastMessageId })
    .where(
      and(
        eq(stickyMessagesTable.guildId, guildId),
        eq(stickyMessagesTable.channelId, channelId),
      ),
    );
}
