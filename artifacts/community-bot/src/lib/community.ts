import { and, asc, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import {
  db,
  communityTempVcSettingsTable,
  communityTempVcsTable,
  communityTempVcDeletionLogTable,
  communityEventsTable,
  communityEventParticipantsTable,
  communityTicketSettingsTable,
  communityTicketsTable,
  communityVcSessionsTable,
  communityVcPrivacyTable,
  communitySheetSettingsTable,
  communitySheetsTable,
  type CommunityEvent,
  type CommunityTicket,
  type CommunityVcSession,
  type CommunitySheet,
  type CommunitySheetSettings,
  type CommunityTicketSettings,
  type CommunityTempVcDeletionLog,
  type TempVcDeletionReason,
} from "@workspace/db";

// ─── Temp VC ────────────────────────────────────────────────────────────────

export async function setLobbyChannel(guildId: string, lobbyChannelId: string) {
  await db
    .insert(communityTempVcSettingsTable)
    .values({ guildId, lobbyChannelId })
    .onConflictDoUpdate({
      target: communityTempVcSettingsTable.guildId,
      set: { lobbyChannelId, updatedAt: new Date() },
    });
}

export async function getLobbyChannelId(guildId: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(communityTempVcSettingsTable)
    .where(eq(communityTempVcSettingsTable.guildId, guildId));
  return row?.lobbyChannelId ?? null;
}

export async function addTempVc(guildId: string, channelId: string, ownerId: string) {
  await db.insert(communityTempVcsTable).values({ guildId, channelId, ownerId }).onConflictDoNothing();
}

export async function removeTempVc(channelId: string) {
  await db.delete(communityTempVcsTable).where(eq(communityTempVcsTable.channelId, channelId));
}

export async function isTempVc(channelId: string): Promise<boolean> {
  const [row] = await db
    .select()
    .from(communityTempVcsTable)
    .where(eq(communityTempVcsTable.channelId, channelId));
  return row !== undefined;
}

export async function getTempVcRecord(
  channelId: string,
): Promise<{ guildId: string; channelId: string; ownerId: string } | undefined> {
  const [row] = await db
    .select()
    .from(communityTempVcsTable)
    .where(eq(communityTempVcsTable.channelId, channelId));
  return row;
}

export async function getAllTempVcs(): Promise<{ guildId: string; channelId: string; ownerId: string }[]> {
  return db.select().from(communityTempVcsTable);
}

export async function logTempVcDeletion(
  guildId: string,
  channelId: string,
  channelName: string,
  ownerId: string,
  reason: TempVcDeletionReason,
): Promise<void> {
  await db.insert(communityTempVcDeletionLogTable).values({
    guildId,
    channelId,
    channelName,
    ownerId,
    reason,
  });
}

export async function getRecentTempVcDeletions(
  guildId: string,
  limit = 20,
): Promise<CommunityTempVcDeletionLog[]> {
  return db
    .select()
    .from(communityTempVcDeletionLogTable)
    .where(eq(communityTempVcDeletionLogTable.guildId, guildId))
    .orderBy(desc(communityTempVcDeletionLogTable.deletedAt))
    .limit(limit);
}

/** Returns every deletion log entry for the guild (no limit), oldest first. */
export async function getAllTempVcDeletions(
  guildId: string,
): Promise<CommunityTempVcDeletionLog[]> {
  return db
    .select()
    .from(communityTempVcDeletionLogTable)
    .where(eq(communityTempVcDeletionLogTable.guildId, guildId))
    .orderBy(asc(communityTempVcDeletionLogTable.deletedAt));
}

/**
 * Deletes deletion-log entries older than `retentionDays` (default 90).
 * Returns the number of rows deleted.
 */
export async function pruneOldTempVcDeletionLogs(retentionDays = 90): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const result = await db
    .delete(communityTempVcDeletionLogTable)
    .where(lt(communityTempVcDeletionLogTable.deletedAt, cutoff))
    .returning({ id: communityTempVcDeletionLogTable.id });
  return result.length;
}

// ─── Events ─────────────────────────────────────────────────────────────────

export async function createEvent(
  guildId: string,
  channelId: string,
  title: string,
  description: string | null,
  scheduledAt: Date,
): Promise<CommunityEvent> {
  const [row] = await db
    .insert(communityEventsTable)
    .values({ guildId, channelId, title, description, scheduledAt })
    .returning();
  if (!row) throw new Error("Failed to create event");
  return row;
}

