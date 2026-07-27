import { and, asc, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import {
  db,
  communityEventSettingsTable,
  communityEventsTable,
  communityEventParticipantsTable,
  communityTicketSettingsTable,
  communityTicketsTable,
  communityTicketPanelsTable,
  communityVcSessionsTable,
  communityVcPrivacyTable,
  communityVcPrivacyGlobalTable,
  communityRankingSettingsTable,
  communityRoleButtonsTable,
  type CommunityRoleButton,
  type CommunityEvent,
  type CommunityEventSettings,
  type CommunityTicket,
  type CommunityVcSession,
  type CommunityTicketSettings,
  type CommunityTicketPanel,
  type CommunityRankingSettings,
} from "@workspace/db";

export type { CommunityTicketPanel };

export type { CommunityTicketSettings };

// ─── Event Settings ──────────────────────────────────────────────────────────

export async function getEventSettings(guildId: string): Promise<CommunityEventSettings | undefined> {
  const [row] = await db
    .select()
    .from(communityEventSettingsTable)
    .where(eq(communityEventSettingsTable.guildId, guildId));
  return row;
}

export async function setEventSettings(
  guildId: string,
  opts: { notifyChannelId?: string | null; notifyRoleId?: string | null },
): Promise<void> {
  await db
    .insert(communityEventSettingsTable)
    .values({ guildId, ...opts })
    .onConflictDoUpdate({
      target: communityEventSettingsTable.guildId,
      set: { ...opts, updatedAt: new Date() },
    });
}

// ─── Events ──────────────────────────────────────────────────────────────────

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

/**
 * Returns events across all guilds whose scheduledAt has passed but have not
 * yet had participation points awarded.
 */
export async function getEventsNeedingParticipationPoints(): Promise<CommunityEvent[]> {
  const now = new Date();
  return db
    .select()
    .from(communityEventsTable)
    .where(
      and(
        lt(communityEventsTable.scheduledAt, now),
        isNull(communityEventsTable.participationPointsAwardedAt),
      ),
    );
}

/** Mark an event as having had participation points awarded. */
export async function markParticipationPointsAwarded(eventId: number): Promise<void> {
  await db
    .update(communityEventsTable)
    .set({ participationPointsAwardedAt: new Date() })
    .where(eq(communityEventsTable.id, eventId));
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

export async function deleteEvent(eventId: number): Promise<void> {
  await db
    .delete(communityEventParticipantsTable)
    .where(eq(communityEventParticipantsTable.eventId, eventId));
  await db
    .delete(communityEventsTable)
    .where(eq(communityEventsTable.id, eventId));
}

export async function editEvent(
  eventId: number,
  opts: { title?: string; description?: string | null; scheduledAt?: Date },
): Promise<void> {
  await db
    .update(communityEventsTable)
    .set(opts)
    .where(eq(communityEventsTable.id, eventId));
}

export async function markReminderSent(eventId: number) {
  await db
    .update(communityEventsTable)
    .set({ reminderSentAt: new Date() })
    .where(eq(communityEventsTable.id, eventId));
}

export async function mark24hReminderSent(eventId: number) {
  await db
    .update(communityEventsTable)
    .set({ reminder24hSentAt: new Date() })
    .where(eq(communityEventsTable.id, eventId));
}

/** Return events starting in 23–25 h that haven't had their 24 h reminder sent. */
export async function getEventsNeeding24hReminder(): Promise<CommunityEvent[]> {
  const now = new Date();
  const in23h = new Date(now.getTime() + 23 * 60 * 60 * 1000);
  const in25h = new Date(now.getTime() + 25 * 60 * 60 * 1000);
  return db
    .select()
    .from(communityEventsTable)
    .where(
      and(
        gt(communityEventsTable.scheduledAt, in23h),
        lt(communityEventsTable.scheduledAt, in25h),
        isNull(communityEventsTable.reminder24hSentAt),
      ),
    );
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

export async function setTicketMessages(
  guildId: string,
  opts: {
    panelTitle?: string | null;
    panelDescription?: string | null;
    panelButtonLabel?: string | null;
    welcomeMessage?: string | null;
  },
) {
  await upsertTicketSettings(guildId, opts);
}

/** Generic upsert for any subset of ticket settings columns. */
export async function upsertTicketSettings(
  guildId: string,
  opts: Partial<Omit<CommunityTicketSettings, "guildId" | "updatedAt">>,
) {
  await db
    .insert(communityTicketSettingsTable)
    .values({ guildId, ...opts })
    .onConflictDoUpdate({
      target: communityTicketSettingsTable.guildId,
      set: { ...opts, updatedAt: new Date() },
    });
}

export async function setTicketRenameRole(guildId: string, renameRoleId: string | null) {
  await db
    .insert(communityTicketSettingsTable)
    .values({ guildId, renameRoleId })
    .onConflictDoUpdate({
      target: communityTicketSettingsTable.guildId,
      set: { renameRoleId, updatedAt: new Date() },
    });
}

// ─── Ticket Panels ───────────────────────────────────────────────────────────

type PanelOpts = Partial<Omit<CommunityTicketPanel, "id" | "guildId" | "createdAt">>;

export async function createTicketPanel(
  guildId: string,
  name: string,
  opts: Omit<PanelOpts, "name"> = {},
): Promise<CommunityTicketPanel> {
  const [row] = await db
    .insert(communityTicketPanelsTable)
    .values({ guildId, name, ...opts })
    .returning();
  if (!row) throw new Error("Failed to create ticket panel");
  return row;
}

export async function getTicketPanel(id: number): Promise<CommunityTicketPanel | undefined> {
  const [row] = await db
    .select()
    .from(communityTicketPanelsTable)
    .where(eq(communityTicketPanelsTable.id, id));
  return row;
}

export async function updateTicketPanel(
  id: number,
  guildId: string,
  opts: PanelOpts,
): Promise<boolean> {
  const result = await db
    .update(communityTicketPanelsTable)
    .set(opts)
    .where(and(eq(communityTicketPanelsTable.id, id), eq(communityTicketPanelsTable.guildId, guildId)))
    .returning({ id: communityTicketPanelsTable.id });
  return result.length > 0;
}

export async function listTicketPanels(guildId: string): Promise<CommunityTicketPanel[]> {
  return db
    .select()
    .from(communityTicketPanelsTable)
    .where(eq(communityTicketPanelsTable.guildId, guildId))
    .orderBy(communityTicketPanelsTable.id);
}

export async function deleteTicketPanel(id: number, guildId: string): Promise<boolean> {
  const result = await db
    .delete(communityTicketPanelsTable)
    .where(and(eq(communityTicketPanelsTable.id, id), eq(communityTicketPanelsTable.guildId, guildId)))
    .returning({ id: communityTicketPanelsTable.id });
  return result.length > 0;
}

// ─── Ticket Settings ─────────────────────────────────────────────────────────

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

/**
 * Set a user's global VC tracking opt-out status (applies to all guilds).
 * optedOut=true  → stop recording in every guild
 * optedOut=false → resume recording (per-guild settings still apply)
 */
export async function setVcGlobalPrivacyOptOut(userId: string, optedOut: boolean): Promise<void> {
  await db
    .insert(communityVcPrivacyGlobalTable)
    .values({ userId, optedOut, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: communityVcPrivacyGlobalTable.userId,
      set: { optedOut, updatedAt: new Date() },
    });
}

/** Returns true if the user has enabled global opt-out (across all guilds). */
export async function isVcTrackingGloballyOptedOut(userId: string): Promise<boolean> {
  const [row] = await db
    .select()
    .from(communityVcPrivacyGlobalTable)
    .where(eq(communityVcPrivacyGlobalTable.userId, userId));
  return row?.optedOut === true;
}

/**
 * Returns true if the user has opted out of VC tracking in this guild only
 * (does NOT consult the global opt-out table).
 * Use this when you need to display the per-guild setting independently.
 */
export async function isVcTrackingGuildLocalOptedOut(guildId: string, userId: string): Promise<boolean> {
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

/**
 * Returns true if the user has opted out of VC tracking.
 * Global opt-out (community_vc_privacy_global) takes priority over the per-guild table.
 */
export async function isVcTrackingOptedOut(guildId: string, userId: string): Promise<boolean> {
  // Check global opt-out first — if set, no guild-level check is needed.
  const [globalRow, guildRow] = await Promise.all([
    db
      .select()
      .from(communityVcPrivacyGlobalTable)
      .where(eq(communityVcPrivacyGlobalTable.userId, userId))
      .then((rows) => rows[0]),
    db
      .select()
      .from(communityVcPrivacyTable)
      .where(
        and(
          eq(communityVcPrivacyTable.guildId, guildId),
          eq(communityVcPrivacyTable.userId, userId),
        ),
      )
      .then((rows) => rows[0]),
  ]);
  if (globalRow?.optedOut === true) return true;
  return guildRow?.optedOut === true;
}

/**
 * Permanently deletes all VC session rows for a user across ALL guilds.
 * Returns the number of rows deleted.
 */
export async function deleteAllUserVcSessions(userId: string): Promise<number> {
  const result = await db
    .delete(communityVcSessionsTable)
    .where(eq(communityVcSessionsTable.userId, userId))
    .returning({ id: communityVcSessionsTable.id });
  return result.length;
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

/**
 * Closes the active VC session and returns the duration in seconds.
 * Returns null if the user had no active session.
 */
export async function closeSessionAndGetDuration(
  guildId: string,
  userId: string,
): Promise<number | null> {
  const session = await getActiveSession(guildId, userId);
  if (!session) return null;
  await closeSession(guildId, userId);
  return Math.floor((Date.now() - session.joinedAt.getTime()) / 1000);
}

export async function closeAllOpenSessions(): Promise<void> {
  await db
    .update(communityVcSessionsTable)
    .set({ leftAt: new Date() })
    .where(isNull(communityVcSessionsTable.leftAt));
}

/**
 * Closes all open VC sessions (left_at IS NULL) for a single user across all guilds.
 * Returns the number of sessions closed.
 */
export async function closeOpenSessionsForUser(userId: string): Promise<number> {
  const result = await db
    .update(communityVcSessionsTable)
    .set({ leftAt: new Date() })
    .where(
      and(
        eq(communityVcSessionsTable.userId, userId),
        isNull(communityVcSessionsTable.leftAt),
      ),
    )
    .returning({ id: communityVcSessionsTable.id });
  return result.length;
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
      AND user_id NOT IN (
        SELECT user_id FROM community_vc_privacy_global
        WHERE opted_out = true
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
        AND user_id NOT IN (
          SELECT user_id FROM community_vc_privacy_global
          WHERE opted_out = true
        )
      GROUP BY user_id
    ) ranked
    WHERE user_id = ${userId}
  `);

  if (!rows.rows[0] || rows.rows.length === 0) return null;
  return Number(rows.rows[0]!.rank);
}

// ─── Role Buttons ────────────────────────────────────────────────────────────

export async function createRoleButton(opts: {
  guildId: string;
  channelId: string;
  messageId: string;
  roleId: string;
  label: string;
  style: number;
}): Promise<CommunityRoleButton> {
  const [row] = await db.insert(communityRoleButtonsTable).values(opts).returning();
  if (!row) throw new Error("Failed to create role button");
  return row;
}

export async function getRoleButtonsByMessage(messageId: string): Promise<CommunityRoleButton[]> {
  return db
    .select()
    .from(communityRoleButtonsTable)
    .where(eq(communityRoleButtonsTable.messageId, messageId))
    .orderBy(asc(communityRoleButtonsTable.id));
}

export async function getRoleButtonById(id: number): Promise<CommunityRoleButton | undefined> {
  const [row] = await db
    .select()
    .from(communityRoleButtonsTable)
    .where(eq(communityRoleButtonsTable.id, id));
  return row;
}

export async function listRoleButtonPanels(guildId: string): Promise<CommunityRoleButton[]> {
  return db
    .select()
    .from(communityRoleButtonsTable)
    .where(eq(communityRoleButtonsTable.guildId, guildId))
    .orderBy(asc(communityRoleButtonsTable.messageId), asc(communityRoleButtonsTable.id));
}

export async function deleteRoleButtonsByMessage(messageId: string): Promise<void> {
  await db
    .delete(communityRoleButtonsTable)
    .where(eq(communityRoleButtonsTable.messageId, messageId));
}

// ─── Daily Ranking Settings ───────────────────────────────────────────────────

export async function setRankingSettings(
  guildId: string,
  channelId: string | null,
  period: string,
): Promise<void> {
  await db
    .insert(communityRankingSettingsTable)
    .values({ guildId, channelId, period })
    .onConflictDoUpdate({
      target: communityRankingSettingsTable.guildId,
      set: { channelId, period, updatedAt: new Date() },
    });
}

export async function getAllRankingSettings(): Promise<CommunityRankingSettings[]> {
  return db
    .select()
    .from(communityRankingSettingsTable)
    .where(sql`${communityRankingSettingsTable.channelId} IS NOT NULL`);
}

// ─── Leave Log Settings ───────────────────────────────────────────────────────

export async function getLeaveLogChannel(guildId: string): Promise<string | null> {
  const [row] = await db
    .select({ leaveLogChannelId: communityRankingSettingsTable.leaveLogChannelId })
    .from(communityRankingSettingsTable)
    .where(eq(communityRankingSettingsTable.guildId, guildId));
  return row?.leaveLogChannelId ?? null;
}

export async function setLeaveLogChannel(
  guildId: string,
  channelId: string | null,
): Promise<void> {
  await db
    .insert(communityRankingSettingsTable)
    .values({ guildId, channelId: null, period: "all", leaveLogChannelId: channelId })
    .onConflictDoUpdate({
      target: communityRankingSettingsTable.guildId,
      set: { leaveLogChannelId: channelId, updatedAt: new Date() },
    });
}
