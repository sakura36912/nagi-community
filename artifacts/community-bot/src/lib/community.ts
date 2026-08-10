import { and, asc, desc, eq, gt, gte, isNotNull, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";
import { logger } from "./logger.js";
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

export async function listTickets(guildId: string) {
  return db
    .select()
    .from(communityTicketsTable)
    .where(eq(communityTicketsTable.guildId, guildId));
}

// ─── VC Privacy ──────────────────────────────────────────────────────────────

/**
 * Set a user's VC tracking opt-out status for a guild.
 * optedOut=true  → stop recording new sessions and close any open session
 * optedOut=false → resume recording
 *
 * Returns true if an active session was closed (only possible when optedOut=true).
 */
export async function setVcPrivacyOptOut(guildId: string, userId: string, optedOut: boolean): Promise<boolean> {
  await db
    .insert(communityVcPrivacyTable)
    .values({ guildId, userId, optedOut, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [communityVcPrivacyTable.guildId, communityVcPrivacyTable.userId],
      set: { optedOut, updatedAt: new Date() },
    });
  if (optedOut) {
    // Mark the session is_privacy_closed=true so it is permanently excluded from
    // getVcRanking even after the user re-opts-in (see closeSession JSDoc).
    return closeSession(guildId, userId, true);
  }
  return false;
}

/**
 * Atomically opt a user back in to VC tracking by clearing both the global and
 * per-guild opt-out rows inside a single DB transaction.  If either upsert
 * fails the transaction rolls back, leaving neither row partially updated.
 */
export async function setVcPrivacyOptin(guildId: string, userId: string): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .insert(communityVcPrivacyGlobalTable)
      .values({ userId, optedOut: false, updatedAt: now })
      .onConflictDoUpdate({
        target: communityVcPrivacyGlobalTable.userId,
        set: { optedOut: false, updatedAt: now },
      });
    await tx
      .insert(communityVcPrivacyTable)
      .values({ guildId, userId, optedOut: false, updatedAt: now })
      .onConflictDoUpdate({
        target: [communityVcPrivacyTable.guildId, communityVcPrivacyTable.userId],
        set: { optedOut: false, updatedAt: now },
      });
  });
}

/**
 * Set a user's global VC tracking opt-out status (applies to all guilds).
 * optedOut=true  → stop recording in every guild and close all open sessions
 * optedOut=false → resume recording (per-guild settings still apply)
 *
 * Returns the number of sessions closed (only non-zero when optedOut=true).
 */
