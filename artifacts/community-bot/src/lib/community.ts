import { and, asc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import {
  db,
  communityTempVcSettingsTable,
  communityTempVcsTable,
  communityEventsTable,
  communityEventParticipantsTable,
  communityTicketSettingsTable,
  communityTicketsTable,
  communityVcSessionsTable,
  communitySheetSettingsTable,
  communitySheetsTable,
  type CommunityEvent,
  type CommunityTicket,
  type CommunityVcSession,
  type CommunitySheet,
  type CommunitySheetSettings,
  type CommunityTicketSettings,
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

// ─── VC Sessions ─────────────────────────────────────────────────────────────

export async function openSession(guildId: string, userId: string, channelId: string): Promise<CommunityVcSession> {
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
