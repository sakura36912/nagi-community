import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "./index.js";
import {
  bountyAuditOutboxTable,
  bountyMonthlyPayoutsTable,
  bountyMonthlySnapshotsTable,
  bountyMonthlySnapshotMembersTable,
  bountyMonthlyRateHistoryTable,
  bountyMonthlyRatesTable,
  bountyPointLedgerTable,
  bountyPointsTable,
  bountySettingsTable,
  bountyVcProgressTable,
  bountyVcRatesTable,
  bountyVoicePresenceTable,
} from "./schema/bounty.js";
import { vcHubChannelsTable, vcHubSessionsTable } from "./schema/vcHub.js";

const MAX_POINTS = 2_147_483_647;
const SECONDS_PER_HOUR = 3_600;

async function lockBountyVoiceGuild(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  guildId: string,
): Promise<void> {
  // SQLite BEGIN IMMEDIATE already serializes every writer before any read.
}

async function lockBountyMonthlyGuild(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  guildId: string,
): Promise<void> {
  // Covered by the write transaction's database-wide reservation.
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_POINTS) {
    throw new Error(`${name} must be a non-negative 32-bit integer.`);
  }
}

function assertText(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty.`);
}

function nextMonthJstCutoff(monthKey: string): Date {
  const [year, month] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(year, month, 1) - 9 * 60 * 60 * 1_000);
}

function validateBountyMonthKey(monthKey: string): void {
  const parsed = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!parsed || Number(parsed[2]) < 1 || Number(parsed[2]) > 12) {
    throw new Error("monthKey must be a valid YYYY-MM month.");
  }
}

export async function getBountyMonthReview(guildId: string, monthKey: string) {
  validateBountyMonthKey(monthKey);
  const [snapshot] = await db.select().from(bountyMonthlySnapshotsTable)
    .where(and(
      eq(bountyMonthlySnapshotsTable.guildId, guildId),
      eq(bountyMonthlySnapshotsTable.monthKey, monthKey),
    )).limit(1);
  const [payout] = await db.select().from(bountyMonthlyPayoutsTable)
    .where(and(
      eq(bountyMonthlyPayoutsTable.guildId, guildId),
      eq(bountyMonthlyPayoutsTable.monthKey, monthKey),
    )).limit(1);
  const members = snapshot ? await db.select().from(bountyMonthlySnapshotMembersTable)
    .where(and(
      eq(bountyMonthlySnapshotMembersTable.guildId, guildId),
      eq(bountyMonthlySnapshotMembersTable.monthKey, monthKey),
    )) : [];
  return { snapshot: snapshot ?? null, paid: Boolean(payout), members };
}

export async function listBountyMonthsNeedingAttention(guildId: string): Promise<string[]> {
  const rows = await db.select({ monthKey: bountyMonthlySnapshotsTable.monthKey })
    .from(bountyMonthlySnapshotsTable)
    .leftJoin(bountyMonthlyPayoutsTable, and(
      eq(bountyMonthlyPayoutsTable.guildId, bountyMonthlySnapshotsTable.guildId),
      eq(bountyMonthlyPayoutsTable.monthKey, bountyMonthlySnapshotsTable.monthKey),
    ))
    .where(and(
      eq(bountyMonthlySnapshotsTable.guildId, guildId),
      isNull(bountyMonthlyPayoutsTable.monthKey),
      or(
        eq(bountyMonthlySnapshotsTable.status, "approved"),
        and(
          eq(bountyMonthlySnapshotsTable.status, "pending"),
          isNull(bountyMonthlySnapshotsTable.notifiedAt),
        ),
      ),
    ));
  return rows.map(({ monthKey }) => monthKey);
}

export async function holdBountyMonthForReview(guildId: string, monthKey: string): Promise<void> {
  validateBountyMonthKey(monthKey);
  await db.insert(bountyMonthlySnapshotsTable).values({
    guildId, monthKey, status: "pending",
  }).onConflictDoNothing();
}

export async function markBountyMonthReviewNotified(guildId: string, monthKey: string): Promise<void> {
  await db.update(bountyMonthlySnapshotsTable).set({ notifiedAt: new Date() })
    .where(and(
      eq(bountyMonthlySnapshotsTable.guildId, guildId),
      eq(bountyMonthlySnapshotsTable.monthKey, monthKey),
      eq(bountyMonthlySnapshotsTable.status, "pending"),
    ));
}

/** Persist the complete live role set atomically; a missing/corrupt snapshot can never pay. */
export async function captureBountyMonthSnapshot(
  guildId: string, monthKey: string, members: Map<string, string[]>, capturedAt = new Date(),
): Promise<boolean> {
  validateBountyMonthKey(monthKey);
  const cutoff = nextMonthJstCutoff(monthKey);
  if (capturedAt.getTime() < cutoff.getTime() || capturedAt.getTime() > cutoff.getTime() + 5_000) {
    throw new Error("Monthly bounty snapshot was not taken at the JST cutoff.");
  }
  return db.transaction(async (tx) => {
    await lockBountyMonthlyGuild(tx, guildId);
    const [inserted] = await tx.insert(bountyMonthlySnapshotsTable)
      .values({ guildId, monthKey, status: "captured", capturedAt })
      .onConflictDoNothing()
      .returning({ monthKey: bountyMonthlySnapshotsTable.monthKey });
    if (!inserted) return false;
    if (members.size > 0) {
      await tx.insert(bountyMonthlySnapshotMembersTable).values(
        [...members].map(([userId, roleIds]) => ({
          guildId, monthKey, userId, roleIds: [...new Set(roleIds)],
        })),
      );
    }
    return true;
  });
}

/** Staff explicitly identify who held the crew role and which payout roles applied at cutoff. */
export async function addBountyMonthReviewMember(
  guildId: string, monthKey: string, userId: string, roleId: string,
): Promise<void> {
  validateBountyMonthKey(monthKey);
  assertText(userId, "userId");
  assertText(roleId, "roleId");
  await db.transaction(async (tx) => {
    await lockBountyMonthlyGuild(tx, guildId);
    const [snapshot] = await tx.select().from(bountyMonthlySnapshotsTable)
      .where(and(
        eq(bountyMonthlySnapshotsTable.guildId, guildId),
        eq(bountyMonthlySnapshotsTable.monthKey, monthKey),
      )).limit(1);
    if (snapshot?.status !== "pending") throw new Error("この月は確認待ちではありません。");
    const [settings] = await tx.select().from(bountySettingsTable)
      .where(eq(bountySettingsTable.guildId, guildId)).limit(1);
    if (!settings) throw new Error("賞金ポイント設定がありません。");
    const cutoff = nextMonthJstCutoff(monthKey);
    const [pastRate] = await tx.select().from(bountyMonthlyRateHistoryTable)
      .where(and(
        eq(bountyMonthlyRateHistoryTable.guildId, guildId),
        eq(bountyMonthlyRateHistoryTable.roleId, roleId),
        sql`${bountyMonthlyRateHistoryTable.effectiveAt} < ${cutoff}`,
      ))
      .orderBy(desc(bountyMonthlyRateHistoryTable.effectiveAt), desc(bountyMonthlyRateHistoryTable.id))
      .limit(1);
    const [anyHistory] = await tx.select({ id: bountyMonthlyRateHistoryTable.id })
      .from(bountyMonthlyRateHistoryTable)
      .where(and(
        eq(bountyMonthlyRateHistoryTable.guildId, guildId),
        eq(bountyMonthlyRateHistoryTable.roleId, roleId),
      )).limit(1);
    const [legacyRate] = !anyHistory ? await tx.select().from(bountyMonthlyRatesTable)
      .where(and(
        eq(bountyMonthlyRatesTable.guildId, guildId),
        eq(bountyMonthlyRatesTable.roleId, roleId),
        sql`${bountyMonthlyRatesTable.effectiveAt} < ${cutoff}`,
      )).limit(1) : [];
    if ((pastRate?.points ?? legacyRate?.points ?? 0) <= 0) {
      throw new Error("このロールには月初時点で有効な月次付与ポイントが設定されていません。");
    }
    const [existing] = await tx.select().from(bountyMonthlySnapshotMembersTable)
      .where(and(
        eq(bountyMonthlySnapshotMembersTable.guildId, guildId),
        eq(bountyMonthlySnapshotMembersTable.monthKey, monthKey),
        eq(bountyMonthlySnapshotMembersTable.userId, userId),
      )).limit(1);
    const roleIds = [...new Set([...(existing?.roleIds ?? []), settings.crewRoleId, roleId])];
    await tx.insert(bountyMonthlySnapshotMembersTable)
      .values({ guildId, monthKey, userId, roleIds })
      .onConflictDoUpdate({
        target: [
          bountyMonthlySnapshotMembersTable.guildId,
          bountyMonthlySnapshotMembersTable.monthKey,
          bountyMonthlySnapshotMembersTable.userId,
        ],
        set: { roleIds },
      });
  });
}

export type BountyReviewImportRow = { userId: string; roleIds: string[] };
export type BountyReviewImportChange = { userId: string; before: string[] | null; after: string[] };

/**
 * Preview and commit take the same monthly advisory lock as review-add and approval.
 * Import replaces the role list for specified users; it does not delete absent users.
 */
async function importBountyMonthReview(
  guildId: string, monthKey: string, rows: BountyReviewImportRow[],
  expected?: { members: BountyReviewImportRow[]; changes: BountyReviewImportChange[] },
): Promise<{ members: BountyReviewImportRow[]; changes: BountyReviewImportChange[] }> {
  validateBountyMonthKey(monthKey);
  if (rows.length < 1 || rows.length > 500) throw new Error("対象者は1〜500人を指定してください。");
  const userIds = new Set<string>();
  const wantedRoles = new Set<string>();
  for (const row of rows) {
    if (!/^\d{17,20}$/.test(row.userId) || userIds.has(row.userId)) {
      throw new Error("ユーザーIDが不正または重複しています。");
    }
    userIds.add(row.userId);
    if (!row.roleIds.length || new Set(row.roleIds).size !== row.roleIds.length) {
      throw new Error(`${row.userId} のロール指定が空または重複しています。`);
    }
    for (const roleId of row.roleIds) {
      if (!/^\d{17,20}$/.test(roleId)) throw new Error(`${row.userId} のロールIDが不正です。`);
      wantedRoles.add(roleId);
    }
  }
  return db.transaction(async (tx) => {
    await lockBountyMonthlyGuild(tx, guildId);
    const [snapshot] = await tx.select().from(bountyMonthlySnapshotsTable).where(and(
      eq(bountyMonthlySnapshotsTable.guildId, guildId),
      eq(bountyMonthlySnapshotsTable.monthKey, monthKey),
    )).limit(1);
    const [paid] = await tx.select().from(bountyMonthlyPayoutsTable).where(and(
      eq(bountyMonthlyPayoutsTable.guildId, guildId),
      eq(bountyMonthlyPayoutsTable.monthKey, monthKey),
    )).limit(1);
    if (snapshot?.status !== "pending" || paid) throw new Error("この月は管理者確認待ちではありません。");
    const [settings] = await tx.select().from(bountySettingsTable)
      .where(eq(bountySettingsTable.guildId, guildId)).limit(1);
    if (!settings) throw new Error("賞金ポイント設定がありません。");
    const cutoff = nextMonthJstCutoff(monthKey);
    if (settings.createdAt.getTime() >= cutoff.getTime() || cutoff.getTime() > Date.now()) {
      throw new Error("設定前または月初前の月は登録できません。");
    }
    const roleIds = [...wantedRoles];
    const history = await tx.select().from(bountyMonthlyRateHistoryTable).where(and(
      eq(bountyMonthlyRateHistoryTable.guildId, guildId),
      inArray(bountyMonthlyRateHistoryTable.roleId, roleIds),
    )).orderBy(desc(bountyMonthlyRateHistoryTable.effectiveAt), desc(bountyMonthlyRateHistoryTable.id));
    const legacy = await tx.select().from(bountyMonthlyRatesTable).where(and(
      eq(bountyMonthlyRatesTable.guildId, guildId),
      inArray(bountyMonthlyRatesTable.roleId, roleIds),
    ));
    for (const roleId of roleIds) {
      const events = history.filter((event) => event.roleId === roleId);
      const pastRate = events.find((event) => event.effectiveAt.getTime() < cutoff.getTime());
      const oldRate = events.length === 0 ? legacy.find((rate) =>
        rate.roleId === roleId && rate.effectiveAt.getTime() < cutoff.getTime()) : undefined;
      if ((pastRate?.points ?? oldRate?.points ?? 0) <= 0) {
        throw new Error(`ロール ${roleId} は月初時点で月次付与ポイントが未設定です。`);
      }
    }
    const current = await tx.select().from(bountyMonthlySnapshotMembersTable).where(and(
      eq(bountyMonthlySnapshotMembersTable.guildId, guildId),
      eq(bountyMonthlySnapshotMembersTable.monthKey, monthKey),
    )).orderBy(asc(bountyMonthlySnapshotMembersTable.userId));
    const members = current.map(({ userId, roleIds }) => ({ userId, roleIds }));
    if (expected && JSON.stringify(members) !== JSON.stringify(expected.members)) {
      throw new Error("プレビュー後に対象者一覧が変更されました。CSVを再確認してください。");
    }
    const byUser = new Map(members.map((member) => [member.userId, member.roleIds]));
    const changes: BountyReviewImportChange[] = rows.map((row) => ({
      userId: row.userId,
      before: byUser.get(row.userId) ?? null,
      after: [settings.crewRoleId, ...row.roleIds.filter((id) => id !== settings.crewRoleId)].sort(),
    })).filter((change) =>
      !change.before || JSON.stringify([...change.before].sort()) !== JSON.stringify(change.after));
    if (expected && JSON.stringify(changes) !== JSON.stringify(expected.changes)) {
      throw new Error("プレビュー後にロール設定が変更されました。CSVを再確認してください。");
    }
    if (expected && changes.length) {
      await tx.insert(bountyMonthlySnapshotMembersTable).values(changes.map((change) => ({
        guildId, monthKey, userId: change.userId, roleIds: change.after,
      }))).onConflictDoUpdate({
        target: [
          bountyMonthlySnapshotMembersTable.guildId,
          bountyMonthlySnapshotMembersTable.monthKey,
          bountyMonthlySnapshotMembersTable.userId,
        ],
        set: { roleIds: sql`excluded.role_ids` },
      });
    }
    return { members, changes };
  });
}

export function previewBountyMonthReviewImport(guildId: string, monthKey: string, rows: BountyReviewImportRow[]) {
  return importBountyMonthReview(guildId, monthKey, rows);
}

export function commitBountyMonthReviewImport(
  guildId: string, monthKey: string, rows: BountyReviewImportRow[],
  expected: { members: BountyReviewImportRow[]; changes: BountyReviewImportChange[] },
) {
  return importBountyMonthReview(guildId, monthKey, rows, expected);
}

export async function removeBountyMonthReviewMember(guildId: string, monthKey: string, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await lockBountyMonthlyGuild(tx, guildId);
    const [snapshot] = await tx.select().from(bountyMonthlySnapshotsTable)
      .where(and(
        eq(bountyMonthlySnapshotsTable.guildId, guildId),
        eq(bountyMonthlySnapshotsTable.monthKey, monthKey),
      )).limit(1);
    if (snapshot?.status !== "pending") throw new Error("この月は確認待ちではありません。");
    await tx.delete(bountyMonthlySnapshotMembersTable).where(and(
      eq(bountyMonthlySnapshotMembersTable.guildId, guildId),
      eq(bountyMonthlySnapshotMembersTable.monthKey, monthKey),
      eq(bountyMonthlySnapshotMembersTable.userId, userId),
    ));
  });
}

export async function approveBountyMonthReview(
  guildId: string, monthKey: string, actorId: string,
  expectedMembers: Array<{ userId: string; roleIds: string[] }>,
): Promise<void> {
  validateBountyMonthKey(monthKey);
  assertText(actorId, "actorId");
  await db.transaction(async (tx) => {
    await lockBountyMonthlyGuild(tx, guildId);
    const [snapshot] = await tx.select().from(bountyMonthlySnapshotsTable)
      .where(and(
        eq(bountyMonthlySnapshotsTable.guildId, guildId),
        eq(bountyMonthlySnapshotsTable.monthKey, monthKey),
      )).limit(1);
    if (snapshot?.status !== "pending") throw new Error("この月は確認待ちではありません。");
    const members = await tx.select().from(bountyMonthlySnapshotMembersTable)
      .where(and(
        eq(bountyMonthlySnapshotMembersTable.guildId, guildId),
        eq(bountyMonthlySnapshotMembersTable.monthKey, monthKey),
      )).orderBy(asc(bountyMonthlySnapshotMembersTable.userId));
    if (JSON.stringify(members.map(({ userId, roleIds }) => ({ userId, roleIds })))
      !== JSON.stringify(expectedMembers.map(({ userId, roleIds }) => ({ userId, roleIds }))
        .sort((a, b) => a.userId.localeCompare(b.userId)))) {
      throw new Error("確認画面の表示後に対象者が変更されました。再確認してください。");
    }
    const [settings] = await tx.select().from(bountySettingsTable)
      .where(eq(bountySettingsTable.guildId, guildId)).limit(1);
    if (!settings || settings.createdAt.getTime() >= nextMonthJstCutoff(monthKey).getTime()) {
      throw new Error("設定前の月は承認できません。");
    }
    if (nextMonthJstCutoff(monthKey).getTime() > Date.now()) {
      throw new Error("月初前の月は承認できません。");
    }
    await tx.update(bountyMonthlySnapshotsTable)
      .set({
        status: "approved", approvedBy: actorId, approvalAuditQueuedAt: new Date(),
        approvalAuditChannelId: settings.logChannelId,
      })
      .where(and(
        eq(bountyMonthlySnapshotsTable.guildId, guildId),
        eq(bountyMonthlySnapshotsTable.monthKey, monthKey),
      ));
  });
}

/** An approval remains queued independently of whether its payout has completed. */
export async function listPendingBountyMonthlyApprovalAudits(
  guildId: string, limit = 100,
): Promise<Array<{
  monthKey: string; actorId: string; memberCount: number; queuedAt: Date;
  scanBeforeId: string | null; channelId: string | null;
}>> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("limit must be an integer between 1 and 1000.");
  }
  const rows = await db.select({
    monthKey: bountyMonthlySnapshotsTable.monthKey,
    actorId: bountyMonthlySnapshotsTable.approvedBy,
    memberCount: sql<number>`count(${bountyMonthlySnapshotMembersTable.userId})`,
    queuedAt: bountyMonthlySnapshotsTable.approvalAuditQueuedAt,
    scanBeforeId: bountyMonthlySnapshotsTable.approvalAuditScanBeforeId,
    channelId: bountyMonthlySnapshotsTable.approvalAuditChannelId,
  }).from(bountyMonthlySnapshotsTable)
    .leftJoin(bountyMonthlySnapshotMembersTable, and(
      eq(bountyMonthlySnapshotMembersTable.guildId, bountyMonthlySnapshotsTable.guildId),
      eq(bountyMonthlySnapshotMembersTable.monthKey, bountyMonthlySnapshotsTable.monthKey),
    ))
    .where(and(
      eq(bountyMonthlySnapshotsTable.guildId, guildId),
      eq(bountyMonthlySnapshotsTable.status, "approved"),
      isNotNull(bountyMonthlySnapshotsTable.approvalAuditQueuedAt),
      isNull(bountyMonthlySnapshotsTable.approvalAuditSentAt),
    ))
    .groupBy(
      bountyMonthlySnapshotsTable.guildId,
      bountyMonthlySnapshotsTable.monthKey,
      bountyMonthlySnapshotsTable.approvedBy,
      bountyMonthlySnapshotsTable.approvalAuditQueuedAt,
      bountyMonthlySnapshotsTable.approvalAuditScanBeforeId,
      bountyMonthlySnapshotsTable.approvalAuditChannelId,
    )
    .orderBy(asc(bountyMonthlySnapshotsTable.approvalAuditQueuedAt))
    .limit(limit);
  return rows.map((row) => {
    if (!row.actorId || !row.queuedAt) throw new Error(`承認月 ${row.monthKey} の監査情報が記録されていません。`);
    return {
      monthKey: row.monthKey, actorId: row.actorId, memberCount: row.memberCount,
      queuedAt: row.queuedAt, scanBeforeId: row.scanBeforeId, channelId: row.channelId,
    };
  });
}

/** Switch the reconciliation channel before scanning/sending there; discard the old channel's cursor. */
export async function setBountyMonthlyApprovalAuditChannel(
  guildId: string, monthKey: string, expectedChannelId: string | null, channelId: string,
): Promise<void> {
  validateBountyMonthKey(monthKey);
  assertText(channelId, "channelId");
  const [updated] = await db.update(bountyMonthlySnapshotsTable)
    .set({ approvalAuditChannelId: channelId, approvalAuditScanBeforeId: null })
    .where(and(
      eq(bountyMonthlySnapshotsTable.guildId, guildId),
      eq(bountyMonthlySnapshotsTable.monthKey, monthKey),
      eq(bountyMonthlySnapshotsTable.status, "approved"),
      isNotNull(bountyMonthlySnapshotsTable.approvalAuditQueuedAt),
      isNull(bountyMonthlySnapshotsTable.approvalAuditSentAt),
      expectedChannelId === null
        ? isNull(bountyMonthlySnapshotsTable.approvalAuditChannelId)
        : eq(bountyMonthlySnapshotsTable.approvalAuditChannelId, expectedChannelId),
    ))
    .returning({ monthKey: bountyMonthlySnapshotsTable.monthKey });
  if (!updated) throw new Error(`承認月 ${monthKey} の監査通知の送信先が変更されました。次回再確認します。`);
}

/** Save progress across restarts; clear it before sending so an ambiguous send is rescanned from newest. */
export async function setBountyMonthlyApprovalAuditScanCursor(
  guildId: string, monthKey: string, channelId: string, beforeId: string | null,
): Promise<void> {
  validateBountyMonthKey(monthKey);
  assertText(channelId, "channelId");
  if (beforeId !== null && !/^\d{17,20}$/.test(beforeId)) throw new Error("Discord message ID is invalid.");
  const [updated] = await db.update(bountyMonthlySnapshotsTable)
    .set({ approvalAuditScanBeforeId: beforeId })
    .where(and(
      eq(bountyMonthlySnapshotsTable.guildId, guildId),
      eq(bountyMonthlySnapshotsTable.monthKey, monthKey),
      eq(bountyMonthlySnapshotsTable.status, "approved"),
      isNotNull(bountyMonthlySnapshotsTable.approvalAuditQueuedAt),
      isNull(bountyMonthlySnapshotsTable.approvalAuditSentAt),
      eq(bountyMonthlySnapshotsTable.approvalAuditChannelId, channelId),
    ))
    .returning({ monthKey: bountyMonthlySnapshotsTable.monthKey });
  if (!updated) throw new Error(`承認月 ${monthKey} の送信待ち監査通知が見つかりません。`);
}

export async function markBountyMonthlyApprovalAuditSent(guildId: string, monthKey: string): Promise<void> {
  validateBountyMonthKey(monthKey);
  const [marked] = await db.update(bountyMonthlySnapshotsTable)
    .set({ approvalAuditSentAt: new Date() })
    .where(and(
      eq(bountyMonthlySnapshotsTable.guildId, guildId),
      eq(bountyMonthlySnapshotsTable.monthKey, monthKey),
      eq(bountyMonthlySnapshotsTable.status, "approved"),
      isNotNull(bountyMonthlySnapshotsTable.approvalAuditQueuedAt),
      isNull(bountyMonthlySnapshotsTable.approvalAuditSentAt),
    ))
    .returning({ monthKey: bountyMonthlySnapshotsTable.monthKey });
  if (marked) return;
  const [existing] = await db.select({
    sentAt: bountyMonthlySnapshotsTable.approvalAuditSentAt,
  }).from(bountyMonthlySnapshotsTable).where(and(
    eq(bountyMonthlySnapshotsTable.guildId, guildId),
    eq(bountyMonthlySnapshotsTable.monthKey, monthKey),
    eq(bountyMonthlySnapshotsTable.status, "approved"),
    isNotNull(bountyMonthlySnapshotsTable.approvalAuditQueuedAt),
  )).limit(1);
  if (!existing?.sentAt) throw new Error(`承認月 ${monthKey} の監査通知が見つかりません。`);
}

export async function getBountySettings(guildId: string) {
  const [settings] = await db
    .select()
    .from(bountySettingsTable)
    .where(eq(bountySettingsTable.guildId, guildId))
    .limit(1);
  return settings ?? null;
}

export async function setBountySettings(
  guildId: string,
  crewRoleId: string,
  logChannelId: string,
  tierRoleIds: string[],
) {
  assertText(guildId, "guildId");
  assertText(crewRoleId, "crewRoleId");
  assertText(logChannelId, "logChannelId");
  if (!Array.isArray(tierRoleIds) || tierRoleIds.some((id) => !id.trim())) {
    throw new Error("tierRoleIds must contain only non-empty role IDs.");
  }
  const [settings] = await db
    .insert(bountySettingsTable)
    .values({ guildId, crewRoleId, logChannelId, tierRoleIds })
    .onConflictDoUpdate({
      target: bountySettingsTable.guildId,
      set: { crewRoleId, logChannelId, tierRoleIds, updatedAt: new Date() },
    })
    .returning();
  return settings!;
}

export async function getBountyPoints(guildId: string, userId: string): Promise<number> {
  const [account] = await db
    .select({ points: bountyPointsTable.points })
    .from(bountyPointsTable)
    .where(and(
      eq(bountyPointsTable.guildId, guildId),
      eq(bountyPointsTable.userId, userId),
    ))
    .limit(1);
  return account?.points ?? 0;
}

export async function applyBountyPoints(
  guildId: string,
  userId: string,
  delta: number,
  reason: string,
  actorId?: string,
  dedupeKey?: string,
): Promise<{ before: number; after: number; applied: boolean }> {
  if (!Number.isSafeInteger(delta) || Math.abs(delta) > MAX_POINTS) {
    throw new Error("delta must be a safe 32-bit integer.");
  }
  assertText(guildId, "guildId");
  assertText(userId, "userId");
  assertText(reason, "reason");
  if (actorId !== undefined) assertText(actorId, "actorId");
  if (dedupeKey !== undefined) assertText(dedupeKey, "dedupeKey");

  return db.transaction(async (tx) => {
    await tx.insert(bountyPointsTable).values({ guildId, userId })
      .onConflictDoNothing();
    const [account] = await tx.select().from(bountyPointsTable)
      .where(and(
        eq(bountyPointsTable.guildId, guildId),
        eq(bountyPointsTable.userId, userId),
      ))
      .limit(1);
    if (!account) throw new Error("Could not lock bounty points account.");

    if (dedupeKey !== undefined) {
      const [existing] = await tx.select().from(bountyPointLedgerTable)
        .where(and(
          eq(bountyPointLedgerTable.guildId, guildId),
          eq(bountyPointLedgerTable.userId, userId),
          eq(bountyPointLedgerTable.dedupeKey, dedupeKey),
        ))
        .limit(1);
      if (existing) {
        return { before: existing.before, after: existing.after, applied: false };
      }
    }

    const after = account.points + delta;
    if (after < 0 || after > MAX_POINTS) {
      throw new Error("Bounty points would fall outside the supported range.");
    }
    await tx.update(bountyPointsTable)
      .set({ points: after, updatedAt: new Date() })
      .where(and(
        eq(bountyPointsTable.guildId, guildId),
        eq(bountyPointsTable.userId, userId),
      ));
    const [ledger] = await tx.insert(bountyPointLedgerTable).values({
      guildId, userId, delta, before: account.points, after, reason,
      actorId: actorId ?? null,
      dedupeKey: dedupeKey ?? null,
    }).returning({ id: bountyPointLedgerTable.id });
    if (actorId !== undefined) {
      if (!ledger) throw new Error("Could not create the bounty ledger row for its audit record.");
      const content =
        `懸賞金ポイント調整 #${ledger.id}\n対象: <@${userId}>\n` +
        `実行者: <@${actorId}>\n理由: ${reason}\n` +
        `変更: ${delta > 0 ? "+" : ""}${delta} pt\n` +
        `変更前: ${account.points} pt → 変更後: ${after} pt`;
      await tx.insert(bountyAuditOutboxTable).values({
        guildId,
        ledgerId: ledger.id,
        content,
      });
    }
    return { before: account.points, after, applied: true };
  });
}

