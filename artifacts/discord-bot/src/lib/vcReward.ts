import { DiscordAPIError } from "discord.js";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  db,
  vcPresenceTable,
  vcRewardSettingsTable,
  vcSessionLogSettingsTable,
  vcLogPresenceTable,
  vcSessionLogsTable,
  chestVcAccumTable,
  chestCooldownTable,
  communityTavernChannelsTable,
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
        CASE WHEN EXISTS (SELECT 1 FROM json_each(included_channel_ids) WHERE value = ${channelId})
          THEN included_channel_ids
          ELSE json_insert(included_channel_ids, '$[#]', ${channelId})
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
      includedChannelIds: sql`(SELECT json_group_array(value) FROM json_each(included_channel_ids) WHERE value <> ${channelId})`,
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

/**
 * 累積合計の VC 秒数を取得する（全日付の合計）。
 */
export async function getTotalChestVcSeconds(
  guildId: string,
  userId: string,
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${chestVcAccumTable.accumulatedSeconds}), 0)` })
    .from(chestVcAccumTable)
    .where(
      and(
        eq(chestVcAccumTable.guildId, guildId),
        eq(chestVcAccumTable.userId, userId),
      ),
    );
  return row?.total ?? 0;
}

/**
 * vc_session_logs の酒場チャンネルセッションから累積秒数を取得する。
 * chest_vc_accum とは独立した別経路で、二重カウント防止のため呼び出し側が max() を取ること。
 */
export async function getTavernSessionLogSeconds(
  guildId: string,
  userId: string,
): Promise<number> {
  // community_tavern_channels からギルドの酒場チャンネル ID 一覧を取得
  const tavernRows = await db
    .select({ channelId: communityTavernChannelsTable.channelId })
    .from(communityTavernChannelsTable)
    .where(eq(communityTavernChannelsTable.guildId, guildId));

  if (tavernRows.length === 0) return 0;
  const channelIds = tavernRows.map((r) => r.channelId);

  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${vcSessionLogsTable.durationSeconds}), 0)` })
    .from(vcSessionLogsTable)
    .where(
      and(
        eq(vcSessionLogsTable.guildId, guildId),
        eq(vcSessionLogsTable.userId, userId),
        inArray(vcSessionLogsTable.channelId, channelIds),
      ),
    );
  return row?.total ?? 0;
}

