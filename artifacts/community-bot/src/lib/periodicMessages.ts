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
        ${periodicMessagesTable.lastPostedAt} <= NOW() - (${periodicMessagesTable.intervalHours} * interval '1 hour')
      )`,
    );
}

/** Mark a periodic message as just posted. */
export async function markPeriodicMessagePosted(id: number): Promise<void> {
  await db
    .update(periodicMessagesTable)
    .set({ lastPostedAt: new Date() })
    .where(eq(periodicMessagesTable.id, id));
}
