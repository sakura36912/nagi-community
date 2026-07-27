import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  pointSettingsTable,
  pointRoleConfigsTable,
  pointRankConfigsTable,
  pointBalancesTable,
  pointTransactionsTable,
  type PointSettings,
  type PointRoleConfig,
  type PointRankConfig,
  type PointBalance,
} from "@workspace/db";

export type {
  PointSettings,
  PointRoleConfig,
  PointRankConfig,
  PointBalance,
};

// ─── Settings ─────────────────────────────────────────────────────────────────

export async function getPointSettings(guildId: string): Promise<PointSettings> {
  const [row] = await db
    .select()
    .from(pointSettingsTable)
    .where(eq(pointSettingsTable.guildId, guildId));
  if (row) return row;
  // Return defaults without persisting
  return {
    guildId,
    vcRatePerHour: 100,
    eventParticipationPoints: 100,
    boostPoints: 0,
    roleTenureLastAwardedAt: null,
    updatedAt: new Date(),
  };
}

export async function setPointSettings(
  guildId: string,
  opts: { vcRatePerHour?: number; eventParticipationPoints?: number; roleTenureLastAwardedAt?: Date | null },
): Promise<void> {
  await db
    .insert(pointSettingsTable)
    .values({ guildId, ...opts })
    .onConflictDoUpdate({
      target: pointSettingsTable.guildId,
      set: { ...opts, updatedAt: new Date() },
    });
}

// ─── Role Configs ─────────────────────────────────────────────────────────────

export async function getRoleConfigs(guildId: string): Promise<PointRoleConfig[]> {
  return db
    .select()
    .from(pointRoleConfigsTable)
    .where(eq(pointRoleConfigsTable.guildId, guildId));
}

export async function addRoleConfig(
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
    .where(
      and(
        eq(pointRoleConfigsTable.guildId, guildId),
        eq(pointRoleConfigsTable.roleId, roleId),
      ),
    )
    .returning({ id: pointRoleConfigsTable.id });
  return result.length > 0;
}

// ─── Rank Configs ─────────────────────────────────────────────────────────────

export async function getRankConfigs(guildId: string): Promise<PointRankConfig[]> {
  return db
    .select()
    .from(pointRankConfigsTable)
    .where(eq(pointRankConfigsTable.guildId, guildId))
    .orderBy(pointRankConfigsTable.rank);
}

export async function setRankConfig(
  guildId: string,
  rank: number,
  points: number,
): Promise<void> {
  await db
    .insert(pointRankConfigsTable)
    .values({ guildId, rank, points })
    .onConflictDoUpdate({
      target: [pointRankConfigsTable.guildId, pointRankConfigsTable.rank],
      set: { points },
    });
}

// ─── Balances ─────────────────────────────────────────────────────────────────

export async function getPointBalance(guildId: string, userId: string): Promise<number> {
  const [row] = await db
    .select({ balance: pointBalancesTable.balance })
    .from(pointBalancesTable)
    .where(
      and(
        eq(pointBalancesTable.guildId, guildId),
        eq(pointBalancesTable.userId, userId),
      ),
    );
  return row?.balance ?? 0;
}

export type RankingEntry = { userId: string; balance: number };

export async function getPointRanking(guildId: string, limit = 10): Promise<RankingEntry[]> {
  const rows = await db
    .select({ userId: pointBalancesTable.userId, balance: pointBalancesTable.balance })
    .from(pointBalancesTable)
    .where(eq(pointBalancesTable.guildId, guildId))
    .orderBy(desc(pointBalancesTable.balance))
    .limit(limit);
  return rows;
}

// ─── Add Points ───────────────────────────────────────────────────────────────

/**
 * Adds (or subtracts) points for a user, recording a transaction.
 * Returns the new balance.
 */
export async function addPoints(
  guildId: string,
  userId: string,
  amount: number,
  type: string,
  note?: string,
): Promise<number> {
  const [balance] = await db
    .insert(pointBalancesTable)
    .values({ guildId, userId, balance: amount })
    .onConflictDoUpdate({
      target: [pointBalancesTable.guildId, pointBalancesTable.userId],
      set: {
        balance: sql`${pointBalancesTable.balance} + ${amount}`,
        updatedAt: new Date(),
      },
    })
    .returning({ balance: pointBalancesTable.balance });

  await db.insert(pointTransactionsTable).values({
    guildId,
    userId,
    amount,
    type,
    note: note ?? null,
  });

  return balance?.balance ?? amount;
}

