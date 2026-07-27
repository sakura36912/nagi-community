import { and, eq } from "drizzle-orm";
import { db, bountiesTable, guildSettingsTable, type Bounty } from "@workspace/db";
import { getOrCreateWallet } from "./economy";

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
 * Deducts `reward` from the poster's wallet and inserts a bounty row.
 * Throws if the poster has insufficient funds.
 */
export async function postBounty(
  guildId: string,
  posterId: string,
  title: string,
  description: string,
  reward: number,
): Promise<Bounty> {
  const wallet = await getOrCreateWallet(guildId, posterId);
  if (wallet.balance < reward) {
    throw new Error("INSUFFICIENT_FUNDS");
  }

  // Deduct from poster
  await db.execute(
    // Use raw SQL for atomic deduction to avoid race conditions
    (await import("drizzle-orm")).sql`
      UPDATE wallets SET balance = balance - ${reward}, updated_at = NOW()
      WHERE guild_id = ${guildId} AND user_id = ${posterId}
    `,
  );

  const [row] = await db
    .insert(bountiesTable)
    .values({ guildId, posterId, title, description, reward })
    .returning();
  return row!;
}

/**
 * Cancels a bounty and refunds the reward to the poster.
 * Only the poster or an admin should call this.
 */
export async function cancelBounty(guildId: string, id: number): Promise<Bounty | undefined> {
  const bounty = await getBounty(guildId, id);
  if (!bounty || bounty.status !== "active") return undefined;

  const [updated] = await db
    .update(bountiesTable)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(and(eq(bountiesTable.guildId, guildId), eq(bountiesTable.id, id)))
    .returning();

  // Refund to poster
  await db.execute(
    (await import("drizzle-orm")).sql`
      UPDATE wallets SET balance = balance + ${bounty.reward}, updated_at = NOW()
      WHERE guild_id = ${guildId} AND user_id = ${bounty.posterId}
    `,
  );

  return updated;
}

/**
 * Awards a bounty to `winnerId` — transfers reward from the held pool
 * (already deducted at post time) to the winner's wallet.
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

  // Pay winner (reward was already deducted from poster at post time)
  await getOrCreateWallet(guildId, winnerId);
  await db.execute(
    (await import("drizzle-orm")).sql`
      UPDATE wallets SET balance = balance + ${bounty.reward}, updated_at = NOW()
      WHERE guild_id = ${guildId} AND user_id = ${winnerId}
    `,
  );

  return updated;
}
