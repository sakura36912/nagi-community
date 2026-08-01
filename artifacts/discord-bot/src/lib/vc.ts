import { and, eq, gt, isNull, lte } from "drizzle-orm";
import { db, vcSchedulesTable, type VcSchedule } from "@workspace/db";

/** Default number of milliseconds before expiry at which we send the warning DM. */
export const NOTIFY_BEFORE_MS = 10 * 60 * 1000; // 10 minutes (kept for reference)

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
 * Return schedules for a specific guild that are within `warnBeforeMs` of
 * expiry but haven't been notified yet. These are candidates for a pre-expiry
 * warning DM.
 *
 * @param guildId      - The guild to query.
 * @param now          - Current time reference.
 * @param warnBeforeMs - Warning window in milliseconds (e.g. 10 * 60 * 1000).
 */
export async function getSchedulesExpiringSoon(
  guildId: string,
  now: Date,
  warnBeforeMs: number,
): Promise<VcSchedule[]> {
  const notifyWindow = new Date(now.getTime() + warnBeforeMs);
  return db
    .select()
    .from(vcSchedulesTable)
    .where(
      and(
        eq(vcSchedulesTable.guildId, guildId),
        gt(vcSchedulesTable.expiresAt, now),           // not yet expired
        lte(vcSchedulesTable.expiresAt, notifyWindow), // within warning window
        isNull(vcSchedulesTable.notifiedAt),            // not yet notified
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

/**
 * Move a schedule's expiry deadline forward and re-arm the pre-expiry warning.
 *
 * Called after a user purchases a VC extension so the scheduler reads the
 * updated deadline and sends a fresh warning DM at the right time.
 * Returns the updated row, or null if no schedule exists for this channel.
 */
export async function extendSchedule(
  channelId: string,
  newExpiresAt: Date,
): Promise<VcSchedule | null> {
  const [row] = await db
    .update(vcSchedulesTable)
    .set({ expiresAt: newExpiresAt, notifiedAt: null })
    .where(eq(vcSchedulesTable.channelId, channelId))
    .returning();
  return row ?? null;
}
