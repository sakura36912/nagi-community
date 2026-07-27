import { and, eq } from "drizzle-orm";
import { db, bountiesTable, guildSettingsTable, type Bounty } from "@workspace/db";
import { deductPoints, addPoints, getPointBalance } from "./points";

export { type Bounty };

// ── Settings ──────────────────────────────────────────────────────────────────

export async function setBountyPosterRoleId(
  guildId: string,
  roleId: string | null,
): Promise<void> {
  await db
    .update(guildSettingsTable)
    .set({ bountyPosterRoleId: roleId, updatedAt: new Date() })
    .where(eq(guildSettingsTable.guildId, guildId));
}

// ── Bounty CRUD ───────────────────────────────────────────────────────────────

export async function listActiveBounties(guildId: string): Promise<Bounty[]> {
  return db
    .select()
    .from(bountiesTable)
    .where(and(eq(bountiesTable.guildId, guildId), eq(bountiesTable.status, "active")));
}

export async function getBounty(guildId: string, id: number): Promise<Bounty | undefined> {
  const [row] = await db
    .select()
    .from(bountiesTable)
    .where(and(eq(bountiesTable.guildId, guildId), eq(bountiesTable.id, id)));
  return row;
}

/**
 * Deducts `reward` pts from the poster's point balance and inserts a bounty row.
 * Throws "INSUFFICIENT_POINTS" if the poster has too few points.
 */
export async function postBounty(
  guildId: string,
  posterId: string,
  title: string,
  description: string,
  reward: number,
): Promise<Bounty> {
  // Deduct points atomically (throws INSUFFICIENT_POINTS if not enough)
  await deductPoints(guildId, posterId, reward, "bounty_post", `懸賞金掲載「${title}」`);

  const [row] = await db
    .insert(bountiesTable)
    .values({ guildId, posterId, title, description, reward })
    .returning();
  return row!;
}

/**
 * Cancels a bounty and refunds the reward points to the poster.
 */
export async function cancelBounty(guildId: string, id: number): Promise<Bounty | undefined> {
  const bounty = await getBounty(guildId, id);
  if (!bounty || bounty.status !== "active") return undefined;

  const [updated] = await db
    .update(bountiesTable)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(and(eq(bountiesTable.guildId, guildId), eq(bountiesTable.id, id)))
    .returning();

  // Refund points to poster
  await addPoints(guildId, bounty.posterId, bounty.reward, "bounty_refund", `懸賞金キャンセル返金「${bounty.title}」`);

  return updated;
}

/**
 * Awards a bounty to `winnerId` — points were already deducted at post time,
 * so just credit the winner.
 */
export async function awardBounty(
  guildId: string,
  id: number,
  winnerId: string,
): Promise<Bounty | undefined> {
  const bounty = await getBounty(guildId, id);
  if (!bounty || bounty.status !== "active") return undefined;

  const [updated] = await db
    .update(bountiesTable)
    .set({ status: "awarded", awardedTo: winnerId, updatedAt: new Date() })
    .where(and(eq(bountiesTable.guildId, guildId), eq(bountiesTable.id, id)))
    .returning();

  await addPoints(guildId, winnerId, bounty.reward, "bounty_award", `懸賞金受取「${bounty.title}」`);

  return updated;
}

export { getPointBalance as getPosterPointBalance };
