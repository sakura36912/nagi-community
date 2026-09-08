import { and, desc, eq, gt, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { db } from "./index.js";
import {
  randomMatchBlocksTable,
  randomMatchQueueTable,
  randomMatchReportsTable,
  randomMatchesTable,
  randomMatchSettingsTable,
} from "./schema/randomMatch.js";

export const RANDOM_MATCH_ANY = "any" as const;
export const RANDOM_MATCH_MALE = "male" as const;
export const RANDOM_MATCH_FEMALE = "female" as const;
export type RandomMatchPreference =
  | typeof RANDOM_MATCH_ANY
  | typeof RANDOM_MATCH_MALE
  | typeof RANDOM_MATCH_FEMALE;

export async function getRandomMatchSettings(guildId: string) {
  const [settings] = await db
    .insert(randomMatchSettingsTable)
    .values({ guildId })
    .onConflictDoNothing()
    .returning();
  if (settings) return settings;
  const [existing] = await db
    .select()
    .from(randomMatchSettingsTable)
    .where(eq(randomMatchSettingsTable.guildId, guildId))
    .limit(1);
  if (!existing) throw new Error("Failed to load random match settings");
  return existing;
}

export async function setRandomMatchSettings(
  guildId: string,
  patch: Partial<{ enabled: boolean; categoryId: string | null }>,
) {
  await getRandomMatchSettings(guildId);
  const [settings] = await db
    .update(randomMatchSettingsTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(randomMatchSettingsTable.guildId, guildId))
    .returning();
  if (!settings) throw new Error("Failed to update random match settings");
  return settings;
}

export async function listRandomMatchQueue(guildId: string) {
  return db
    .select()
    .from(randomMatchQueueTable)
    .where(eq(randomMatchQueueTable.guildId, guildId))
    .orderBy(randomMatchQueueTable.joinedAt);
}

export async function getRandomMatchQueueEntry(guildId: string, userId: string) {
  const [entry] = await db
    .select()
    .from(randomMatchQueueTable)
    .where(and(eq(randomMatchQueueTable.guildId, guildId), eq(randomMatchQueueTable.userId, userId)))
    .limit(1);
  return entry ?? null;
}

export async function joinRandomMatchQueue(
  guildId: string,
  userId: string,
  preference: RandomMatchPreference,
  r18Allowed: boolean,
) {
  const [entry] = await db
    .insert(randomMatchQueueTable)
    .values({ guildId, userId, preference, r18Allowed })
    .onConflictDoUpdate({
      target: [randomMatchQueueTable.guildId, randomMatchQueueTable.userId],
      set: { preference, r18Allowed },
    })
    .returning();
  return entry;
}

export async function leaveRandomMatchQueue(guildId: string, userId: string) {
  await db
    .delete(randomMatchQueueTable)
    .where(and(eq(randomMatchQueueTable.guildId, guildId), eq(randomMatchQueueTable.userId, userId)));
}

export async function clearRandomMatchQueue(guildId: string) {
  await db.delete(randomMatchQueueTable).where(eq(randomMatchQueueTable.guildId, guildId));
}

export async function listRandomMatchBlocks(guildId: string, userId?: string) {
  return db
    .select()
    .from(randomMatchBlocksTable)
    .where(
      userId
        ? and(eq(randomMatchBlocksTable.guildId, guildId), eq(randomMatchBlocksTable.blockerId, userId))
        : eq(randomMatchBlocksTable.guildId, guildId),
    );
}

export async function isRandomMatchBlocked(guildId: string, userAId: string, userBId: string) {
  const rows = await db
    .select()
    .from(randomMatchBlocksTable)
    .where(
      and(
        eq(randomMatchBlocksTable.guildId, guildId),
        or(
          and(
            eq(randomMatchBlocksTable.blockerId, userAId),
            eq(randomMatchBlocksTable.blockedId, userBId),
          ),
          and(
            eq(randomMatchBlocksTable.blockerId, userBId),
            eq(randomMatchBlocksTable.blockedId, userAId),
          ),
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function addRandomMatchBlock(guildId: string, blockerId: string, blockedId: string) {
  await db
    .insert(randomMatchBlocksTable)
    .values({ guildId, blockerId, blockedId })
    .onConflictDoNothing();
}

export async function removeRandomMatchBlock(guildId: string, blockerId: string, blockedId: string) {
  await db
    .delete(randomMatchBlocksTable)
    .where(
      and(
        eq(randomMatchBlocksTable.guildId, guildId),
        eq(randomMatchBlocksTable.blockerId, blockerId),
        eq(randomMatchBlocksTable.blockedId, blockedId),
      ),
    );
}

export async function createRandomMatchIfWaiting(
  guildId: string,
  userAId: string,
  userBId: string,
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`random-match:${guildId}`}))`);
    const queue = await tx
      .select()
      .from(randomMatchQueueTable)
      .where(
        and(
          eq(randomMatchQueueTable.guildId, guildId),
          inArray(randomMatchQueueTable.userId, [userAId, userBId]),
        ),
      );
    if (queue.length !== 2) return null;
    await tx
      .delete(randomMatchQueueTable)
      .where(
        and(
          eq(randomMatchQueueTable.guildId, guildId),
          inArray(randomMatchQueueTable.userId, [userAId, userBId]),
        ),
      );
    const [match] = await tx
      .insert(randomMatchesTable)
      .values({
        guildId,
        userAId,
        userBId,
        r18Allowed: queue[0]?.r18Allowed ?? false,
        status: "active",
      })
      .returning();
    return match ?? null;
  });
}

export async function requeueRandomMatchUsers(
  guildId: string,
  users: Array<{ userId: string; preference: RandomMatchPreference; r18Allowed: boolean }>,
) {
  await db
    .insert(randomMatchQueueTable)
    .values(users.map((user) => ({ guildId, ...user })))
    .onConflictDoNothing();
}

export async function attachRandomMatchChannel(matchId: number, channelId: string) {
  const [match] = await db
    .update(randomMatchesTable)
    .set({ channelId })
    .where(eq(randomMatchesTable.id, matchId))
    .returning();
  return match ?? null;
}

export async function getRandomMatchByChannelId(channelId: string) {
  const [match] = await db
    .select()
    .from(randomMatchesTable)
    .where(and(eq(randomMatchesTable.channelId, channelId), eq(randomMatchesTable.status, "active")))
    .limit(1);
  return match ?? null;
}

export async function getRandomMatchById(matchId: number) {
  const [match] = await db
    .select()
    .from(randomMatchesTable)
    .where(eq(randomMatchesTable.id, matchId))
    .limit(1);
  return match ?? null;
}

export async function getActiveRandomMatchForUser(guildId: string, userId: string) {
  const [match] = await db
    .select()
    .from(randomMatchesTable)
    .where(
      and(
        eq(randomMatchesTable.guildId, guildId),
        eq(randomMatchesTable.status, "active"),
        or(eq(randomMatchesTable.userAId, userId), eq(randomMatchesTable.userBId, userId)),
      ),
    )
    .orderBy(desc(randomMatchesTable.createdAt))
    .limit(1);
  return match ?? null;
}

export async function getRandomMatchCooldown(guildId: string, userId: string, since: Date) {
  const [match] = await db
    .select()
    .from(randomMatchesTable)
    .where(
      and(
        eq(randomMatchesTable.guildId, guildId),
        gt(randomMatchesTable.createdAt, since),
        or(eq(randomMatchesTable.userAId, userId), eq(randomMatchesTable.userBId, userId)),
      ),
    )
    .orderBy(desc(randomMatchesTable.createdAt))
    .limit(1);
  return match ?? null;
}

export async function markRandomMatchDeleteAt(matchId: number, deleteAt: Date | null) {
  const [match] = await db
    .update(randomMatchesTable)
    .set({ deleteAt })
    .where(and(eq(randomMatchesTable.id, matchId), eq(randomMatchesTable.status, "active")))
    .returning();
  return match ?? null;
}

export async function listRandomMatchesReadyForDeletion(now: Date) {
  return db
    .select()
    .from(randomMatchesTable)
    .where(and(eq(randomMatchesTable.status, "active"), lte(randomMatchesTable.deleteAt, now)));
}

export async function finishRandomMatch(matchId: number) {
  const [match] = await db
    .update(randomMatchesTable)
    .set({ status: "finished", endedAt: new Date(), deleteAt: null })
    .where(and(eq(randomMatchesTable.id, matchId), ne(randomMatchesTable.status, "finished")))
    .returning();
  return match ?? null;
}

export async function cancelRandomMatch(matchId: number) {
  const [match] = await db
    .update(randomMatchesTable)
    .set({ status: "cancelled", endedAt: new Date(), deleteAt: null })
    .where(and(eq(randomMatchesTable.id, matchId), eq(randomMatchesTable.status, "active")))
    .returning();
  return match ?? null;
}

export async function createRandomMatchReport(
  guildId: string,
  matchId: number,
  reporterId: string,
  reportedId: string,
  reason: string,
) {
  const [report] = await db
    .insert(randomMatchReportsTable)
    .values({ guildId, matchId, reporterId, reportedId, reason })
    .returning();
  return report;
}

export async function listRandomMatchReports(guildId: string) {
  return db
    .select()
    .from(randomMatchReportsTable)
    .where(eq(randomMatchReportsTable.guildId, guildId))
    .orderBy(desc(randomMatchReportsTable.createdAt))
    .limit(25);
}