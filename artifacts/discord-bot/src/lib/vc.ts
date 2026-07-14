import { and, eq, lte } from "drizzle-orm";
import { db, vcSchedulesTable, type VcSchedule } from "@workspace/db";

/**
 * Save (or replace) a VC rename schedule.
 * If a schedule already exists for the channel it is overwritten.
 */
export async function saveSchedule(
  guildId: string,
  channelId: string,
  channelName: string,
  expiresAt: Date,
): Promise<VcSchedule> {
  const [row] = await db
    .insert(vcSchedulesTable)
    .values({ guildId, channelId, channelName, expiresAt })
    .onConflictDoUpdate({
      target: vcSchedulesTable.channelId,
      set: { guildId, channelName, expiresAt },
    })
    .returning();

  if (!row) {
    throw new Error("Failed to save VC schedule");
  }
  return row;
}

/** List all active VC schedules for a guild. */
export async function listSchedules(guildId: string): Promise<VcSchedule[]> {
  return db
    .select()
    .from(vcSchedulesTable)
    .where(eq(vcSchedulesTable.guildId, guildId));
}

/** Delete the schedule for a specific channel. Returns true if a row was removed. */
export async function deleteSchedule(channelId: string): Promise<boolean> {
  const deleted = await db
    .delete(vcSchedulesTable)
    .where(eq(vcSchedulesTable.channelId, channelId))
    .returning();
  return deleted.length > 0;
}

/** Return all schedules whose expiry has passed. */
export async function getExpiredSchedules(now: Date): Promise<VcSchedule[]> {
  return db
    .select()
    .from(vcSchedulesTable)
    .where(lte(vcSchedulesTable.expiresAt, now));
}