export async function setVcGlobalPrivacyOptOut(userId: string, optedOut: boolean): Promise<number> {
  await db
    .insert(communityVcPrivacyGlobalTable)
    .values({ userId, optedOut, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: communityVcPrivacyGlobalTable.userId,
      set: { optedOut, updatedAt: new Date() },
    });
  if (optedOut) {
    return closeOpenSessionsForUser(userId);
  }
  return 0;
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
 * Permanently deletes all VC session rows for a user across ALL guilds and
 * clears both their global opt-out record and all per-guild opt-out rows so
 * future sessions can be recorded in every guild without requiring an explicit
 * re-opt-in.
 * Returns the number of session rows deleted.
 */
export async function deleteAllUserVcSessions(userId: string): Promise<number> {
  const result = await db
    .delete(communityVcSessionsTable)
    .where(eq(communityVcSessionsTable.userId, userId))
    .returning({ id: communityVcSessionsTable.id });

  // Clear the global privacy opt-out row so the user starts with a clean slate
  // and new sessions are recorded automatically after the full data wipe.
  await db
    .delete(communityVcPrivacyGlobalTable)
    .where(eq(communityVcPrivacyGlobalTable.userId, userId))
    .returning({ userId: communityVcPrivacyGlobalTable.userId });

  // Also clear all per-guild opt-out rows so isVcTrackingOptedOut returns false
  // for every guild after the wipe.  Without this, guilds where the user had a
  // per-guild opt-out would still block re-tracking even though the global row
  // was removed.
  await db
    .delete(communityVcPrivacyTable)
    .where(eq(communityVcPrivacyTable.userId, userId))
    .returning({ userId: communityVcPrivacyTable.userId });

  return result.length;
}

// ─── VC Sessions ─────────────────────────────────────────────────────────────

/**
 * Opens a new VC session for the user if they have not opted out of tracking.
 * Returns the created session, or null if the user has opted out.
 */
export async function openSession(
  guildId: string,
  userId: string,
  channelId: string,
  isExile = false,
): Promise<CommunityVcSession | null> {
  const optedOut = await isVcTrackingOptedOut(guildId, userId);
  if (optedOut) return null;

  const [row] = await db
    .insert(communityVcSessionsTable)
    .values({ guildId, userId, channelId, joinedAt: new Date(), isExile })
    .returning();
  if (!row) throw new Error("Failed to open VC session");
  return row;
}

/**
 * Stamps left_at on the user's currently-open session for the given guild.
 *
 * @param privacyClosed  Pass true when closing due to a privacy opt-out event
 *   (setVcPrivacyOptOut / setVcGlobalPrivacyOptOut).  Sets is_privacy_closed=true
 *   on the row so getVcRanking can permanently exclude it — preventing pre-opt-out
 *   time from leaking back into the ranking after a user re-opts-in.
 */
export async function closeSession(guildId: string, userId: string, privacyClosed = false): Promise<boolean> {
  const result = await db
    .update(communityVcSessionsTable)
    .set({ leftAt: new Date(), isPrivacyClosed: privacyClosed })
    .where(
      and(
        eq(communityVcSessionsTable.guildId, guildId),
        eq(communityVcSessionsTable.userId, userId),
        isNull(communityVcSessionsTable.leftAt),
      ),
    )
    .returning({ id: communityVcSessionsTable.id });
  return result.length > 0;
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
 * Deletes completed VC sessions whose left_at is older than retentionDays.
 * Active sessions (left_at IS NULL) are never deleted.
 * Returns the number of rows deleted.
 */
export async function pruneOldVcSessions(retentionDays = 180): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const result = await db
    .delete(communityVcSessionsTable)
    .where(
      and(
        isNotNull(communityVcSessionsTable.leftAt),
        lt(communityVcSessionsTable.leftAt, cutoff),
      ),
    )
    .returning({ id: communityVcSessionsTable.id });
  return result.length;
}

/**
 * Closes all open VC sessions (left_at IS NULL) for a single user across all guilds.
 * Always marks the closed rows as is_privacy_closed=true because this function is
 * called exclusively from the global opt-out path (setVcGlobalPrivacyOptOut).
 * Returns the number of sessions closed.
 */
export async function closeOpenSessionsForUser(userId: string): Promise<number> {
  const result = await db
    .update(communityVcSessionsTable)
    .set({ leftAt: new Date(), isPrivacyClosed: true })
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
 * Permanently deletes all VC session rows for a user in a guild and clears
 * their per-guild privacy opt-out record so future sessions can be recorded
 * without requiring an explicit re-opt-in.
 * Returns the number of session rows deleted.
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

  // Clear the per-guild privacy opt-out row so the user starts clean and new
  // sessions are recorded automatically after the wipe.
  await db
    .delete(communityVcPrivacyTable)
    .where(
      and(
        eq(communityVcPrivacyTable.guildId, guildId),
        eq(communityVcPrivacyTable.userId, userId),
      ),
    )
    .returning({ userId: communityVcPrivacyTable.userId });

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
  isLive: boolean;
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

  const rows = await db.execute<{ user_id: string; total_seconds: string; is_live: boolean }>(sql`
    SELECT user_id,
      SUM(GREATEST(0, EXTRACT(EPOCH FROM (
        COALESCE(left_at, NOW()) - ${startClamp}
      ))))::bigint AS total_seconds,
      bool_or(left_at IS NULL) AS is_live
    FROM community_vc_sessions
    WHERE guild_id = ${guildId}
      ${periodFilter}
      AND is_privacy_closed = false
      AND channel_id IN (
        SELECT channel_id FROM community_tavern_channels WHERE guild_id = ${guildId}
      )
      AND is_exile = false
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
    isLive: r.is_live === true,
  }));
}

/** Total VC seconds for a user between two dates (for eval sheets).
 * Pass `isExile` to restrict to exile or non-exile sessions only.
 */
export async function getVcTimeInPeriod(
  guildId: string,
  userId: string,
  startDate: Date,
  endDate: Date,
  isExile?: boolean,
): Promise<number> {
  const exileFilter = isExile !== undefined
    ? sql`AND is_exile = ${isExile}`
    : sql``;
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
      ${exileFilter}
      AND channel_id IN (
        SELECT channel_id FROM community_tavern_channels WHERE guild_id = ${guildId}
      )
      AND user_id NOT IN (
        SELECT user_id FROM community_vc_privacy
        WHERE guild_id = ${guildId} AND opted_out = true
      )
      AND user_id NOT IN (
        SELECT user_id FROM community_vc_privacy_global
        WHERE opted_out = true
      )
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
        AND is_privacy_closed = false
        AND channel_id IN (
          SELECT channel_id FROM community_tavern_channels WHERE guild_id = ${guildId}
        )
        AND is_exile = false
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

/**
 * Returns the configured VC session retention window for a guild in days.
 * Falls back to 180 when no custom value has been set.
 */
export async function getVcSessionRetentionDays(guildId: string): Promise<number> {
  const [row] = await db
    .select({ vcSessionRetentionDays: communityRankingSettingsTable.vcSessionRetentionDays })
    .from(communityRankingSettingsTable)
    .where(eq(communityRankingSettingsTable.guildId, guildId));
  return row?.vcSessionRetentionDays ?? 180;
}

/**
 * Stores a custom VC session retention window (in days) for a guild.
 * Pass null to revert to the system default (180 days).
 */
export async function setVcSessionRetentionDays(
  guildId: string,
  days: number | null,
): Promise<void> {
  await db
    .insert(communityRankingSettingsTable)
    .values({ guildId, channelId: null, period: "all", vcSessionRetentionDays: days })
    .onConflictDoUpdate({
      target: communityRankingSettingsTable.guildId,
      set: { vcSessionRetentionDays: days, updatedAt: new Date() },
    });
}

/**
 * Deletes completed VC sessions for a single guild whose left_at is older
 * than retentionDays.  Active sessions (left_at IS NULL) are never deleted.
 * Returns the number of rows deleted.
 */
export async function pruneGuildVcSessions(
  guildId: string,
  retentionDays: number,
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const result = await db
    .delete(communityVcSessionsTable)
    .where(
      and(
        eq(communityVcSessionsTable.guildId, guildId),
        isNotNull(communityVcSessionsTable.leftAt),
        lt(communityVcSessionsTable.leftAt, cutoff),
      ),
    )
    .returning({ id: communityVcSessionsTable.id });
  return result.length;
}

/**
 * Deletes completed VC sessions that belong to guilds NOT in activeGuildIds,
 * applying a fixed 180-day retention window.  This is a catch-all to clean up
 * rows from guilds the bot has since left; it never touches sessions that
 * belong to an active guild (those are handled by pruneGuildVcSessions).
 *
 * If activeGuildIds is empty the function is a no-op — a bot with no guilds
 * should not mass-delete all historical data.
 *
 * Returns the number of rows deleted.
 */
export async function pruneOrphanedVcSessions(
  activeGuildIds: string[],
  retentionDays = 180,
): Promise<number> {
  if (activeGuildIds.length === 0) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const result = await db
    .delete(communityVcSessionsTable)
    .where(
      and(
        notInArray(communityVcSessionsTable.guildId, activeGuildIds),
        isNotNull(communityVcSessionsTable.leftAt),
        lt(communityVcSessionsTable.leftAt, cutoff),
      ),
    )
    .returning({ id: communityVcSessionsTable.id });
  return result.length;
}

// ─── Leave Log Settings ───────────────────────────────────────────────────────

export async function getLeaveLogChannel(guildId: string): Promise<string | null> {
  const [row] = await db
    .select({ leaveLogChannelId: communityRankingSettingsTable.leaveLogChannelId })
    .from(communityRankingSettingsTable)
    .where(eq(communityRankingSettingsTable.guildId, guildId));
  return row?.leaveLogChannelId ?? null;
}

/**
 * A completed VC session row enriched with the user's current opt-out status.
 * `optedOut` is true when the user has an active per-guild or global opt-out at
 * the time of the query, regardless of when the session was recorded.
 */
export interface TempVcDeletionRow {
  id: number;
  guildId: string;
  userId: string;
  channelId: string;
  joinedAt: Date;
  leftAt: Date;
  optedOut: boolean;
}

/**
 * Returns completed VC sessions (leftAt IS NOT NULL) for a guild,
 * optionally filtered to a date window on leftAt.
 *
 * Each row carries an `optedOut` boolean reflecting whether the user currently
 * has an active opt-out (per-guild OR global).  This lets admins flag
 * privacy-sensitive rows in the CSV export without a separate lookup.
 *
 * @param start - Inclusive lower bound (sessions that ended at or after this date).
 * @param end   - Exclusive upper bound (sessions that ended strictly before this date).
 *               To include a full calendar day, pass midnight of the following day.
 */
export async function getAllTempVcDeletions(
  guildId: string,
  opts: { start?: Date; end?: Date; userId?: string } = {},
): Promise<TempVcDeletionRow[]> {
  const startFilter = opts.start ? sql`AND s.left_at >= ${opts.start}` : sql``;
  const endFilter   = opts.end   ? sql`AND s.left_at < ${opts.end}`   : sql``;
  const userFilter  = opts.userId ? sql`AND s.user_id = ${opts.userId}` : sql``;

  const rows = await db.execute<{
    id: number;
    guild_id: string;
    user_id: string;
    channel_id: string;
    joined_at: string | Date;
    left_at: string | Date;
    opted_out: boolean;
  }>(sql`
    SELECT
      s.id,
      s.guild_id,
      s.user_id,
      s.channel_id,
      s.joined_at,
      s.left_at,
      (
        EXISTS (
          SELECT 1 FROM community_vc_privacy_global g
          WHERE g.user_id = s.user_id AND g.opted_out = true
        )
        OR
        EXISTS (
          SELECT 1 FROM community_vc_privacy p
          WHERE p.guild_id = s.guild_id AND p.user_id = s.user_id AND p.opted_out = true
        )
      ) AS opted_out
    FROM community_vc_sessions s
    WHERE s.guild_id = ${guildId}
      AND s.left_at IS NOT NULL
      ${startFilter}
      ${endFilter}
      ${userFilter}
    ORDER BY s.left_at ASC
  `);

  return rows.rows.map((r) => ({
    id: Number(r.id),
    guildId: r.guild_id,
    userId: r.user_id,
    channelId: r.channel_id,
    joinedAt: new Date(r.joined_at),
    leftAt: new Date(r.left_at),
    optedOut: r.opted_out === true,
  }));
}

/**
 * Counts completed VC sessions for a guild whose left_at is older than the
 * given number of days.  Active sessions (left_at IS NULL) are never counted.
 * Used to show admins a dry-run impact count before they apply a short retention window.
 */
export async function countCompletedSessionsOlderThan(guildId: string, days: number): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await db.execute<{ cnt: string }>(sql`
    SELECT COUNT(*)::bigint AS cnt
    FROM community_vc_sessions
    WHERE guild_id = ${guildId}
      AND left_at IS NOT NULL
      AND left_at < ${cutoff}
  `);
  return Number(rows.rows[0]?.cnt ?? 0);
}

export async function setLeaveLogChannel(
  guildId: string,
  channelId: string | null,
): Promise<void> {
  // `channelId: null` and `period: "all"` are placeholder values used only
  // when this INSERT creates a brand-new guild row.  They are safe defaults:
  //   - `channelId` (the ranking embed channel) is nullable, so null = disabled.
  //   - `period` has a DB-level default of "all", so "all" matches that default.
  // When a row already exists the onConflictDoUpdate path only touches
  // `leaveLogChannelId`, leaving every other column completely undisturbed.
  await db
    .insert(communityRankingSettingsTable)
    .values({ guildId, channelId: null, period: "all", leaveLogChannelId: channelId })
    .onConflictDoUpdate({
      target: communityRankingSettingsTable.guildId,
      set: { leaveLogChannelId: channelId, updatedAt: new Date() },
    });
}

// ─── Audit Log Settings ───────────────────────────────────────────────────────

export async function getAuditLogChannel(guildId: string): Promise<string | null> {
  const [row] = await db
    .select({ auditLogChannelId: communityRankingSettingsTable.auditLogChannelId })
    .from(communityRankingSettingsTable)
    .where(eq(communityRankingSettingsTable.guildId, guildId));
  return row?.auditLogChannelId ?? null;
}

export async function setAuditLogChannel(
  guildId: string,
  channelId: string | null,
): Promise<void> {
  // `channelId: null` and `period: "all"` are placeholder values used only
  // when this INSERT creates a brand-new guild row.  They are safe defaults:
  //   - `channelId` (the ranking embed channel) is nullable, so null = disabled.
  //   - `period` has a DB-level default of "all", so "all" matches that default.
  // When a row already exists the onConflictDoUpdate path only touches
  // `auditLogChannelId`, leaving every other column completely undisturbed.
  await db
    .insert(communityRankingSettingsTable)
    .values({ guildId, channelId: null, period: "all", auditLogChannelId: channelId })
    .onConflictDoUpdate({
      target: communityRankingSettingsTable.guildId,
      set: { auditLogChannelId: channelId, updatedAt: new Date() },
    });
}

// ─── Guild VC Reset ───────────────────────────────────────────────────────────

/**
 * Deletes ALL VC sessions (active and completed) for a single guild.
 * Returns the number of rows deleted.
 */
export async function wipeGuildVcSessions(guildId: string): Promise<number> {
  // Only delete completed sessions (left_at IS NOT NULL).
  // Active sessions (left_at IS NULL) are skipped so ongoing tracking is not
  // silently cleared — the bot would never close those sessions properly.
  const result = await db
    .delete(communityVcSessionsTable)
    .where(and(
      eq(communityVcSessionsTable.guildId, guildId),
      isNotNull(communityVcSessionsTable.leftAt),
    ))
    .returning({ id: communityVcSessionsTable.id });
  return result.length;
}

// ─── Tracked VC Category Settings ────────────────────────────────────────────

export async function getTrackedVcCategoryId(guildId: string): Promise<string | null> {
  const [row] = await db
    .select({ trackedVcCategoryId: communityRankingSettingsTable.trackedVcCategoryId })
    .from(communityRankingSettingsTable)
    .where(eq(communityRankingSettingsTable.guildId, guildId));
  return row?.trackedVcCategoryId ?? null;
}

export async function setTrackedVcCategoryId(
  guildId: string,
  categoryId: string | null,
): Promise<void> {
  await db
    .insert(communityRankingSettingsTable)
    .values({ guildId, channelId: null, period: "all", trackedVcCategoryId: categoryId })
    .onConflictDoUpdate({
      target: communityRankingSettingsTable.guildId,
      set: { trackedVcCategoryId: categoryId, updatedAt: new Date() },
    });
}

// Re-export awardVcTime so tests can mock it from this module
export { awardVcTime } from "./points.js";

/** Injectable dependencies for openVcSessionIfTracked (used in tests). */
export interface OpenVcSessionIfTrackedDeps {
  getTrackedVcCategoryId: (guildId: string) => Promise<string | null>;
  openSession: (guildId: string, userId: string, channelId: string, isExile: boolean) => Promise<CommunityVcSession | null>;
}

/**
 * Opens a VC session for the user when the destination channel belongs to the
 * guild's configured tracked category (or when no category restriction is set).
 *
 * This function is the canonical decision point for category-gating.  It is
 * exported so tests can import and call it directly (with injected mock deps)
 * rather than duplicating the logic inline and risking silent divergence.
 *
 * Behaviour:
 *   - Reads trackedVcCategoryId via getTrackedVcCategoryId (or the injected override).
 *   - If the read throws, logs the error and returns (fail closed — does NOT
 *     fall back to "track everything").
 *   - If trackedVcCategoryId is null, every channel is tracked.
 *   - If trackedVcCategoryId is set, only channels whose parentId matches are
 *     tracked; others are silently skipped.
 *
 * @param deps  Optional dependency overrides.  Production code omits this
 *              parameter (defaults to the real implementations).  Tests pass
 *              mock functions so no module-wide mock is required.
 */
export async function openVcSessionIfTracked(
  guildId: string,
  userId: string,
  channelId: string,
  channelParentId: string | null,
  isExile: boolean,
  deps: OpenVcSessionIfTrackedDeps = { getTrackedVcCategoryId, openSession },
): Promise<void> {
  let trackedCategoryId: string | null;
  try {
    trackedCategoryId = await deps.getTrackedVcCategoryId(guildId);
  } catch (err) {
    logger.error(`[vc] getTrackedVcCategoryId error guildId=${guildId} user=${userId}`, err);
    return;
  }
  const isTracked = !trackedCategoryId || channelParentId === trackedCategoryId;
  if (isTracked) {
    await deps.openSession(guildId, userId, channelId, isExile).catch((err) =>
      logger.error(`[vc] openSession error user=${userId}`, err),
    );
  }
}

/**
 * Converts a TempVcDeletionRow array into a CSV string.
 *
 * Columns (in order):
 *   id, user_id, channel_id, joined_at, left_at, duration_seconds, opted_out
 *
 * `opted_out` is the last column and contains the literal string "true" or
 * "false" so downstream tooling can filter privacy-sensitive rows without
 * needing a secondary lookup.
 *
 * Fields are RFC 4180-quoted: any field that contains a comma, a double-quote,
 * or a newline is wrapped in double-quotes, with any embedded double-quotes
 * doubled.  This prevents a channelId or userId that happens to contain a
 * comma from shifting subsequent columns and silently corrupting the export.
 */
export function buildTempVcCsv(rows: TempVcDeletionRow[]): string {
  /** Wrap a field value in double-quotes if it contains reserved characters. */
  function csvField(value: string): string {
    if (value.includes(",") || value.includes('"') || value.includes("\n")) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  const header = "id,user_id,channel_id,joined_at,left_at,duration_seconds,opted_out";
  const lines = rows.map((r) => {
    const joinedIso = r.joinedAt.toISOString();
    const leftIso   = r.leftAt.toISOString();
    const durationSec = Math.floor(
      (r.leftAt.getTime() - r.joinedAt.getTime()) / 1000,
    );
    return [
      csvField(String(r.id)),
      csvField(r.userId),
      csvField(r.channelId),
      csvField(joinedIso),
      csvField(leftIso),
      csvField(String(durationSec)),
      csvField(String(r.optedOut)),
    ].join(",");
  });
  return [header, ...lines].join("\n");
}