export async function listPendingBountyAudits(
  guildId: string,
  limit = 100,
): Promise<Array<{ id: number; content: string }>> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("limit must be an integer between 1 and 1000.");
  }
  return db.select({
    id: bountyAuditOutboxTable.id,
    content: bountyAuditOutboxTable.content,
  })
    .from(bountyAuditOutboxTable)
    .where(and(
      eq(bountyAuditOutboxTable.guildId, guildId),
      isNull(bountyAuditOutboxTable.sentAt),
    ))
    .orderBy(asc(bountyAuditOutboxTable.id))
    .limit(limit);
}

export async function markBountyAuditSent(id: number): Promise<void> {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("id must be a positive integer.");
  const [marked] = await db.update(bountyAuditOutboxTable)
    .set({ sentAt: new Date() })
    .where(and(
      eq(bountyAuditOutboxTable.id, id),
      isNull(bountyAuditOutboxTable.sentAt),
    ))
    .returning({ id: bountyAuditOutboxTable.id });
  if (marked) return;
  const [existing] = await db.select({ id: bountyAuditOutboxTable.id })
    .from(bountyAuditOutboxTable)
    .where(eq(bountyAuditOutboxTable.id, id))
    .limit(1);
  if (!existing) throw new Error(`Bounty audit outbox item ${id} does not exist.`);
}

