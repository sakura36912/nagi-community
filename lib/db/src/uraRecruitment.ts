import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lte,
  ne,
  or,
} from "drizzle-orm";
import { db } from "./index";
import {
  uraApplicationsTable,
  uraBlocksTable,
  uraMatchesTable,
  uraRecruitmentSettingsTable,
  uraRecruitmentsTable,
  uraReportsTable,
} from "./schema/uraRecruitment";

export const URA_TALK = "talk" as const;
export const URA_SLEEP = "sleep" as const;
export type UraRecruitmentType = typeof URA_TALK | typeof URA_SLEEP;

export async function getUraRecruitmentSettings(guildId: string) {
  const existing = await db
    .select()
    .from(uraRecruitmentSettingsTable)
    .where(eq(uraRecruitmentSettingsTable.guildId, guildId))
    .limit(1);
  if (existing[0]) return existing[0];
  const inserted = await db
    .insert(uraRecruitmentSettingsTable)
    .values({ guildId })
    .onConflictDoNothing({ target: uraRecruitmentSettingsTable.guildId })
    .returning();
  if (inserted[0]) return inserted[0];
  return (await db
    .select()
    .from(uraRecruitmentSettingsTable)
    .where(eq(uraRecruitmentSettingsTable.guildId, guildId))
    .limit(1))[0]!;
}

export async function setUraRecruitmentSettings(
  guildId: string,
  values: Partial<{
    recruitmentChannelId: string | null;
    vcCategoryId: string | null;
    logChannelId: string | null;
    enabled: boolean;
  }>,
) {
  const [row] = await db
    .insert(uraRecruitmentSettingsTable)
    .values({ guildId, ...values })
    .onConflictDoUpdate({
      target: uraRecruitmentSettingsTable.guildId,
      set: { ...values, updatedAt: new Date() },
    })
    .returning();
  return row;
}

export async function createUraRecruitment(values: {
  guildId: string;
  recruitmentChannelId: string;
  ownerId: string;
  type: UraRecruitmentType;
  note: string;
}) {
  const [row] = await db.insert(uraRecruitmentsTable).values(values).returning();
  return row;
}

export async function setUraRecruitmentMessage(id: number, messageId: string) {
  const [row] = await db
    .update(uraRecruitmentsTable)
    .set({ messageId })
    .where(eq(uraRecruitmentsTable.id, id))
    .returning();
  return row;
}

export async function getUraRecruitmentById(id: number) {
  return (await db.select().from(uraRecruitmentsTable).where(eq(uraRecruitmentsTable.id, id)).limit(1))[0] ?? null;
}

export async function getUraRecruitmentByMessageId(messageId: string) {
  return (await db
    .select()
    .from(uraRecruitmentsTable)
    .where(eq(uraRecruitmentsTable.messageId, messageId))
    .limit(1))[0] ?? null;
}

export async function listOpenUraRecruitments(guildId: string) {
  return db
    .select()
    .from(uraRecruitmentsTable)
    .where(and(eq(uraRecruitmentsTable.guildId, guildId), eq(uraRecruitmentsTable.status, "open")))
    .orderBy(desc(uraRecruitmentsTable.createdAt));
}

export async function getOpenUraRecruitmentByOwner(guildId: string, ownerId: string) {
  return (await db
    .select()
    .from(uraRecruitmentsTable)
    .where(and(
      eq(uraRecruitmentsTable.guildId, guildId),
      eq(uraRecruitmentsTable.ownerId, ownerId),
      eq(uraRecruitmentsTable.status, "open"),
    ))
    .limit(1))[0] ?? null;
}

export async function setUraRecruitmentCancelled(id: number) {
  const [row] = await db
    .update(uraRecruitmentsTable)
    .set({ status: "cancelled", closedAt: new Date() })
    .where(and(eq(uraRecruitmentsTable.id, id), eq(uraRecruitmentsTable.status, "open")))
    .returning();
  return row ?? null;
}

export async function cancelUraRecruitment(id: number, ownerId: string) {
  const [row] = await db
    .update(uraRecruitmentsTable)
    .set({ status: "cancelled", closedAt: new Date() })
    .where(and(eq(uraRecruitmentsTable.id, id), eq(uraRecruitmentsTable.ownerId, ownerId), eq(uraRecruitmentsTable.status, "open")))
    .returning();
  if (row) {
    await db
      .update(uraApplicationsTable)
      .set({ status: "dismissed", updatedAt: new Date() })
      .where(and(eq(uraApplicationsTable.recruitmentId, id), eq(uraApplicationsTable.status, "pending")));
  }
  return row ?? null;
}

export async function createUraApplication(values: {
  recruitmentId: number;
  guildId: string;
  applicantId: string;
  note: string;
}) {
  const inserted = await db
    .insert(uraApplicationsTable)
    .values(values)
    .onConflictDoNothing({
      target: [uraApplicationsTable.recruitmentId, uraApplicationsTable.applicantId],
    })
    .returning();
  return inserted[0] ?? null;
}

export async function getUraApplication(recruitmentId: number, applicantId: string) {
  return (await db
    .select()
    .from(uraApplicationsTable)
    .where(and(eq(uraApplicationsTable.recruitmentId, recruitmentId), eq(uraApplicationsTable.applicantId, applicantId)))
    .limit(1))[0] ?? null;
}

export async function listUraApplications(recruitmentId: number) {
  return db
    .select()
    .from(uraApplicationsTable)
    .where(eq(uraApplicationsTable.recruitmentId, recruitmentId))
    .orderBy(asc(uraApplicationsTable.createdAt));
}

export async function getUraApplicationById(id: number) {
  return (await db.select().from(uraApplicationsTable).where(eq(uraApplicationsTable.id, id)).limit(1))[0] ?? null;
}

