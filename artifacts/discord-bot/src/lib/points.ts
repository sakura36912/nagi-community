import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  pointBalancesTable,
  pointTransactionsTable,
  pointSettingsTable,
  pointVcCategoryConfigsTable,
  pointVcSessionsTable,
  pointRoleConfigsTable,
  pointRankConfigsTable,
  type PointBalance,
  type PointSettings,
  type PointVcCategoryConfig,
  type PointVcSession,
  type PointRoleConfig,
  type PointRankConfig,
  type PointTransaction,
} from "@workspace/db";
import { logger } from "./logger";

export type {
  PointBalance, PointSettings, PointVcCategoryConfig,
  PointVcSession, PointRoleConfig, PointRankConfig, PointTransaction,
};

// ── Balance ────────────────────────────────────────────────────────────────────

export async function getOrCreatePointBalance(guildId: string, userId: string): Promise<PointBalance> {
  const [existing] = await db
    .select()
    .from(pointBalancesTable)
    .where(and(eq(pointBalancesTable.guildId, guildId), eq(pointBalancesTable.userId, userId)));
  if (existing) return existing;

  const [row] = await db
    .insert(pointBalancesTable)
    .values({ guildId, userId })
    .onConflictDoNothing()
    .returning();
  return row ?? (await getOrCreatePointBalance(guildId, userId));
}

export async function getPointBalance(guildId: string, userId: string): Promise<number> {
  const bal = await getOrCreatePointBalance(guildId, userId);
  return bal.balance;
}

/** Add points and record in transaction log. */
export async function addPoints(
  guildId: string,
  userId: string,
  amount: number,
  type: string,
  note?: string,
): Promise<void> {
  if (amount <= 0) return;
  await getOrCreatePointBalance(guildId, userId);
  await db.execute(
    sql`UPDATE point_balances SET balance = balance + ${amount}, updated_at = NOW()
        WHERE guild_id = ${guildId} AND user_id = ${userId}`,
  );
  await db.insert(pointTransactionsTable).values({ guildId, userId, amount, type, note });
}

/**
 * Deduct points and record in transaction log.
 * Throws "INSUFFICIENT_POINTS" if balance is too low.
 */
export async function deductPoints(
  guildId: string,
  userId: string,
  amount: number,
  type: string,
  note?: string,
): Promise<void> {
  const bal = await getPointBalance(guildId, userId);
  if (bal < amount) throw new Error("INSUFFICIENT_POINTS");
  await db.execute(
    sql`UPDATE point_balances SET balance = balance - ${amount}, updated_at = NOW()
        WHERE guild_id = ${guildId} AND user_id = ${userId}`,
  );
  await db.insert(pointTransactionsTable).values({ guildId, userId, amount: -amount, type, note });
}

export async function getRecentTransactions(guildId: string, userId: string, limit = 10): Promise<PointTransaction[]> {
  return db
    .select()
    .from(pointTransactionsTable)
    .where(and(eq(pointTransactionsTable.guildId, guildId), eq(pointTransactionsTable.userId, userId)))
    .orderBy(desc(pointTransactionsTable.createdAt))
    .limit(limit);
}

// ── Settings ───────────────────────────────────────────────────────────────────

export async function getOrCreatePointSettings(guildId: string): Promise<PointSettings> {
  const [existing] = await db
    .select()
    .from(pointSettingsTable)
    .where(eq(pointSettingsTable.guildId, guildId));
  if (existing) return existing;
  const [row] = await db.insert(pointSettingsTable).values({ guildId }).onConflictDoNothing().returning();
  return row ?? (await getOrCreatePointSettings(guildId));
}

export async function setBoostPoints(guildId: string, boostPoints: number): Promise<void> {
  await getOrCreatePointSettings(guildId);
  await db
    .update(pointSettingsTable)
    .set({ boostPoints, updatedAt: new Date() })
    .where(eq(pointSettingsTable.guildId, guildId));
}

// ── VC Category Configs ────────────────────────────────────────────────────────

export async function listVcCategoryConfigs(guildId: string): Promise<PointVcCategoryConfig[]> {
  return db
    .select()
    .from(pointVcCategoryConfigsTable)
    .where(eq(pointVcCategoryConfigsTable.guildId, guildId));
}

export async function upsertVcCategoryConfig(
  guildId: string,
  categoryId: string,
  pointsPerHour: number,
): Promise<void> {
  await db
    .insert(pointVcCategoryConfigsTable)
    .values({ guildId, categoryId, pointsPerHour })
    .onConflictDoUpdate({
      target: [pointVcCategoryConfigsTable.guildId, pointVcCategoryConfigsTable.categoryId],
      set: { pointsPerHour },
    });
}

export async function removeVcCategoryConfig(guildId: string, categoryId: string): Promise<boolean> {
  const result = await db
    .delete(pointVcCategoryConfigsTable)
    .where(
      and(
        eq(pointVcCategoryConfigsTable.guildId, guildId),
        eq(pointVcCategoryConfigsTable.categoryId, categoryId),
      ),
    );
  return (result.rowCount ?? 0) > 0;
}

// ── VC Session Tracking ───────────────────────────────────────────────────────

export async function recordPointVcJoin(
  guildId: string,
  userId: string,
  categoryId: string,
): Promise<void> {
  await db
    .insert(pointVcSessionsTable)
    .values({ guildId, userId, categoryId })
    .onConflictDoUpdate({
      target: [pointVcSessionsTable.guildId, pointVcSessionsTable.userId],
      set: { categoryId, joinedAt: new Date() },
    });
}