export async function listBountyAccountBalances(
  guildId: string,
): Promise<Array<{ userId: string; points: number }>> {
  return db.select({
    userId: bountyPointsTable.userId,
    points: bountyPointsTable.points,
  })
    .from(bountyPointsTable)
    .where(eq(bountyPointsTable.guildId, guildId))
    .orderBy(asc(bountyPointsTable.userId));
}

async function ensureAndLockAccount(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], guildId: string, userId: string) {
  await tx.insert(bountyPointsTable).values({ guildId, userId })
    .onConflictDoNothing();
  const [account] = await tx.select().from(bountyPointsTable)
    .where(and(
      eq(bountyPointsTable.guildId, guildId),
      eq(bountyPointsTable.userId, userId),
    ))
    .limit(1);
  if (!account) throw new Error("Could not lock bounty points account.");
  return account;
}

async function getVcRate(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  guildId: string,
  channelId: string,
): Promise<{ ratePerHour: number; effectiveAt: Date | null; progressChannelId: string }> {
  const [entry] = await tx.select({
    ratePerHour: bountyVcRatesTable.ratePerHour,
    effectiveAt: bountyVcRatesTable.effectiveAt,
  })
    .from(bountyVcRatesTable)
    .where(and(
      eq(bountyVcRatesTable.guildId, guildId),
      eq(bountyVcRatesTable.channelId, channelId),
    ))
    .limit(1);
  // An explicit destination rate (including zero) takes precedence.
  if (entry) return { ...entry, progressChannelId: channelId };

  const [hub] = await tx.select({ sourceChannelId: vcHubChannelsTable.hubChannelId })
    .from(vcHubSessionsTable)
    .innerJoin(vcHubChannelsTable, eq(vcHubSessionsTable.hubId, vcHubChannelsTable.id))
    .where(and(
      eq(vcHubSessionsTable.guildId, guildId),
      eq(vcHubSessionsTable.channelId, channelId),
      eq(vcHubChannelsTable.guildId, guildId),
    ))
    .limit(1);
  if (hub) {
    const [sourceRate] = await tx.select({
      ratePerHour: bountyVcRatesTable.ratePerHour,
      effectiveAt: bountyVcRatesTable.effectiveAt,
    }).from(bountyVcRatesTable).where(and(
      eq(bountyVcRatesTable.guildId, guildId),
      eq(bountyVcRatesTable.channelId, hub.sourceChannelId),
    )).limit(1);
    if (sourceRate) return { ...sourceRate, progressChannelId: hub.sourceChannelId };
  }
  return { ratePerHour: 0, effectiveAt: null, progressChannelId: channelId };
}

