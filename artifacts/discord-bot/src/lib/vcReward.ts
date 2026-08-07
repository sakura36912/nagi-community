import { DiscordAPIError } from "discord.js";
import { and, eq, sql, type SQL } from "drizzle-orm";
import {
  db,
  vcPresenceTable,
  vcRewardSettingsTable,
  vcSessionLogSettingsTable,
  vcLogPresenceTable,
  vcSessionLogsTable,
  chestVcAccumTable,
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

/** Append a voice channel ID to the allowlist (no-op if already present). */
export async function addVcRewardChannel(
  guildId: string,
  channelId: string,
): Promise<VcRewardSettings> {
  await getVcRewardSettings(guildId);
  const [row] = await db
    .update(vcRewardSettingsTable)
    .set({
      includedChannelIds: sql`
        CASE WHEN ${channelId} = ANY(included_channel_ids)
          THEN included_channel_ids
          ELSE array_append(included_channel_ids, ${channelId})
        END
      `,
    })
    .where(eq(vcRewardSettingsTable.guildId, guildId))
    .returning();
  return row!;
}

/** Clear all channel IDs from the allowlist (reverts to "all channels eligible"). */
export async function clearVcRewardChannels(guildId: string): Promise<VcRewardSettings> {
  await getVcRewardSettings(guildId);
  const [row] = await db
    .update(vcRewardSettingsTable)
    .set({ includedChannelIds: [] })
    .where(eq(vcRewardSettingsTable.guildId, guildId))
    .returning();
  return row!;
}

/** Remove a voice channel ID from the allowlist. */
export async function removeVcRewardChannel(
  guildId: string,
  channelId: string,
): Promise<VcRewardSettings> {
  await getVcRewardSettings(guildId);
  const [row] = await db
    .update(vcRewardSettingsTable)
    .set({
      includedChannelIds: sql`array_remove(included_channel_ids, ${channelId})`,
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

/** Return a single user's current presence row (undefined if not in VC). */
export async function getVcPresence(
  guildId: string,
  userId: string,
): Promise<VcPresence | undefined> {
  const [row] = await db
    .select()
    .from(vcPresenceTable)
    .where(and(eq(vcPresenceTable.guildId, guildId), eq(vcPresenceTable.userId, userId)));
  return row;
}

// ─── Chest cumulative VC time ─────────────────────────────────────────────────

/** JST の "YYYY-MM-DD" を返す */
function jstDateString(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

/**
 * 当日の累積 VC 秒数に加算する（VC 離脱時に呼ぶ）。
 */
export async function addChestVcSeconds(
  guildId: string,
  userId: string,
  seconds: number,
): Promise<void> {
  if (seconds <= 0) return;
  const date = jstDateString();
  await db
    .insert(chestVcAccumTable)
    .values({ guildId, userId, date, accumulatedSeconds: seconds, chestOpened: false })
    .onConflictDoUpdate({
      target: [chestVcAccumTable.guildId, chestVcAccumTable.userId, chestVcAccumTable.date],
      set: { accumulatedSeconds: sql`chest_vc_accum.accumulated_seconds + ${seconds}` },
    });
}

/**
 * 当日の累積 VC 秒数を取得する（現在セッション分は含まない）。
 */
export async function getTodayChestVcSeconds(
  guildId: string,
  userId: string,
): Promise<number> {
  const date = jstDateString();
  const [row] = await db
    .select()
    .from(chestVcAccumTable)
    .where(
      and(
        eq(chestVcAccumTable.guildId, guildId),
        eq(chestVcAccumTable.userId, userId),
        eq(chestVcAccumTable.date, date),
      ),
    );
  return row?.accumulatedSeconds ?? 0;
}

/** 本日の宝箱開封回数を取得する。 */
export async function getTodayChestOpensCount(guildId: string, userId: string): Promise<number> {
  const date = jstDateString();
  const [row] = await db
    .select({ chestOpensCount: chestVcAccumTable.chestOpensCount })
    .from(chestVcAccumTable)
    .where(
      and(
        eq(chestVcAccumTable.guildId, guildId),
        eq(chestVcAccumTable.userId, userId),
        eq(chestVcAccumTable.date, date),
      ),
    );
  return row?.chestOpensCount ?? 0;
}

/** 本日の宝箱開封回数を1増やす。 */
export async function incrementChestOpensToday(guildId: string, userId: string): Promise<void> {
  const date = jstDateString();
  await db
    .insert(chestVcAccumTable)
    .values({ guildId, userId, date, accumulatedSeconds: 0, chestOpened: false, chestOpensCount: 1 })
    .onConflictDoUpdate({
      target: [chestVcAccumTable.guildId, chestVcAccumTable.userId, chestVcAccumTable.date],
      set: { chestOpensCount: sql`chest_vc_accum.chest_opens_count + 1` },
    });
}

/** Mark the treasure chest as opened for this VC session. */
export async function markChestOpened(guildId: string, userId: string): Promise<void> {
  await db
    .update(vcPresenceTable)
    .set({ chestOpenedAt: new Date() })
    .where(and(eq(vcPresenceTable.guildId, guildId), eq(vcPresenceTable.userId, userId)));
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
  settings: Pick<VcRewardSettings, "ratePerHour" | "minMinutes">,
  sendDm?: (message: string) => Promise<unknown>,
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

  // Notify member via DM. Silently ignore 50007 (Cannot send messages to this user / DMs closed).
  if (sendDm) {
    try {
      await sendDm(`VC滞在報酬として **${reward} ${currencyName}** を受け取りました！`);
    } catch (err) {
      if (err instanceof DiscordAPIError && err.code === 50007) {
        // Member has DMs closed — silently ignore.
      } else {
        throw err;
      }
    }
  }

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