/** 累積合計の宝箱開封回数を取得する（全日付の合計）。 */
export async function getTotalChestOpensCount(guildId: string, userId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${chestVcAccumTable.chestOpensCount}), 0)` })
    .from(chestVcAccumTable)
    .where(
      and(
        eq(chestVcAccumTable.guildId, guildId),
        eq(chestVcAccumTable.userId, userId),
      ),
    );
  return row?.total ?? 0;
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

// ─── Chest per-open cooldown ─────────────────────────────────────────────────

/**
 * 前回開封時の累積酒場 VC 秒数を取得する。
 * 未開封の場合は 0 を返す。
 */
export async function getChestLastOpenVcSeconds(
  guildId: string,
  userId: string,
  chestType: string,
): Promise<number> {
  const [row] = await db
    .select({ s: chestCooldownTable.lastOpenVcSeconds })
    .from(chestCooldownTable)
    .where(
      and(
        eq(chestCooldownTable.guildId, guildId),
        eq(chestCooldownTable.userId, userId),
        eq(chestCooldownTable.chestType, chestType),
      ),
    );
  return row?.s ?? 0;
}

/**
 * 開封時に前回開封 VC 秒数を更新する。
 */
export async function setChestLastOpenVcSeconds(
  guildId: string,
  userId: string,
  chestType: string,
  vcSeconds: number,
): Promise<void> {
  await db
    .insert(chestCooldownTable)
    .values({ guildId, userId, chestType, lastOpenVcSeconds: vcSeconds })
    .onConflictDoUpdate({
      target: [chestCooldownTable.guildId, chestCooldownTable.userId, chestCooldownTable.chestType],
      set: { lastOpenVcSeconds: vcSeconds },
    });
}

// ─── Chest bonus opens ───────────────────────────────────────────────────────

/**
 * 管理者が付与したボーナス開封回数を取得する。
 */
export async function getChestBonusOpens(
  guildId: string,
  userId: string,
  chestType: string,
): Promise<number> {
  const [row] = await db
    .select({ b: chestCooldownTable.bonusOpens })
    .from(chestCooldownTable)
    .where(
      and(
        eq(chestCooldownTable.guildId, guildId),
        eq(chestCooldownTable.userId, userId),
        eq(chestCooldownTable.chestType, chestType),
      ),
    );
  return row?.b ?? 0;
}

/**
 * ボーナス開封を1消費する（bonus_opens > 0 の場合のみ）。
 * 消費できた場合 true を返す。
 */
export async function consumeChestBonusOpen(
  guildId: string,
  userId: string,
  chestType: string,
): Promise<boolean> {
  const result = await db
    .update(chestCooldownTable)
    .set({ bonusOpens: sql`MAX(0, ${chestCooldownTable.bonusOpens} - 1)` })
    .where(
      and(
        eq(chestCooldownTable.guildId, guildId),
        eq(chestCooldownTable.userId, userId),
        eq(chestCooldownTable.chestType, chestType),
        sql`${chestCooldownTable.bonusOpens} > 0`,
      ),
    )
    .returning({ userId: chestCooldownTable.userId });
  return result.length > 0;
}

/**
 * 管理者操作でボーナス開封回数を加算する（マイナス値で減算、最低 0）。
 * 行が存在しない場合は新規作成する。
 */
export async function addChestBonusOpens(
  guildId: string,
  userId: string,
  chestType: string,
  count: number,
): Promise<number> {
  const [row] = await db
    .insert(chestCooldownTable)
    .values({ guildId, userId, chestType, lastOpenVcSeconds: 0, bonusOpens: Math.max(0, count) })
    .onConflictDoUpdate({
      target: [chestCooldownTable.guildId, chestCooldownTable.userId, chestCooldownTable.chestType],
      set: {
        bonusOpens: sql`MAX(0, ${chestCooldownTable.bonusOpens} + ${count})`,
      },
    })
    .returning({ bonusOpens: chestCooldownTable.bonusOpens });
  return row?.bonusOpens ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────

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

  // Build a stable idempotency key for this session so that a duplicate leave
  // event cannot produce a second transaction row or a second wallet credit.
  const sessionKey = `vc:${guildId}:${userId}:${joinedAt.toISOString()}`;

  // Wrap the transaction insert and wallet upsert in a single DB transaction so
  // that a wallet-upsert failure rolls back the new ledger row.  Without this,
  // a crash or DB error between the two statements would leave the session_key
  // permanently consumed while the wallet was never credited — the user would
  // never be paid because every subsequent retry would see the existing key and
  // return 0 immediately.
  //
  // Inside the transaction:
  //   1. Insert the ledger row with the session key (idempotency gate).
  //      ON CONFLICT DO NOTHING → if the key already exists, the insert is
  //      silently skipped and returning() comes back empty.
  //   2. If no row was returned, this session has already been paid → return 0.
  //   3. Otherwise upsert the wallet balance.  A failure here rolls back step 1
  //      so the session key is freed for a later retry.
  const paid = await db.transaction(async (tx) => {
    const [txRow] = await tx
      .insert(transactionsTable)
      .values({ guildId, userId, amount: reward, reason, sessionKey })
      .onConflictDoNothing()
      .returning();

    if (!txRow) return false; // already paid for this session

    await tx
      .insert(walletsTable)
      .values({ guildId, userId, balance: reward })
      .onConflictDoUpdate({
        target: [walletsTable.guildId, walletsTable.userId],
        set: { balance: sql`${walletsTable.balance} + ${reward}` },
      });

    return true;
  });

  if (!paid) return 0;

  // Notify member via DM. Kept outside the DB transaction so a DM failure never
  // rolls back the credit. Silently ignore 50007 (DMs closed).
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

// ─── Hub salary payout ───────────────────────────────────────────────────────

/**
 * Calculate and pay the Hub-VC salary for a completed session, then notify
 * the member via DM.  Silently ignores Discord error 50007 (DMs closed).
 * Returns the coin amount credited (0 if below minMinutes or computed reward ≤ 0).
 */
export async function payHubSalary(
  guildId: string,
  userId: string,
  joinedAt: Date,
  currencyName: string,
  settings: { ratePerHour: number; minMinutes: number },
  sendDm?: (message: string) => Promise<unknown>,
): Promise<number> {
  const minutes = (Date.now() - joinedAt.getTime()) / 60_000;
  if (minutes < settings.minMinutes) return 0;

  const reward = Math.floor((minutes / 60) * settings.ratePerHour);
  if (reward <= 0) return 0;

  const reason = `Hub VC滞在報酬（${Math.floor(minutes)}分）`;

  // Upsert wallet and credit balance.
  await db
    .insert(walletsTable)
    .values({ guildId, userId, balance: reward })
    .onConflictDoUpdate({
      target: [walletsTable.guildId, walletsTable.userId],
      set: { balance: sql`${walletsTable.balance} + ${reward}` },
    });

  await db.insert(transactionsTable).values({ guildId, userId, amount: reward, reason });

  // Notify member via DM.  Silently ignore 50007 (Cannot send messages to this user / DMs closed).
  if (sendDm) {
    try {
      await sendDm(`Hub VC滞在報酬として **${reward} ${currencyName}** を受け取りました！`);
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
        CASE WHEN EXISTS (SELECT 1 FROM json_each(category_ids) WHERE value = ${categoryId})
          THEN category_ids
          ELSE json_insert(category_ids, '$[#]', ${categoryId})
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
    .set({ categoryIds: sql`(SELECT json_group_array(value) FROM json_each(category_ids) WHERE value <> ${categoryId})` })
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