async function accruePresence(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  presence: typeof bountyVoicePresenceTable.$inferSelect,
  now: Date,
) {
  const elapsedSeconds = Math.floor((now.getTime() - presence.accruedAt.getTime()) / 1_000);
  if (elapsedSeconds <= 0) return null;

  let before: number | undefined;
  let after: number | undefined;
  if (presence.eligible && presence.channelId) {
    const rateConfig = await getVcRate(tx, presence.guildId, presence.channelId);
    // A zero rate disables accrual entirely; disabled time must not become
    // historical progress if a rate is configured later.
    if (rateConfig.ratePerHour > 0) {
      const effectiveStart = Math.max(
        presence.accruedAt.getTime(),
        rateConfig.effectiveAt?.getTime() ?? presence.accruedAt.getTime(),
      );
      const configuredElapsedSeconds = Math.floor((now.getTime() - effectiveStart) / 1_000);
      if (configuredElapsedSeconds > 0) {
        await tx.insert(bountyVcProgressTable).values({
          guildId: presence.guildId,
          userId: presence.userId,
          channelId: rateConfig.progressChannelId,
        }).onConflictDoNothing();
        const [progress] = await tx.select().from(bountyVcProgressTable)
          .where(and(
            eq(bountyVcProgressTable.guildId, presence.guildId),
            eq(bountyVcProgressTable.userId, presence.userId),
            eq(bountyVcProgressTable.channelId, rateConfig.progressChannelId),
          ))
          .limit(1);
        if (!progress) throw new Error("Could not lock bounty VC progress.");

        const totalSeconds = progress.accumulatedSeconds + configuredElapsedSeconds;
        const completedHours = Math.floor(totalSeconds / SECONDS_PER_HOUR);
        const remainderSeconds = totalSeconds % SECONDS_PER_HOUR;
        let pendingPointSeconds = progress.pendingPointSeconds;
        let pointRemainder = progress.pointRemainder;
        let delta = 0;
        if (completedHours > 0) {
          // All prior pending work belongs to the first completed hour; only
          // the newly elapsed seconds use the currently effective rate.
          const secondsCompletingHours =
            completedHours * SECONDS_PER_HOUR - progress.accumulatedSeconds;
          const completedPointSeconds =
            progress.pendingPointSeconds + rateConfig.ratePerHour * secondsCompletingHours;
          const creditedNumerator = progress.pointRemainder + completedPointSeconds;
          delta = Math.floor(creditedNumerator / SECONDS_PER_HOUR);
          pointRemainder = creditedNumerator % SECONDS_PER_HOUR;
          pendingPointSeconds = rateConfig.ratePerHour * remainderSeconds;
        } else {
          pendingPointSeconds += rateConfig.ratePerHour * configuredElapsedSeconds;
        }
        if (
          !Number.isSafeInteger(totalSeconds) ||
          !Number.isSafeInteger(pendingPointSeconds) ||
          !Number.isSafeInteger(delta) ||
          delta > MAX_POINTS
        ) {
          throw new Error("Bounty VC accrual exceeds the supported points range.");
        }
        await tx.update(bountyVcProgressTable)
          .set({ accumulatedSeconds: remainderSeconds, pendingPointSeconds, pointRemainder })
          .where(and(
            eq(bountyVcProgressTable.guildId, presence.guildId),
            eq(bountyVcProgressTable.userId, presence.userId),
            eq(bountyVcProgressTable.channelId, rateConfig.progressChannelId),
          ));
        if (delta > 0) {
          const account = await ensureAndLockAccount(tx, presence.guildId, presence.userId);
          before = account.points;
          after = before + delta;
          if (after > MAX_POINTS) {
            throw new Error("Bounty VC accrual exceeds the supported points range.");
          }
          await tx.update(bountyPointsTable)
            .set({ points: after, updatedAt: now })
            .where(and(
              eq(bountyPointsTable.guildId, presence.guildId),
              eq(bountyPointsTable.userId, presence.userId),
            ));
          await tx.insert(bountyPointLedgerTable).values({
            guildId: presence.guildId,
            userId: presence.userId,
            delta,
            before,
            after,
            reason: "VC bounty accrual",
          });
        }
      }
    }
  }
  const advancedTo = new Date(presence.accruedAt.getTime() + elapsedSeconds * 1_000);
  await tx.update(bountyVoicePresenceTable)
    .set({ accruedAt: advancedTo })
    .where(and(
      eq(bountyVoicePresenceTable.guildId, presence.guildId),
      eq(bountyVoicePresenceTable.userId, presence.userId),
    ));
  return before === undefined || after === undefined ? null : { userId: presence.userId, before, after };
}

