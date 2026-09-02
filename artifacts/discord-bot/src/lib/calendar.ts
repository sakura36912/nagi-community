import { and, asc, eq, gte, isNull, lte, or } from "drizzle-orm";
import {
  communityEventParticipantsTable,
  communityEventSettingsTable,
  communityEventsTable,
  db,
  type CommunityEvent,
  type CommunityEventSettings,
} from "@workspace/db";

export const CALENDAR_REMINDER_24H_MS = 24 * 60 * 60 * 1000;
export const CALENDAR_REMINDER_LOOKBACK_MS = 2 * 60 * 60 * 1000;

export async function getCalendarSettings(guildId: string): Promise<CommunityEventSettings | null> {
  const [settings] = await db
    .select()
    .from(communityEventSettingsTable)
    .where(eq(communityEventSettingsTable.guildId, guildId))
    .limit(1);
  return settings ?? null;
}

export async function upsertCalendarSettings(
  guildId: string,
  notifyChannelId: string,
  notifyRoleId: string | null,
): Promise<CommunityEventSettings> {
  const [settings] = await db
    .insert(communityEventSettingsTable)
    .values({ guildId, notifyChannelId, notifyRoleId })
    .onConflictDoUpdate({
      target: communityEventSettingsTable.guildId,
      set: { notifyChannelId, notifyRoleId, updatedAt: new Date() },
    })
    .returning();
  if (!settings) throw new Error("カレンダー通知設定を保存できませんでした。");
  return settings;
}

export async function createCalendarEvent(input: {
  guildId: string;
  channelId: string;
  title: string;
  description?: string | null;
  scheduledAt: Date;
}): Promise<CommunityEvent> {
  const [event] = await db
    .insert(communityEventsTable)
    .values({
      guildId: input.guildId,
      channelId: input.channelId,
      title: input.title,
      description: input.description ?? null,
      scheduledAt: input.scheduledAt,
    })
    .returning();
  if (!event) throw new Error("予定を保存できませんでした。");
  return event;
}

export async function getCalendarEvent(eventId: number): Promise<CommunityEvent | null> {
  const [event] = await db
    .select()
    .from(communityEventsTable)
    .where(eq(communityEventsTable.id, eventId))
    .limit(1);
  return event ?? null;
}

export async function listCalendarEvents(
  guildId: string,
  from: Date,
  to: Date,
): Promise<CommunityEvent[]> {
  return db
    .select()
    .from(communityEventsTable)
    .where(and(
      eq(communityEventsTable.guildId, guildId),
      gte(communityEventsTable.scheduledAt, from),
      lte(communityEventsTable.scheduledAt, to),
    ))
    .orderBy(asc(communityEventsTable.scheduledAt));
}

export async function listCalendarReminderCandidates(now: Date): Promise<CommunityEvent[]> {
  const lower = new Date(now.getTime() - CALENDAR_REMINDER_LOOKBACK_MS);
  const upper = new Date(now.getTime() + CALENDAR_REMINDER_24H_MS + 60 * 1000);
  return db
    .select()
    .from(communityEventsTable)
    .where(and(
      gte(communityEventsTable.scheduledAt, lower),
      lte(communityEventsTable.scheduledAt, upper),
      or(
        isNull(communityEventsTable.reminder24hSentAt),
        isNull(communityEventsTable.reminderSentAt),
      ),
    ))
    .orderBy(asc(communityEventsTable.scheduledAt));
}

export async function setCalendarEventMessageId(eventId: number, messageId: string): Promise<void> {
  await db
    .update(communityEventsTable)
    .set({ messageId })
    .where(eq(communityEventsTable.id, eventId));
}

export async function markCalendar24hReminderSent(eventId: number, sentAt = new Date()): Promise<void> {
  await db
    .update(communityEventsTable)
    .set({ reminder24hSentAt: sentAt })
    .where(and(
      eq(communityEventsTable.id, eventId),
      isNull(communityEventsTable.reminder24hSentAt),
    ));
}

export async function markCalendarStartReminderSent(eventId: number, sentAt = new Date()): Promise<void> {
  await db
    .update(communityEventsTable)
    .set({ reminderSentAt: sentAt })
    .where(and(
      eq(communityEventsTable.id, eventId),
      isNull(communityEventsTable.reminderSentAt),
    ));
}

export async function deleteCalendarEvent(eventId: number): Promise<void> {
  await db.delete(communityEventsTable).where(eq(communityEventsTable.id, eventId));
}

export async function getCalendarParticipantIds(eventId: number): Promise<string[]> {
  const rows = await db
    .select({ userId: communityEventParticipantsTable.userId })
    .from(communityEventParticipantsTable)
    .where(eq(communityEventParticipantsTable.eventId, eventId))
    .orderBy(asc(communityEventParticipantsTable.joinedAt));
  return rows.map((row) => row.userId);
}

export async function isCalendarParticipant(eventId: number, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: communityEventParticipantsTable.userId })
    .from(communityEventParticipantsTable)
    .where(and(
      eq(communityEventParticipantsTable.eventId, eventId),
      eq(communityEventParticipantsTable.userId, userId),
    ))
    .limit(1);
  return row !== undefined;
}

export async function addCalendarParticipant(eventId: number, userId: string): Promise<void> {
  await db
    .insert(communityEventParticipantsTable)
    .values({ eventId, userId })
    .onConflictDoNothing();
}

export async function removeCalendarParticipant(eventId: number, userId: string): Promise<void> {
  await db
    .delete(communityEventParticipantsTable)
    .where(and(
      eq(communityEventParticipantsTable.eventId, eventId),
      eq(communityEventParticipantsTable.userId, userId),
    ));
}