export async function updateEventMessageId(eventId: number, messageId: string) {
  await db
    .update(communityEventsTable)
    .set({ messageId })
    .where(eq(communityEventsTable.id, eventId));
}

export async function getEvent(eventId: number): Promise<CommunityEvent | undefined> {
  const [row] = await db
    .select()
    .from(communityEventsTable)
    .where(eq(communityEventsTable.id, eventId));
  return row;
}

export async function listUpcomingEvents(guildId: string): Promise<CommunityEvent[]> {
  const now = new Date();
  return db
    .select()
    .from(communityEventsTable)
    .where(
      and(
        eq(communityEventsTable.guildId, guildId),
        gt(communityEventsTable.scheduledAt, now),
      ),
    )
    .orderBy(asc(communityEventsTable.scheduledAt));
}

export async function addParticipant(eventId: number, userId: string): Promise<boolean> {
  const result = await db
    .insert(communityEventParticipantsTable)
    .values({ eventId, userId })
    .onConflictDoNothing()
    .returning();
  return result.length > 0;
}

export async function removeParticipant(eventId: number, userId: string): Promise<boolean> {
  const result = await db
    .delete(communityEventParticipantsTable)
    .where(
      and(
        eq(communityEventParticipantsTable.eventId, eventId),
        eq(communityEventParticipantsTable.userId, userId),
      ),
    )
    .returning();
  return result.length > 0;
}

export async function getParticipants(eventId: number): Promise<string[]> {
  const rows = await db
    .select()
    .from(communityEventParticipantsTable)
    .where(eq(communityEventParticipantsTable.eventId, eventId));
  return rows.map((r) => r.userId);
}

/** Return events that start within the next 30 min and haven't had a reminder sent. */
export async function getEventsNeedingReminder(): Promise<CommunityEvent[]> {
  const now = new Date();
  const soon = new Date(now.getTime() + 30 * 60 * 1000);
  return db
    .select()
    .from(communityEventsTable)
    .where(
      and(
        gt(communityEventsTable.scheduledAt, now),
        lt(communityEventsTable.scheduledAt, soon),
        isNull(communityEventsTable.reminderSentAt),
      ),
    );
}

export async function markReminderSent(eventId: number) {
  await db
    .update(communityEventsTable)
    .set({ reminderSentAt: new Date() })
    .where(eq(communityEventsTable.id, eventId));
}

// ─── Tickets ─────────────────────────────────────────────────────────────────

export async function setStaffRole(guildId: string, staffRoleId: string | null) {
  await db
    .insert(communityTicketSettingsTable)
    .values({ guildId, staffRoleId })
    .onConflictDoUpdate({
      target: communityTicketSettingsTable.guildId,
      set: { staffRoleId, updatedAt: new Date() },
    });
}

export async function getTicketSettings(guildId: string): Promise<CommunityTicketSettings | undefined> {
  const [row] = await db
    .select()
    .from(communityTicketSettingsTable)
    .where(eq(communityTicketSettingsTable.guildId, guildId));
  return row;
}

export async function createTicket(guildId: string, channelId: string, userId: string): Promise<CommunityTicket> {
  const [row] = await db
    .insert(communityTicketsTable)
    .values({ guildId, channelId, userId })
    .returning();
  if (!row) throw new Error("Failed to create ticket");
  return row;
}

export async function getTicketByChannel(channelId: string): Promise<CommunityTicket | undefined> {
  const [row] = await db
    .select()
    .from(communityTicketsTable)
    .where(eq(communityTicketsTable.channelId, channelId));
  return row;
}

export async function removeTicket(channelId: string) {
  await db.delete(communityTicketsTable).where(eq(communityTicketsTable.channelId, channelId));
}

// ─── VC Privacy ──────────────────────────────────────────────────────────────

/**
 * Set a user's VC tracking opt-out status for a guild.
 * optedOut=true  → stop recording new sessions
 * optedOut=false → resume recording
 */
export async function setVcPrivacyOptOut(guildId: string, userId: string, optedOut: boolean): Promise<void> {
  await db
    .insert(communityVcPrivacyTable)
    .values({ guildId, userId, optedOut, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [communityVcPrivacyTable.guildId, communityVcPrivacyTable.userId],
      set: { optedOut, updatedAt: new Date() },
    });
}