async function accrueGuild(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], guildId: string, now: Date) {
  await lockBountyVoiceGuild(tx, guildId);
  const presences = await tx.select().from(bountyVoicePresenceTable)
    .where(eq(bountyVoicePresenceTable.guildId, guildId))
    ;
  const results = [];
  for (const presence of presences) {
    const result = await accruePresence(tx, presence, now);
    if (result && result.after > result.before) results.push(result);
  }
  return results;
}

export async function setBountyVcRate(
  guildId: string,
  channelId: string,
  ratePerHour: number,
  now = new Date(),
): Promise<Array<{ userId: string; before: number; after: number }>> {
  assertNonNegativeInteger(ratePerHour, "ratePerHour");
  assertText(guildId, "guildId");
  assertText(channelId, "channelId");
  return db.transaction(async (tx) => {
    // Advance all active presence against the old rates before changing any rate.
    const accrued = await accrueGuild(tx, guildId, now);
    await tx.insert(bountyVcRatesTable).values({ guildId, channelId, ratePerHour, effectiveAt: now })
      .onConflictDoUpdate({
        target: [bountyVcRatesTable.guildId, bountyVcRatesTable.channelId],
        set: { ratePerHour, effectiveAt: now },
      });
    return accrued;
  });
}

export async function listBountyVcRates(
  guildId: string,
): Promise<Array<{ channelId: string; ratePerHour: number }>> {
  return db.select({
    channelId: bountyVcRatesTable.channelId,
    ratePerHour: bountyVcRatesTable.ratePerHour,
  }).from(bountyVcRatesTable).where(eq(bountyVcRatesTable.guildId, guildId));
}

