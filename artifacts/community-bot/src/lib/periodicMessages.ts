import { db, periodicMessagesTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import type { PeriodicMessage } from "@workspace/db";

/** Return all enabled periodic messages that are due to be posted. */
export async function getDuePeriodicMessages(): Promise<PeriodicMessage[]> {
  return db
    .select()
    .from(periodicMessagesTable)
    .where(
      sql`${periodicMessagesTable.enabled} = true AND (
        ${periodicMessagesTable.lastPostedAt} IS NULL OR
        ${periodicMessagesTable.lastPostedAt} <= cast(unixepoch('subsec') * 1000000 as integer) - (${periodicMessagesTable.intervalHours} * 3600000000)
      )`,
    );
}

/** Return all periodic messages for a guild. */
export async function listPeriodicMessages(guildId: string): Promise<PeriodicMessage[]> {
  return db
    .select()
    .from(periodicMessagesTable)
    .where(eq(periodicMessagesTable.guildId, guildId));
}

/** Add a new periodic message. */
export async function addPeriodicMessage(
  guildId: string,
  channelId: string,
  message: string,
  intervalHours: number,
): Promise<PeriodicMessage> {
  const [row] = await db
    .insert(periodicMessagesTable)
    .values({ guildId, channelId, message, intervalHours, enabled: true })
    .returning();
  return row!;
}

/** Remove a periodic message by ID (scoped to guild). Returns true if deleted. */
export async function removePeriodicMessage(guildId: string, id: number): Promise<boolean> {
  const result = await db
    .delete(periodicMessagesTable)
    .where(sql`${periodicMessagesTable.id} = ${id} AND ${periodicMessagesTable.guildId} = ${guildId}`)
    .returning();
  return result.length > 0;
}

/** Toggle enabled state. Returns the updated row, or null if not found. */
export async function togglePeriodicMessage(guildId: string, id: number): Promise<PeriodicMessage | null> {
  const [row] = await db
    .update(periodicMessagesTable)
    .set({ enabled: sql`NOT ${periodicMessagesTable.enabled}` })
    .where(sql`${periodicMessagesTable.id} = ${id} AND ${periodicMessagesTable.guildId} = ${guildId}`)
    .returning();
  return row ?? null;
}

/** Edit the message text and/or interval of a periodic message. Returns the updated row, or null if not found. */
export async function editPeriodicMessage(
  guildId: string,
  id: number,
  updates: { message?: string; intervalHours?: number },
): Promise<PeriodicMessage | null> {
  const [row] = await db
    .update(periodicMessagesTable)
    .set(updates)
    .where(sql`${periodicMessagesTable.id} = ${id} AND ${periodicMessagesTable.guildId} = ${guildId}`)
    .returning();
  return row ?? null;
}

/** Mark a periodic message as just posted. */
export async function markPeriodicMessagePosted(id: number): Promise<void> {
  await db
    .update(periodicMessagesTable)
    .set({ lastPostedAt: new Date() })
    .where(eq(periodicMessagesTable.id, id));
}