export async function dismissUraApplication(id: number) {
  const [row] = await db
    .update(uraApplicationsTable)
    .set({ status: "dismissed", updatedAt: new Date() })
    .where(and(eq(uraApplicationsTable.id, id), eq(uraApplicationsTable.status, "pending")))
    .returning();
  return row ?? null;
}

export async function markUraRecruitmentMatched(id: number, applicantId: string) {
  return db.transaction(async (tx) => {
    const [recruitment] = await tx
      .update(uraRecruitmentsTable)
      .set({
        status: "matched",
        selectedApplicantId: applicantId,
        closedAt: new Date(),
      })
      .where(and(eq(uraRecruitmentsTable.id, id), eq(uraRecruitmentsTable.status, "open")))
      .returning();
    if (!recruitment) return null;
    await tx
      .update(uraApplicationsTable)
      .set({ status: "selected", updatedAt: new Date() })
      .where(and(eq(uraApplicationsTable.recruitmentId, id), eq(uraApplicationsTable.applicantId, applicantId)));
    await tx
      .update(uraApplicationsTable)
      .set({ status: "dismissed", updatedAt: new Date() })
      .where(and(eq(uraApplicationsTable.recruitmentId, id), ne(uraApplicationsTable.applicantId, applicantId), eq(uraApplicationsTable.status, "pending")));
    return recruitment;
  });
}

export async function abortUraRecruitment(id: number) {
  const [row] = await db
    .update(uraRecruitmentsTable)
    .set({ status: "cancelled", closedAt: new Date() })
    .where(eq(uraRecruitmentsTable.id, id))
    .returning();
  return row ?? null;
}

export async function createUraMatch(values: {
  guildId: string;
  recruitmentId: number;
  hostId: string;
  guestId: string;
  channelId: string;
}) {
  const [row] = await db.insert(uraMatchesTable).values(values).returning();
  await db
    .update(uraRecruitmentsTable)
    .set({ vcChannelId: values.channelId })
    .where(eq(uraRecruitmentsTable.id, values.recruitmentId));
  return row;
}

export async function getUraMatchById(id: number) {
  return (await db.select().from(uraMatchesTable).where(eq(uraMatchesTable.id, id)).limit(1))[0] ?? null;
}

export async function getUraMatchByChannelId(channelId: string) {
  return (await db
    .select()
    .from(uraMatchesTable)
    .where(and(eq(uraMatchesTable.channelId, channelId), eq(uraMatchesTable.status, "active")))
    .limit(1))[0] ?? null;
}

export async function getActiveUraMatchForUser(guildId: string, userId: string) {
  return (await db
    .select()
    .from(uraMatchesTable)
    .where(and(
      eq(uraMatchesTable.guildId, guildId),
      eq(uraMatchesTable.status, "active"),
      or(eq(uraMatchesTable.hostId, userId), eq(uraMatchesTable.guestId, userId)),
    ))
    .limit(1))[0] ?? null;
}

export async function markUraMatchDeleteAt(id: number, deleteAt: Date | null) {
  const [row] = await db
    .update(uraMatchesTable)
    .set({ deleteAt })
    .where(and(eq(uraMatchesTable.id, id), eq(uraMatchesTable.status, "active")))
    .returning();
  return row ?? null;
}

export async function listUraMatchesReadyForDeletion(now: Date) {
  return db
    .select()
    .from(uraMatchesTable)
    .where(and(eq(uraMatchesTable.status, "active"), lte(uraMatchesTable.deleteAt, now)));
}

export async function finishUraMatch(id: number) {
  const [row] = await db
    .update(uraMatchesTable)
    .set({ status: "finished", endedAt: new Date(), deleteAt: null })
    .where(and(eq(uraMatchesTable.id, id), ne(uraMatchesTable.status, "finished")))
    .returning();
  return row ?? null;
}

export async function addUraBlock(guildId: string, blockerId: string, blockedId: string) {
  await db
    .insert(uraBlocksTable)
    .values({ guildId, blockerId, blockedId })
    .onConflictDoNothing();
}

export async function removeUraBlock(guildId: string, blockerId: string, blockedId: string) {
  await db.delete(uraBlocksTable).where(and(
    eq(uraBlocksTable.guildId, guildId),
    eq(uraBlocksTable.blockerId, blockerId),
    eq(uraBlocksTable.blockedId, blockedId),
  ));
}

export async function isUraBlocked(guildId: string, userAId: string, userBId: string) {
  const rows = await db
    .select()
    .from(uraBlocksTable)
    .where(and(
      eq(uraBlocksTable.guildId, guildId),
      or(
        and(eq(uraBlocksTable.blockerId, userAId), eq(uraBlocksTable.blockedId, userBId)),
        and(eq(uraBlocksTable.blockerId, userBId), eq(uraBlocksTable.blockedId, userAId)),
      ),
    ))
    .limit(1);
  return rows.length > 0;
}

export async function listUraBlocks(guildId: string, userId: string) {
  return db
    .select()
    .from(uraBlocksTable)
    .where(and(eq(uraBlocksTable.guildId, guildId), eq(uraBlocksTable.blockerId, userId)));
}

export async function createUraReport(values: {
  guildId: string;
  matchId: number;
  reporterId: string;
  reportedId: string;
  reason: string;
  details: string;
}) {
  const [row] = await db.insert(uraReportsTable).values(values).returning();
  return row;
}

export async function listUraReports(guildId: string) {
  return db
    .select()
    .from(uraReportsTable)
    .where(eq(uraReportsTable.guildId, guildId))
    .orderBy(desc(uraReportsTable.createdAt));
}