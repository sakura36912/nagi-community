import { and, eq, sql, type SQL } from "drizzle-orm";
import {
  db,
  vcPresenceTable,
  vcRewardSettingsTable,
  vcSessionLogSettingsTable,
  vcLogPresenceTable,
  vcSessionLogsTable,
  walletsTable,
  transactionsTable,
  type VcPresence,
  type VcRewardSettings,
  type VcSessionLogSettings,
} from "@workspace/db";

// ─── Settings ────────────────────────────────────────────────────────────────

export async function getVcRewardSettings(
  guildId: string,
): Promise<VcRewardSettings> {
  const [row] = await db
    .select()
    .from(vcRewardSettingsTable)
    .where(eq(vcRewardSettingsTable.guildId, guildId));
  if (row) return row;

  const [created] = await db
    .insert(vcRewardSettingsTable)
    .values({ guildId })
    .returning();
  return created!;
}

export async function setVcRewardSettings(
  guildId: string,
  ratePerHour: number,
  minMinutes: number,
): Promise<VcRewardSettings> {
  const [row] = await db
    .insert(vcRewardSettingsTable)
    .values({ guildId, ratePerHour, minMinutes })
    .onConflictDoUpdate({
      target: vcRewardSettingsTable.guildId,
      set: { ratePerHour, minMinutes },
    })
    .returning();
  return row!;
}

/** Append a category ID to the allowlist (no-op if already present). */
export async function addVcRewardCategory(
  guildId: string,
  categoryId: string,
): Promise<VcRewardSettings> {
  // Ensure a row exists first.
  await getVcRewardSettings(guildId);
  const [row] = await db
    .update(vcRewardSettingsTable)
    .set({
      includedCategoryIds: sql`
        CASE WHEN ${categoryId} = ANY(included_category_ids)
          THEN included_category_ids
          ELSE array_append(included_category_ids, ${categoryId})
        END
      `,
    })
    .where(eq(vcRewardSettingsTable.guildId, guildId))
    .returning();
  return row!;
}

/** Remove a category ID from the allowlist. */
export async function removeVcRewardCategory(
  guildId: string,
  categoryId: string,
): Promise<VcRewardSettings> {
  await getVcRewardSettings(guildId);
  const [row] = await db
    .update(vcRewardSettingsTable)
    .set({
      includedCategoryIds: sql`array_remove(included_category_ids, ${categoryId})`,
    })
    .where(eq(vcRewardSettingsTable.guildId, guildId))
    .returning();
  return row!;
}

// ─── Presence tracking ───────────────────────────────────────────────────────

/** Record (or refresh) a user's VC join. */
export async function recordVcJoin(
  guildId: string,
  userId: string,
  channelId: string,
): Promise<void> {
  await db
    .insert(vcPresenceTable)
    .values({ guildId, userId, channelId, joinedAt: new Date() })
    .onConflictDoUpdate({
      target: [vcPresenceTable.guildId, vcPresenceTable.userId],
      set: { channelId, joinedAt: new Date() },
    });
}

/** Remove a user's presence record and return it (undefined if none). */
export async function clearVcPresence(
  guildId: string,
  userId: string,
): Promise<VcPresence | undefined> {
  const [row] = await db
    .delete(vcPresenceTable)
    .where(
      and(
        eq(vcPresenceTable.guildId, guildId),
        eq(vcPresenceTable.userId, userId),
      ),
    )
    .returning();
  return row;
}

/** Return all active presence records (used to clean up stale rows on restart). */
export async function getAllVcPresences(): Promise<VcPresence[]> {
  return db.select().from(vcPresenceTable);
}

/** Update only the channelId of an existing presence (preserves joinedAt for cross-room moves). */
export async function updateVcPresenceChannel(
  guildId: string,
  userId: string,
  channelId: string,
): Promise<void> {
  await db
    .update(vcPresenceTable)
    .set({ channelId })
    .where(and(eq(vcPresenceTable.guildId, guildId), eq(vcPresenceTable.userId, userId)));
}

// ─── Reward payout ───────────────────────────────────────────────────────────

/**
 * Calculate and pay the VC-time reward for a completed session.
 * Returns the coin amount credited (0 if below minMinutes or rate is 0).
 */