/**
 * Clears the VC session and returns points earned (0 if no session or no config).
 * Also awards the points to the user.
 */
export async function settlePointVcSession(
  guildId: string,
  userId: string,
): Promise<number> {
  const [session] = await db
    .select()
    .from(pointVcSessionsTable)
    .where(and(eq(pointVcSessionsTable.guildId, guildId), eq(pointVcSessionsTable.userId, userId)));

  if (!session) return 0;

  await db
    .delete(pointVcSessionsTable)
    .where(and(eq(pointVcSessionsTable.guildId, guildId), eq(pointVcSessionsTable.userId, userId)));

  const [config] = await db
    .select()
    .from(pointVcCategoryConfigsTable)
    .where(
      and(
        eq(pointVcCategoryConfigsTable.guildId, guildId),
        eq(pointVcCategoryConfigsTable.categoryId, session.categoryId),
      ),
    );
  if (!config || config.pointsPerHour <= 0) return 0;

  const hours = (Date.now() - session.joinedAt.getTime()) / 3_600_000;
  const earned = Math.floor(hours * config.pointsPerHour);
  if (earned <= 0) return 0;

  await addPoints(guildId, userId, earned, "vc_time", `VC ${Math.floor(hours * 60)}分滞在`);
  return earned;
}

// ── Role Configs ───────────────────────────────────────────────────────────────

export async function listRoleConfigs(guildId: string): Promise<PointRoleConfig[]> {
  return db
    .select()
    .from(pointRoleConfigsTable)
    .where(eq(pointRoleConfigsTable.guildId, guildId));
}

export async function upsertRoleConfig(
  guildId: string,
  roleId: string,
  pointsPerDay: number,
): Promise<void> {
  await db
    .insert(pointRoleConfigsTable)
    .values({ guildId, roleId, pointsPerDay })
    .onConflictDoUpdate({
      target: [pointRoleConfigsTable.guildId, pointRoleConfigsTable.roleId],
      set: { pointsPerDay },
    });
}

export async function removeRoleConfig(guildId: string, roleId: string): Promise<boolean> {
  const result = await db
    .delete(pointRoleConfigsTable)
    .where(and(eq(pointRoleConfigsTable.guildId, guildId), eq(pointRoleConfigsTable.roleId, roleId)));
  return (result.rowCount ?? 0) > 0;
}

/**
 * Award daily role-tenure points to all members holding configured roles.
 * Should be called once per day by the scheduler.
 */
export async function distributeRoleTenurePoints(
  guild: import("discord.js").Guild,
): Promise<void> {
  const configs = await listRoleConfigs(guild.id);
  if (configs.length === 0) return;

  await getOrCreatePointSettings(guild.id);
  await db
    .update(pointSettingsTable)
    .set({ roleTenureLastAwardedAt: new Date() })
    .where(eq(pointSettingsTable.guildId, guild.id));

  let members;
  try {
    members = await guild.members.fetch();
  } catch {
    logger.warn(`[points] Could not fetch members for guild ${guild.id}`);
    return;
  }

  for (const config of configs) {
    const eligible = [...members.values()].filter(
      (m) => !m.user.bot && m.roles.cache.has(config.roleId),
    );
    for (const member of eligible) {
      await addPoints(guild.id, member.id, config.pointsPerDay, "role_tenure", `ロール保持 <@&${config.roleId}>`).catch(
        () => null,
      );
    }
  }
  logger.info(`[points] role tenure distributed for guild ${guild.id}`);
}

// ── Rank Configs ──────────────────────────────────────────────────────────────

export async function listRankConfigs(guildId: string): Promise<PointRankConfig[]> {
  return db
    .select()
    .from(pointRankConfigsTable)
    .where(eq(pointRankConfigsTable.guildId, guildId));
}

export async function upsertRankConfig(guildId: string, rank: number, points: number): Promise<void> {
  await db
    .insert(pointRankConfigsTable)
    .values({ guildId, rank, points })
    .onConflictDoUpdate({
      target: [pointRankConfigsTable.guildId, pointRankConfigsTable.rank],
      set: { points },
    });
}

export async function removeRankConfig(guildId: string, rank: number): Promise<boolean> {
  const result = await db
    .delete(pointRankConfigsTable)
    .where(and(eq(pointRankConfigsTable.guildId, guildId), eq(pointRankConfigsTable.rank, rank)));
  return (result.rowCount ?? 0) > 0;
}

/** Award points for an event rank result to a specific user. */
export async function awardEventRankPoints(
  guildId: string,
  userId: string,
  rank: number,
): Promise<number> {
  const [config] = await db
    .select()
    .from(pointRankConfigsTable)
    .where(and(eq(pointRankConfigsTable.guildId, guildId), eq(pointRankConfigsTable.rank, rank)));
  if (!config) return 0;
  await addPoints(guildId, userId, config.points, "event_result", `イベント ${rank}位`);
  return config.points;
}

/** Award boost points once when a member starts boosting. */
export async function awardBoostPoints(guildId: string, userId: string): Promise<number> {
  const settings = await getOrCreatePointSettings(guildId);
  if (settings.boostPoints <= 0) return 0;
  await addPoints(guildId, userId, settings.boostPoints, "boost", "サーバーブースト");
  return settings.boostPoints;
}
