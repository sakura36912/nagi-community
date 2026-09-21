import { and, asc, eq, gte, lte } from "drizzle-orm";
import {
  db,
  shiftUnavailabilityTable,
  shiftSettingsTable,
  shiftsTable,
  type Shift,
  type ShiftSettings,
  type ShiftUnavailability,
} from "@workspace/db";

export { type Shift, type ShiftSettings, type ShiftUnavailability };

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

export async function setShiftSubmitRoles(
  guildId: string,
  roleIds: string[],
): Promise<void> {
  await db
    .insert(shiftSettingsTable)
    .values({ guildId, submitRoleIds: roleIds })
    .onConflictDoUpdate({
      target: shiftSettingsTable.guildId,
      set: { submitRoleIds: roleIds, updatedAt: new Date() },
    });
}

export async function setShiftListRoles(
  guildId: string,
  roleIds: string[],
): Promise<void> {
  await db
    .insert(shiftSettingsTable)
    .values({ guildId, listRoleIds: roleIds })
    .onConflictDoUpdate({
      target: shiftSettingsTable.guildId,
      set: { listRoleIds: roleIds, updatedAt: new Date() },
    });
}

export async function setShiftRewardAmount(
  guildId: string,
  amount: number,
): Promise<void> {
  await db
    .insert(shiftSettingsTable)
    .values({ guildId, shiftRewardAmount: amount })
    .onConflictDoUpdate({
      target: shiftSettingsTable.guildId,
      set: { shiftRewardAmount: amount, updatedAt: new Date() },
    });
}

/**
 * Returns a map of userId → shift count for all users who have shifts
 * in [from, to] (inclusive, "YYYY-MM-DD"). Used by the salary scheduler.
 */
export async function getShiftCountsByUser(
  guildId: string,
  from: string,
  to: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({ userId: shiftsTable.userId })
    .from(shiftsTable)
    .where(
      and(
        eq(shiftsTable.guildId, guildId),
        gte(shiftsTable.date, from),
        lte(shiftsTable.date, to),
      ),
    );
  const counts = new Map<string, number>();
  for (const { userId } of rows) {
    counts.set(userId, (counts.get(userId) ?? 0) + 1);
  }
  return counts;
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

// ─── Weekly unavailability ────────────────────────────────────────────────────

export async function getShiftUnavailability(
  guildId: string,
  userId: string,
  weekStart: string,
): Promise<ShiftUnavailability | undefined> {
  const [row] = await db
    .select()
    .from(shiftUnavailabilityTable)
    .where(and(
      eq(shiftUnavailabilityTable.guildId, guildId),
      eq(shiftUnavailabilityTable.userId, userId),
      eq(shiftUnavailabilityTable.weekStart, weekStart),
    ));
  return row;
}

export async function addShiftUnavailability(
  guildId: string,
  userId: string,
  weekStart: string,
): Promise<ShiftUnavailability> {
  const [row] = await db
    .insert(shiftUnavailabilityTable)
    .values({ guildId, userId, weekStart })
    .onConflictDoUpdate({
      target: [
        shiftUnavailabilityTable.guildId,
        shiftUnavailabilityTable.userId,
        shiftUnavailabilityTable.weekStart,
      ],
      set: { createdAt: new Date() },
    })
    .returning();
  if (!row) throw new Error("Failed to create shift unavailability");
  return row;
}

export async function removeShiftUnavailability(
  guildId: string,
  userId: string,
  weekStart: string,
): Promise<void> {
  await db
    .delete(shiftUnavailabilityTable)
    .where(and(
      eq(shiftUnavailabilityTable.guildId, guildId),
      eq(shiftUnavailabilityTable.userId, userId),
      eq(shiftUnavailabilityTable.weekStart, weekStart),
    ));
}

export async function getShiftUnavailabilitiesInRange(
  guildId: string,
  from: string,
  to: string,
  userId?: string,
): Promise<ShiftUnavailability[]> {
  const conditions = [
    eq(shiftUnavailabilityTable.guildId, guildId),
    gte(shiftUnavailabilityTable.weekStart, from),
    lte(shiftUnavailabilityTable.weekStart, to),
  ];
  if (userId) conditions.push(eq(shiftUnavailabilityTable.userId, userId));

  return db
    .select()
    .from(shiftUnavailabilityTable)
    .where(and(...conditions))
    .orderBy(asc(shiftUnavailabilityTable.weekStart), asc(shiftUnavailabilityTable.userId));
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Duration in minutes between two "HH:MM" strings. May be negative if end < start. */
export function calcMinutes(start: string, end: string): number {
  const [sh = 0, sm = 0] = start.split(":").map(Number);
  const [eh = 0, em = 0] = end.split(":").map(Number);
  const diff = (eh * 60 + em) - (sh * 60 + sm);
  return diff < 0 ? diff + 24 * 60 : diff; // 深夜またぎ対応
}

export function formatDuration(minutes: number): string {
  if (minutes <= 0) return "0分";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}分`;
  return m > 0 ? `${h}時間${m}分` : `${h}時間`;
}
