import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { db } from "./index";
import { ensureZombieSchema } from "./zombieSchema";
import { zombieJobsTable as jobs, type ZombieJob } from "./schema/zombie";
export async function pendingZombieJobs(now = new Date()) {
  await ensureZombieSchema();
  return db.select().from(jobs).where(and(isNull(jobs.deliveredAt), lte(jobs.nextAt, now))).limit(20);
}
export async function zombieDeliveryFailures(guildId: string) {
  await ensureZombieSchema();
  return db.select({ id: jobs.id, error: jobs.error }).from(jobs)
    .where(and(eq(jobs.guildId, guildId), isNull(jobs.deliveredAt), sql`${jobs.error} IS NOT NULL`)).limit(10);
}
export async function deliverZombieJob(id: string, send: (payload: ZombieJob) => Promise<void>, now = new Date()) {
  await ensureZombieSchema();
  return db.transaction(async tx => {
    const [row] = await tx.select().from(jobs).where(and(eq(jobs.id, id), isNull(jobs.deliveredAt), lte(jobs.nextAt, now)))
      .for("update", { skipLocked: true });
    if (!row) return;
    try {
      await send(row.payload);
      await tx.update(jobs).set({ deliveredAt: now, error: null }).where(eq(jobs.id, id));
    } catch {
      // Never store HTTP request headers, tokens, or raw Discord error objects.
      await tx.update(jobs).set({ error: "通知失敗（DM拒否・削除・権限・接続を確認）", nextAt: new Date(now.getTime() + 60000) }).where(eq(jobs.id, id));
    }
  });
}
