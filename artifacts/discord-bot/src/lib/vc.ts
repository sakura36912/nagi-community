import { and, eq, lte, sql } from "drizzle-orm";
import { db, vcSchedulesTable, type VcSchedule } from "@workspace/db";

export async function createVcSchedule(
  guildId: string,
  channelId: string,
  newName: string,
  originalName: string,
  scheduledDeleteAt: Date,
  createdBy: string,
): Promise<VcSchedule> {
  const [schedule] = await db
    .insert(vcSchedulesTable)
    .values({ guildId, channelId, newName, originalName, scheduledDeleteAt, createdBy })
    .onConflictDoUpdate({
      target: [vcSchedulesTable.guildId, vcSchedulesTable.channelId],
      set: { newName, originalName, scheduledDeleteAt, createdBy },
    })
    .returning();

  if (!schedule) throw new Error("Failed to create VC schedule");
  return schedule;
}

export async function cancelVcSchedule(
  guildId: string,
  channelId: string,
): Promise<VcSchedule | undefined> {
  const [deleted] = await db
    .delete(vcSchedulesTable)
    .where(
      and(eq(vcSchedulesTable.guildId, guildId), eq(vcSchedulesTable.channelId, channelId)),
    )
    .returning();
  return deleted;
}

export async function listVcSchedules(guildId: string): Promise<VcSchedule[]> {
  return db
    .select()
    .from(vcSchedulesTable)
    .where(eq(vcSchedulesTable.guildId, guildId))
    .orderBy(vcSchedulesTable.scheduledDeleteAt);
}

// Returns all schedules whose deletion time has passed (across all guilds).
export async function getDueVcSchedules(now: Date): Promise<VcSchedule[]> {
  return db
    .select()
    .from(vcSchedulesTable)
    .where(lte(vcSchedulesTable.scheduledDeleteAt, now));
}

export async function deleteVcScheduleById(id: number): Promise<void> {
  await db.delete(vcSchedulesTable).where(eq(vcSchedulesTable.id, id));
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}日`);
  if (hours > 0) parts.push(`${hours}時間`);
  if (minutes > 0) parts.push(`${minutes}分`);
  return parts.length > 0 ? parts.join("") : "1分未満";
}