/** Returns true if the user has opted out of VC tracking in this guild. */
export async function isVcTrackingOptedOut(guildId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select()
    .from(communityVcPrivacyTable)
    .where(
      and(
        eq(communityVcPrivacyTable.guildId, guildId),
        eq(communityVcPrivacyTable.userId, userId),
      ),
    );
  return row?.optedOut === true;
}

// ─── VC Sessions ─────────────────────────────────────────────────────────────

/**
 * Opens a new VC session for the user if they have not opted out of tracking.
 * Returns the created session, or null if the user has opted out.
 */
export async function openSession(guildId: string, userId: string, channelId: string): Promise<CommunityVcSession | null> {
  const optedOut = await isVcTrackingOptedOut(guildId, userId);
  if (optedOut) return null;

  const [row] = await db
    .insert(communityVcSessionsTable)
    .values({ guildId, userId, channelId, joinedAt: new Date() })
    .returning();
  if (!row) throw new Error("Failed to open VC session");
  return row;
}

export async function closeSession(guildId: string, userId: string): Promise<void> {
  await db
    .update(communityVcSessionsTable)
    .set({ leftAt: new Date() })
    .where(
      and(
        eq(communityVcSessionsTable.guildId, guildId),
        eq(communityVcSessionsTable.userId, userId),
        isNull(communityVcSessionsTable.leftAt),
      ),
    );
}

export async function closeAllOpenSessions(): Promise<void> {
  await db
    .update(communityVcSessionsTable)
    .set({ leftAt: new Date() })
    .where(isNull(communityVcSessionsTable.leftAt));
}

export async function getActiveSession(
  guildId: string,
  userId: string,
): Promise<CommunityVcSession | undefined> {
  const [row] = await db
    .select()
    .from(communityVcSessionsTable)
    .where(
      and(
        eq(communityVcSessionsTable.guildId, guildId),
        eq(communityVcSessionsTable.userId, userId),
        isNull(communityVcSessionsTable.leftAt),
      ),
    );
  return row;
}

/**
 * Permanently deletes all VC session rows for a user in a guild.
 * Returns the number of rows deleted.
 */
export async function deleteUserVcSessions(guildId: string, userId: string): Promise<number> {
  const result = await db
    .delete(communityVcSessionsTable)
    .where(
      and(
        eq(communityVcSessionsTable.guildId, guildId),
        eq(communityVcSessionsTable.userId, userId),
      ),
    )
    .returning({ id: communityVcSessionsTable.id });
  return result.length;
}

/** Count of unique users currently in a tracked VC session for this guild. */
export async function getActiveSessionCount(guildId: string): Promise<number> {
  const rows = await db.execute<{ cnt: string }>(sql`
    SELECT COUNT(DISTINCT user_id)::bigint AS cnt
    FROM community_vc_sessions
    WHERE guild_id = ${guildId}
      AND left_at IS NULL
  `);
  return Number(rows.rows[0]?.cnt ?? 0);
}

export interface RankingEntry {
  userId: string;
  totalSeconds: number;
}

/**
 * Returns top-10 users by cumulative VC time.
 * periodStart = undefined means all time.
 */
export async function getVcRanking(guildId: string, periodStart?: Date): Promise<RankingEntry[]> {
  const periodFilter = periodStart
    ? sql`AND COALESCE(${communityVcSessionsTable.leftAt}, NOW()) > ${periodStart}`
    : sql``;

  const startClamp = periodStart
    ? sql`GREATEST(${communityVcSessionsTable.joinedAt}, ${periodStart})`
    : sql`${communityVcSessionsTable.joinedAt}`;

  const rows = await db.execute<{ user_id: string; total_seconds: string }>(sql`
    SELECT user_id,
      SUM(GREATEST(0, EXTRACT(EPOCH FROM (
        COALESCE(left_at, NOW()) - ${startClamp}
      ))))::bigint AS total_seconds
    FROM community_vc_sessions
    WHERE guild_id = ${guildId}
      ${periodFilter}
      AND user_id NOT IN (
        SELECT user_id FROM community_vc_privacy
        WHERE guild_id = ${guildId} AND opted_out = true
      )
    GROUP BY user_id
    ORDER BY total_seconds DESC
    LIMIT 10
  `);

  return rows.rows.map((r) => ({
    userId: r.user_id,
    totalSeconds: Number(r.total_seconds),
  }));
}

