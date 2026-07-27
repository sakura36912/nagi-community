import { and, eq, gt, isNull, lte } from "drizzle-orm";
import { db, vcSchedulesTable, type VcSchedule } from "@workspace/db";

/** Number of milliseconds before expiry at which we send the warning DM. */
export const NOTIFY_BEFORE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Save (or replace) a VC rename schedule.
 * If a schedule already exists for the channel it is overwritten.
 */
export async function saveSchedule(
  guildId: string,
  channelId: string,
  channelName: string,
  expiresAt: Date,
  userId?: string,
): Promise<VcSchedule> {
  const [row] = await db
    .insert(vcSchedulesTable)
    .values({ guildId, channelId, channelName, expiresAt, userId: userId ?? null })
    .onConflictDoUpdate({
      target: vcSchedulesTable.channelId,
      set: { guildId, channelName, expiresAt, userId: userId ?? null, notifiedAt: null },
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

/**
 * Return schedules that are within NOTIFY_BEFORE_MS of expiry but haven't been
 * notified yet. These are candidates for a pre-expiry warning DM.
 */
export async function getSchedulesExpiringSoon(now: Date): Promise<VcSchedule[]> {
  const notifyWindow = new Date(now.getTime() + NOTIFY_BEFORE_MS);
  return db
    .select()
    .from(vcSchedulesTable)
    .where(
      and(
        gt(vcSchedulesTable.expiresAt, now),          // not yet expired
        lte(vcSchedulesTable.expiresAt, notifyWindow), // within warning window
        isNull(vcSchedulesTable.notifiedAt),           // not yet notified
      ),
    );
}

/** Mark a schedule as having had its pre-expiry notification sent. */
export async function markScheduleNotified(id: number, at: Date): Promise<void> {
  await db
    .update(vcSchedulesTable)
    .set({ notifiedAt: at })
    .where(eq(vcSchedulesTable.id, id));
}
