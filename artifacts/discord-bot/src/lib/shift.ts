import { and, asc, eq, gte, lte } from "drizzle-orm";
import {
  db,
  shiftSettingsTable,
  shiftsTable,
  type Shift,
  type ShiftSettings,
} from "@workspace/db";

export { type Shift, type ShiftSettings };

// ─── Settings ─────────────────────────────────────────────────────────────────

export async function getShiftSettings(guildId: string): Promise<ShiftSettings | undefined> {
  const [row] = await db
    .select()
    .from(shiftSettingsTable)
    .where(eq(shiftSettingsTable.guildId, guildId));
  return row;
}

export async function setShiftSettings(
  guildId: string,
  channelId: string | null,
): Promise<void> {
  await db
    .insert(shiftSettingsTable)
    .values({ guildId, channelId })
    .onConflictDoUpdate({
      target: shiftSettingsTable.guildId,
      set: { channelId, updatedAt: new Date() },
    });
}

export async function getAllShiftSettings(): Promise<ShiftSettings[]> {
  return db.select().from(shiftSettingsTable);
}

// ─── Shifts ───────────────────────────────────────────────────────────────────

export async function addShift(
  guildId: string,
  userId: string,
  date: string,
  startTime: string,
  endTime: string,
  note?: string | null,
): Promise<Shift> {
  const [row] = await db
    .insert(shiftsTable)
    .values({ guildId, userId, date, startTime, endTime, note: note ?? null })
    .returning();
  if (!row) throw new Error("Failed to create shift");
  return row;
}

export async function removeShift(
  id: number,
  guildId: string,
  requesterId: string,
  isAdmin: boolean,
): Promise<"ok" | "not_found" | "forbidden"> {
  const [existing] = await db
    .select()
    .from(shiftsTable)
    .where(eq(shiftsTable.id, id));
  if (!existing || existing.guildId !== guildId) return "not_found";
  if (!isAdmin && existing.userId !== requesterId) return "forbidden";
  await db.delete(shiftsTable).where(eq(shiftsTable.id, id));
  return "ok";
}

/**
 * Returns all shifts for a guild between from and to (inclusive), ordered by
 * date then start time. Pass userId to restrict to one user.
 */
export async function getShiftsInRange(
  guildId: string,
  from: string,
  to: string,
  userId?: string,
): Promise<Shift[]> {
  const conditions = [
    eq(shiftsTable.guildId, guildId),
    gte(shiftsTable.date, from),
    lte(shiftsTable.date, to),
  ];
  if (userId) conditions.push(eq(shiftsTable.userId, userId));

  return db
    .select()
    .from(shiftsTable)
    .where(and(...conditions))
    .orderBy(asc(shiftsTable.date), asc(shiftsTable.startTime));
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Duration in minutes between two "HH:MM" strings. May be negative if end < start. */
export function calcMinutes(start: string, end: string): number {
  const [sh = 0, sm = 0] = start.split(":").map(Number);
  const [eh = 0, em = 0] = end.split(":").map(Number);
  return (eh * 60 + em) - (sh * 60 + sm);
}

export function formatDuration(minutes: number): string {
  if (minutes <= 0) return "0分";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}分`;
  return m > 0 ? `${h}時間${m}分` : `${h}時間`;
}