export async function recordBountyVoiceState(
  guildId: string,
  userId: string,
  channelId: string | null,
  eligible: boolean,
  now = new Date(),
): Promise<{ userId: string; before: number; after: number } | null> {
  assertText(guildId, "guildId");
  assertText(userId, "userId");
  if (channelId !== null) assertText(channelId, "channelId");
  return db.transaction(async (tx) => {
    await lockBountyVoiceGuild(tx, guildId);
    const [presence] = await tx.select().from(bountyVoicePresenceTable)
      .where(and(
        eq(bountyVoicePresenceTable.guildId, guildId),
        eq(bountyVoicePresenceTable.userId, userId),
      ))
      .limit(1);

    let accrued: { userId: string; before: number; after: number } | null = null;
    if (presence) accrued = await accruePresence(tx, presence, now);

    await tx.insert(bountyVoicePresenceTable).values({
      guildId,
      userId,
      channelId,
      eligible: Boolean(eligible && channelId),
      accruedAt: now,
    }).onConflictDoUpdate({
      target: [bountyVoicePresenceTable.guildId, bountyVoicePresenceTable.userId],
      set: { channelId, eligible: Boolean(eligible && channelId), accruedAt: now },
    });
    return accrued;
  });
}

export async function resetBountyVoicePresences(
  guildId: string,
  members: Map<string, { channelId: string; eligible: boolean }>,
  now = new Date(),
): Promise<void> {
  assertText(guildId, "guildId");
  for (const [userId, state] of members) {
    assertText(userId, "userId");
    assertText(state.channelId, "channelId");
  }
  await db.transaction(async (tx) => {
    await lockBountyVoiceGuild(tx, guildId);
    // Startup reconciliation intentionally does not accrue existing rows:
    // voice state was unobservable while the bot was offline.
    await tx.delete(bountyVoicePresenceTable)
      .where(eq(bountyVoicePresenceTable.guildId, guildId));
    if (members.size > 0) {
      await tx.insert(bountyVoicePresenceTable).values(
        [...members].map(([userId, state]) => ({
          guildId,
          userId,
          channelId: state.channelId,
          eligible: state.eligible,
          accruedAt: now,
        })),
      );
    }
  });
}