/** Total VC seconds for a user between two dates (for eval sheets). */
export async function getVcTimeInPeriod(
  guildId: string,
  userId: string,
  startDate: Date,
  endDate: Date,
): Promise<number> {
  const rows = await db.execute<{ total_seconds: string }>(sql`
    SELECT SUM(GREATEST(0, EXTRACT(EPOCH FROM (
      LEAST(COALESCE(left_at, NOW()), ${endDate})
      - GREATEST(joined_at, ${startDate})
    ))))::bigint AS total_seconds
    FROM community_vc_sessions
    WHERE guild_id = ${guildId}
      AND user_id = ${userId}
      AND joined_at < ${endDate}
      AND COALESCE(left_at, NOW()) > ${startDate}
  `);
  return Number(rows.rows[0]?.total_seconds ?? 0);
}

/**
 * Returns the 1-based rank of a user for a given period, or null if they have no sessions.
 * periodStart = undefined means all time.
 */
export async function getUserVcRank(
  guildId: string,
  userId: string,
  periodStart?: Date,
): Promise<number | null> {
  const periodFilter = periodStart
    ? sql`AND COALESCE(${communityVcSessionsTable.leftAt}, NOW()) > ${periodStart}`
    : sql``;

  const startClamp = periodStart
    ? sql`GREATEST(${communityVcSessionsTable.joinedAt}, ${periodStart})`
    : sql`${communityVcSessionsTable.joinedAt}`;

  const rows = await db.execute<{ rank: string }>(sql`
    SELECT rank FROM (
      SELECT user_id,
        RANK() OVER (ORDER BY SUM(GREATEST(0, EXTRACT(EPOCH FROM (
          COALESCE(left_at, NOW()) - ${startClamp}
        )))) DESC) AS rank
      FROM community_vc_sessions
      WHERE guild_id = ${guildId}
        ${periodFilter}
        AND user_id NOT IN (
          SELECT user_id FROM community_vc_privacy
          WHERE guild_id = ${guildId} AND opted_out = true
        )
      GROUP BY user_id
    ) ranked
    WHERE user_id = ${userId}
  `);

  if (rows.rows.length === 0) return null;
  return Number(rows.rows[0]!.rank);
}

// ─── Eval Sheets ─────────────────────────────────────────────────────────────

export async function setNameboardUrl(guildId: string, nameboardUrl: string | null): Promise<void> {
  await db
    .insert(communitySheetSettingsTable)
    .values({ guildId, nameboardUrl })
    .onConflictDoUpdate({
      target: communitySheetSettingsTable.guildId,
      set: { nameboardUrl, updatedAt: new Date() },
    });
}

export async function setSheetForumConfig(
  guildId: string,
  forumChannelId: string | null,
  triggerRoleIds: string[] | null,
  evalPeriodDays: number,
): Promise<void> {
  await db
    .insert(communitySheetSettingsTable)
    .values({
      guildId,
      forumChannelId,
      triggerRoleIds: triggerRoleIds ? triggerRoleIds.join(",") : null,
      evalPeriodDays,
    })
    .onConflictDoUpdate({
      target: communitySheetSettingsTable.guildId,
      set: { forumChannelId, triggerRoleIds: triggerRoleIds ? triggerRoleIds.join(",") : null, evalPeriodDays, updatedAt: new Date() },
    });
}

export async function getSheetSettings(guildId: string): Promise<CommunitySheetSettings | undefined> {
  const [row] = await db
    .select()
    .from(communitySheetSettingsTable)
    .where(eq(communitySheetSettingsTable.guildId, guildId));
  return row;
}

export async function createSheet(
  guildId: string,
  userId: string,
  startDate: Date,
  endDate: Date,
  channelId?: string,
  messageId?: string,
): Promise<CommunitySheet> {
  const [row] = await db
    .insert(communitySheetsTable)
    .values({ guildId, userId, startDate, endDate, channelId, messageId })
    .returning();
  if (!row) throw new Error("Failed to create sheet");
  return row;
}

export async function listSheets(guildId: string): Promise<CommunitySheet[]> {
  return db
    .select()
    .from(communitySheetsTable)
    .where(eq(communitySheetsTable.guildId, guildId))
    .orderBy(asc(communitySheetsTable.createdAt));
}