// ─── VC Time Award ────────────────────────────────────────────────────────────

/**
 * Awards VC-time points on session end. Returns points awarded (0 if disabled).
 */
export async function awardVcTime(
  guildId: string,
  userId: string,
  durationSeconds: number,
): Promise<number> {
  const settings = await getPointSettings(guildId);
  if (settings.vcRatePerHour <= 0) return 0;

  const points = Math.floor((durationSeconds / 3600) * settings.vcRatePerHour);
  if (points <= 0) return 0;

  const hours = (durationSeconds / 3600).toFixed(2);
  await addPoints(guildId, userId, points, "vc_time", `VC滞在 ${hours}h`);
  return points;
}

// ─── Event Participation Award ────────────────────────────────────────────────

/**
 * Awards event-participation points to a list of users.
 * Idempotent — skips users who already have a transaction for this event.
 */
export async function awardEventParticipation(
  guildId: string,
  userIds: string[],
  eventId: number,
  eventTitle: string,
): Promise<number> {
  const settings = await getPointSettings(guildId);
  const pts = settings.eventParticipationPoints;
  if (pts <= 0 || userIds.length === 0) return 0;

  const note = `event:${eventId}`;

  // Find users who already received points for this event
  const existing = await db
    .select({ userId: pointTransactionsTable.userId })
    .from(pointTransactionsTable)
    .where(
      and(
        eq(pointTransactionsTable.guildId, guildId),
        eq(pointTransactionsTable.type, "event_participation"),
        eq(pointTransactionsTable.note, note),
      ),
    );
  const alreadyAwarded = new Set(existing.map((r) => r.userId));

  let count = 0;
  for (const userId of userIds) {
    if (alreadyAwarded.has(userId)) continue;
    await addPoints(guildId, userId, pts, "event_participation", note);
    count++;
  }
  return count;
}

// ─── Event Result Award ───────────────────────────────────────────────────────

/**
 * Awards event-result points to a user for their rank in an event.
 * Returns points awarded (0 if no config for this rank).
 */
export async function awardEventResult(
  guildId: string,
  userId: string,
  eventId: number,
  rank: number,
): Promise<number> {
  const [config] = await db
    .select()
    .from(pointRankConfigsTable)
    .where(
      and(
        eq(pointRankConfigsTable.guildId, guildId),
        eq(pointRankConfigsTable.rank, rank),
      ),
    );
  if (!config || config.points <= 0) return 0;

  await addPoints(
    guildId,
    userId,
    config.points,
    "event_result",
    `event:${eventId} rank:${rank}`,
  );
  return config.points;
}

// ─── Role Tenure Batch ────────────────────────────────────────────────────────

/**
 * Awards daily role-tenure points for all members in tracked roles.
 * Should be called once per day. Skips if already run today (UTC).
 * Returns total points awarded.
 */
export async function runRoleTenureBatch(
  guildId: string,
  members: Array<{ userId: string; roleIds: string[] }>,
): Promise<number> {
  const settings = await getPointSettings(guildId);

  // Idempotency: skip if already run today (UTC date)
  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);
  if (
    settings.roleTenureLastAwardedAt &&
    settings.roleTenureLastAwardedAt >= todayUtc
  ) {
    return 0;
  }

  const roleConfigs = await getRoleConfigs(guildId);
  if (roleConfigs.length === 0) return 0;

  const roleConfigMap = new Map(roleConfigs.map((c) => [c.roleId, c.pointsPerDay]));
  let total = 0;

  for (const member of members) {
    // Accumulate points across all tracked roles this member has
    let memberPoints = 0;
    const roleNames: string[] = [];
    for (const roleId of member.roleIds) {
      const ppd = roleConfigMap.get(roleId);
      if (ppd && ppd > 0) {
        memberPoints += ppd;
        roleNames.push(roleId);
      }
    }
    if (memberPoints > 0) {
      await addPoints(
        guildId,
        member.userId,
        memberPoints,
        "role_tenure",
        `役職継続 roles:${roleNames.join(",")}`,
      );
      total += memberPoints;
    }
  }

  // Mark as run today
  await setPointSettings(guildId, { roleTenureLastAwardedAt: new Date() });
  return total;
}
