import { eq, and } from "drizzle-orm";
import { db } from "./index.js";
import { communityPrebansTable } from "./schema/community.js";

export async function addPreban(
  guildId: string,
  userId: string,
  addedBy: string,
  reason?: string,
): Promise<void> {
  await db
    .insert(communityPrebansTable)
    .values({ guildId, userId, addedBy, reason: reason ?? null })
    .onConflictDoUpdate({
      target: [communityPrebansTable.guildId, communityPrebansTable.userId],
      set: { reason: reason ?? null, addedBy, createdAt: new Date() },
    });
}

export async function removePreban(guildId: string, userId: string): Promise<boolean> {
  const result = await db
    .delete(communityPrebansTable)
    .where(
      and(
        eq(communityPrebansTable.guildId, guildId),
        eq(communityPrebansTable.userId, userId),
      ),
    )
    .returning({ id: communityPrebansTable.id });
  return result.length > 0;
}

export async function getPreban(guildId: string, userId: string) {
  return db.query.communityPrebansTable.findFirst({
    where: and(
      eq(communityPrebansTable.guildId, guildId),
      eq(communityPrebansTable.userId, userId),
    ),
  });
}

export async function listPrebans(guildId: string) {
  return db.query.communityPrebansTable.findMany({
    where: eq(communityPrebansTable.guildId, guildId),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
}