export async function accrueBountyVoiceForGuild(
  guildId: string,
  now = new Date(),
): Promise<Array<{ userId: string; before: number; after: number }>> {
  return db.transaction((tx) => accrueGuild(tx, guildId, now));
}

export async function setBountyMonthlyRate(
  guildId: string,
  roleId: string,
  points: number,
): Promise<void> {
  assertNonNegativeInteger(points, "points");
  assertText(guildId, "guildId");
  assertText(roleId, "roleId");
  await db.transaction(async (tx) => {
    await lockBountyMonthlyGuild(tx, guildId);
    const effectiveAt = new Date();
    const [current] = await tx.select().from(bountyMonthlyRatesTable)
      .where(and(
        eq(bountyMonthlyRatesTable.guildId, guildId),
        eq(bountyMonthlyRatesTable.roleId, roleId),
      ))
      .limit(1);
    const [history] = await tx.select({ id: bountyMonthlyRateHistoryTable.id })
      .from(bountyMonthlyRateHistoryTable)
      .where(and(
        eq(bountyMonthlyRateHistoryTable.guildId, guildId),
        eq(bountyMonthlyRateHistoryTable.roleId, roleId),
      ))
      .limit(1);
    // Preserve pre-history configurations when they are first changed after
    // this history mechanism is introduced.
    if (current && !history) {
      await tx.insert(bountyMonthlyRateHistoryTable).values({
        guildId,
        roleId,
        points: current.points,
        effectiveAt: current.effectiveAt,
      });
    }
    await tx.insert(bountyMonthlyRateHistoryTable).values({
      guildId,
      roleId,
      points,
      effectiveAt,
    });
    await tx.insert(bountyMonthlyRatesTable).values({ guildId, roleId, points, effectiveAt })
      .onConflictDoUpdate({
        target: [bountyMonthlyRatesTable.guildId, bountyMonthlyRatesTable.roleId],
        set: { points, effectiveAt },
      });
  });
}