export async function payVcReward(
  guildId: string,
  userId: string,
  joinedAt: Date,
  currencyName: string,
  settings: VcRewardSettings,
): Promise<number> {
  if (settings.ratePerHour <= 0) return 0;

  const minutes = (Date.now() - joinedAt.getTime()) / 60_000;
  if (minutes < settings.minMinutes) return 0;

  const reward = Math.floor((minutes / 60) * settings.ratePerHour);
  if (reward <= 0) return 0;

  const reason = `VC滞在報酬（${Math.floor(minutes)}分）`;

  // Upsert wallet and credit balance atomically.
  await db
    .insert(walletsTable)
    .values({ guildId, userId, balance: reward })
    .onConflictDoUpdate({
      target: [walletsTable.guildId, walletsTable.userId],
      set: { balance: sql`${walletsTable.balance} + ${reward}` },
    });

  await db
    .insert(transactionsTable)
    .values({ guildId, userId, amount: reward, reason });

  return reward;
}

// ─── VC Session Log Settings ──────────────────────────────────────────────────

export async function getVcLogSettings(guildId: string): Promise<VcSessionLogSettings> {
  const [row] = await db
    .select()
    .from(vcSessionLogSettingsTable)
    .where(eq(vcSessionLogSettingsTable.guildId, guildId));
  if (row) return row;
  const [created] = await db
    .insert(vcSessionLogSettingsTable)
    .values({ guildId })
    .returning();
  return created!;
}

export async function addVcLogCategory(
  guildId: string,
  categoryId: string,
): Promise<VcSessionLogSettings> {
  await getVcLogSettings(guildId);
  const [row] = await db
    .update(vcSessionLogSettingsTable)
    .set({
      categoryIds: sql`
        CASE WHEN ${categoryId} = ANY(category_ids)
          THEN category_ids
          ELSE array_append(category_ids, ${categoryId})
        END`,
    })
    .where(eq(vcSessionLogSettingsTable.guildId, guildId))
    .returning();
  return row!;
}

export async function removeVcLogCategory(
  guildId: string,
  categoryId: string,
): Promise<VcSessionLogSettings> {
  await getVcLogSettings(guildId);
  const [row] = await db
    .update(vcSessionLogSettingsTable)
    .set({ categoryIds: sql`array_remove(category_ids, ${categoryId})` })
    .where(eq(vcSessionLogSettingsTable.guildId, guildId))
    .returning();
  return row!;
}

export async function setVcLogNotifyChannel(
  guildId: string,
  channelId: string | null,
): Promise<VcSessionLogSettings> {
  await getVcLogSettings(guildId);
  const [row] = await db
    .update(vcSessionLogSettingsTable)
    .set({ notifyChannelId: channelId })
    .where(eq(vcSessionLogSettingsTable.guildId, guildId))
    .returning();
  return row!;
}

// ─── VC Log Presence ──────────────────────────────────────────────────────────

/** Read the current log-presence record without modifying it. Returns undefined if none. */
export async function getVcLogPresence(
  guildId: string,
  userId: string,
): Promise<{ joinedAt: Date } | undefined> {
  const [row] = await db
    .select({ joinedAt: vcLogPresenceTable.joinedAt })
    .from(vcLogPresenceTable)
    .where(and(eq(vcLogPresenceTable.guildId, guildId), eq(vcLogPresenceTable.userId, userId)));
  return row;
}

export async function recordVcLogJoin(
  guildId: string,
  userId: string,
  channelId: string,
  categoryId: string,
): Promise<void> {
  await db
    .insert(vcLogPresenceTable)
    .values({ guildId, userId, channelId, categoryId, joinedAt: new Date() })
    .onConflictDoUpdate({
      target: [vcLogPresenceTable.guildId, vcLogPresenceTable.userId],
      set: { channelId, categoryId, joinedAt: new Date() },
    });
}

export async function recordVcLogLeave(
  guildId: string,
  userId: string,
): Promise<{ durationSeconds: number } | undefined> {
  const [presence] = await db
    .delete(vcLogPresenceTable)
    .where(and(eq(vcLogPresenceTable.guildId, guildId), eq(vcLogPresenceTable.userId, userId)))
    .returning();
  if (!presence) return undefined;

  const leftAt = new Date();
  const durationSeconds = Math.floor((leftAt.getTime() - presence.joinedAt.getTime()) / 1000);
  if (durationSeconds <= 0) return undefined;

  await db.insert(vcSessionLogsTable).values({
    guildId,
    userId,
    channelId: presence.channelId,
    categoryId: presence.categoryId,
    joinedAt: presence.joinedAt,
    leftAt,
    durationSeconds,
  });

  return { durationSeconds };
}