export async function listBountyMonthlyRates(
  guildId: string,
): Promise<Array<{ roleId: string; points: number }>> {
  return db.select({
    roleId: bountyMonthlyRatesTable.roleId,
    points: bountyMonthlyRatesTable.points,
  }).from(bountyMonthlyRatesTable).where(eq(bountyMonthlyRatesTable.guildId, guildId));
}

export async function awardBountyMonth(
  guildId: string,
  monthKey: string,
): Promise<Array<{ userId: string; before: number; after: number; delta: number }>> {
  assertText(guildId, "guildId");
  validateBountyMonthKey(monthKey);
  return db.transaction(async (tx) => {
    await lockBountyMonthlyGuild(tx, guildId);
    const [snapshot] = await tx.select().from(bountyMonthlySnapshotsTable)
      .where(and(
        eq(bountyMonthlySnapshotsTable.guildId, guildId),
        eq(bountyMonthlySnapshotsTable.monthKey, monthKey),
      )).limit(1);
    if (!snapshot || (snapshot.status !== "captured" && snapshot.status !== "approved")) {
      throw new Error(`Monthly bounty payout ${monthKey} requires a captured or approved snapshot.`);
    }
    const [period] = await tx.insert(bountyMonthlyPayoutsTable)
      .values({ guildId, monthKey })
      .onConflictDoNothing()
      .returning({ monthKey: bountyMonthlyPayoutsTable.monthKey });
    // The marker is claimed before reading configuration. Concurrent attempts
    // serialize on its unique key; even an empty award set completes the period.
    if (!period) return [];

    const [settings] = await tx.select().from(bountySettingsTable)
      .where(eq(bountySettingsTable.guildId, guildId))
      .limit(1);
    if (!settings) throw new Error(`Bounty settings are not configured for guild ${guildId}.`);
    const cutoff = nextMonthJstCutoff(monthKey);
    if (settings.createdAt.getTime() >= cutoff.getTime()) {
      throw new Error(
        `Monthly bounty payout ${monthKey} skipped: guild bounty settings were created at or after the JST payout cutoff.`,
      );
    }
    const history = await tx.select().from(bountyMonthlyRateHistoryTable)
      .where(eq(bountyMonthlyRateHistoryTable.guildId, guildId))
      .orderBy(
        asc(bountyMonthlyRateHistoryTable.roleId),
        desc(bountyMonthlyRateHistoryTable.effectiveAt),
        desc(bountyMonthlyRateHistoryTable.id),
      );
    const rolesWithHistory = new Set<string>();
    const rates = new Map<string, number>();
    for (const version of history) {
      rolesWithHistory.add(version.roleId);
      if (
        version.effectiveAt.getTime() < cutoff.getTime() &&
        !rates.has(version.roleId)
      ) {
        rates.set(version.roleId, version.points);
      }
    }

    // Existing deployments may have current rows predating the history table.
    // Keep those only when their recorded effective time is safely before cutoff.
    const configuredRates = await tx.select({
      roleId: bountyMonthlyRatesTable.roleId,
      points: bountyMonthlyRatesTable.points,
      effectiveAt: bountyMonthlyRatesTable.effectiveAt,
    }).from(bountyMonthlyRatesTable)
      .where(eq(bountyMonthlyRatesTable.guildId, guildId));
    for (const rate of configuredRates) {
      if (
        !rolesWithHistory.has(rate.roleId) &&
        rate.effectiveAt.getTime() < cutoff.getTime()
      ) {
        rates.set(rate.roleId, rate.points);
      }
    }
    const awards: Array<{ userId: string; before: number; after: number; delta: number }> = [];
    const members = await tx.select().from(bountyMonthlySnapshotMembersTable)
      .where(and(
        eq(bountyMonthlySnapshotMembersTable.guildId, guildId),
        eq(bountyMonthlySnapshotMembersTable.monthKey, monthKey),
      )).orderBy(asc(bountyMonthlySnapshotMembersTable.userId));
    for (const { userId, roleIds } of members) {
      assertText(userId, "userId");
      if (!roleIds.includes(settings.crewRoleId)) continue;
      const delta = roleIds.reduce((sum, roleId) => sum + (rates.get(roleId) ?? 0), 0);
      if (delta <= 0) continue;
      if (!Number.isSafeInteger(delta) || delta > MAX_POINTS) {
        throw new Error(`Monthly bounty award for ${userId} exceeds the supported range.`);
      }
      const account = await ensureAndLockAccount(tx, guildId, userId);
      const dedupeKey = `monthly:${monthKey}:${userId}`;
      const after = account.points + delta;
      if (after > MAX_POINTS) throw new Error(`Monthly bounty award for ${userId} would overflow points.`);
      await tx.update(bountyPointsTable)
        .set({ points: after, updatedAt: new Date() })
        .where(and(
          eq(bountyPointsTable.guildId, guildId),
          eq(bountyPointsTable.userId, userId),
        ));
      await tx.insert(bountyPointLedgerTable).values({
        guildId,
        userId,
        delta,
        before: account.points,
        after,
        reason: `Monthly bounty payout ${monthKey}`,
        dedupeKey,
      });
      awards.push({ userId, before: account.points, after, delta });
    }
    return awards;
  });
}