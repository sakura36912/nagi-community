import { after, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  addHubChannel,
  accrueBountyVoiceForGuild,
  applyBountyPoints,
  awardBountyMonth,
  captureBountyMonthSnapshot,
  holdBountyMonthForReview,
  addBountyMonthReviewMember,
  approveBountyMonthReview,
  commitBountyMonthReviewImport,
  getBountyMonthReview,
  listBountyMonthsNeedingAttention,
  listPendingBountyMonthlyApprovalAudits,
  markBountyMonthReviewNotified,
  markBountyMonthlyApprovalAuditSent,
  setBountyMonthlyApprovalAuditChannel,
  setBountyMonthlyApprovalAuditScanCursor,
  previewBountyMonthReviewImport,
  db,
  createHubSession,
  getBountyPoints,
  listBountyAccountBalances,
  listPendingBountyAudits,
  markBountyAuditSent,
  pool,
  recordBountyVoiceState,
  resetBountyVoicePresences,
  setBountyMonthlyRate,
  setBountySettings,
  setBountyVcRate,
} from "../src/index.js";
import { vcHubChannelsTable, vcHubSessionsTable } from "../src/schema/vcHub.js";
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
} from "../src/schema/bounty.js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required to run bounty database integration tests.");
}

const testGuilds: string[] = [];

async function createGuild() {
  const guildId = `bounty-test-${randomUUID()}`;
  testGuilds.push(guildId);
  return guildId;
}

async function cleanGuild(guildId: string) {
  await db.delete(bountyMonthlyPayoutsTable).where(eq(bountyMonthlyPayoutsTable.guildId, guildId));
  await db.delete(bountyMonthlySnapshotMembersTable).where(eq(bountyMonthlySnapshotMembersTable.guildId, guildId));
  await db.delete(bountyMonthlySnapshotsTable).where(eq(bountyMonthlySnapshotsTable.guildId, guildId));
  await db.delete(bountyMonthlyRateHistoryTable).where(eq(bountyMonthlyRateHistoryTable.guildId, guildId));
  await db.delete(bountyMonthlyRatesTable).where(eq(bountyMonthlyRatesTable.guildId, guildId));
  await db.delete(bountyAuditOutboxTable).where(eq(bountyAuditOutboxTable.guildId, guildId));
  await db.delete(bountyPointLedgerTable).where(eq(bountyPointLedgerTable.guildId, guildId));
  await db.delete(bountyVcProgressTable).where(eq(bountyVcProgressTable.guildId, guildId));
  await db.delete(bountyVoicePresenceTable).where(eq(bountyVoicePresenceTable.guildId, guildId));
  await db.delete(bountyVcRatesTable).where(eq(bountyVcRatesTable.guildId, guildId));
  await db.delete(bountyPointsTable).where(eq(bountyPointsTable.guildId, guildId));
  await db.delete(bountySettingsTable).where(eq(bountySettingsTable.guildId, guildId));
  await db.delete(vcHubSessionsTable).where(eq(vcHubSessionsTable.guildId, guildId));
  await db.delete(vcHubChannelsTable).where(eq(vcHubChannelsTable.guildId, guildId));
}

async function captureTestMonth(guildId: string, monthKey: string, members: Map<string, string[]>) {
  const [year, month] = monthKey.split("-").map(Number);
  const cutoff = new Date(Date.UTC(year!, month!, 1) - 9 * 60 * 60_000);
  return captureBountyMonthSnapshot(guildId, monthKey, members, cutoff);
}

async function pendingMonthlyApprovalSummaries(guildId: string) {
  const pending = await listPendingBountyMonthlyApprovalAudits(guildId);
  for (const audit of pending) assert.ok(audit.queuedAt instanceof Date);
  return pending.map(({
    queuedAt: _queuedAt, scanBeforeId: _scanBeforeId, channelId: _channelId, ...summary
  }) => summary);
}

describe("bounty points", () => {
  afterEach(async () => {
    for (const guildId of testGuilds.splice(0)) await cleanGuild(guildId);
  });

  after(async () => {
    await pool.end();
  });

  it("pays a whole-hour award across 30+30 minutes in the same VC", async () => {
    const guildId = await createGuild();
    const userId = `user-${randomUUID()}`;
    const channelId = `vc-${randomUUID()}`;
    const start = new Date("2026-01-01T00:00:00.000Z");
    await setBountyVcRate(guildId, channelId, 12, start);

    await recordBountyVoiceState(guildId, userId, channelId, true, start);
    await recordBountyVoiceState(guildId, userId, null, false, new Date(start.getTime() + 30 * 60_000));
    assert.equal(await getBountyPoints(guildId, userId), 0);

    await recordBountyVoiceState(
      guildId,
      userId,
      channelId,
      true,
      new Date(start.getTime() + 31 * 60_000),
    );
    await accrueBountyVoiceForGuild(guildId, new Date(start.getTime() + 61 * 60_000));
    assert.equal(await getBountyPoints(guildId, userId), 12);
  });

  it("keeps partial hours separate for each VC", async () => {
    const guildId = await createGuild();
    const userId = `user-${randomUUID()}`;
    const firstVc = `vc-${randomUUID()}`;
    const secondVc = `vc-${randomUUID()}`;
    const start = new Date("2026-01-02T00:00:00.000Z");
    await setBountyVcRate(guildId, firstVc, 7, start);
    await setBountyVcRate(guildId, secondVc, 99, start);

    await recordBountyVoiceState(guildId, userId, firstVc, true, start);
    await recordBountyVoiceState(guildId, userId, secondVc, true, new Date(start.getTime() + 30 * 60_000));
    await recordBountyVoiceState(guildId, userId, null, false, new Date(start.getTime() + 60 * 60_000));
    assert.equal(await getBountyPoints(guildId, userId), 0);

    await recordBountyVoiceState(guildId, userId, firstVc, true, new Date(start.getTime() + 61 * 60_000));
    await accrueBountyVoiceForGuild(guildId, new Date(start.getTime() + 91 * 60_000));
    assert.equal(await getBountyPoints(guildId, userId), 7);
  });

  it("inherits a Hub rate and combines time in the source and multiple transfer destinations", async () => {
    const guildId = await createGuild();
    const userId = `user-${randomUUID()}`;
    const source = `hub-${randomUUID()}`;
    const first = `child-${randomUUID()}`;
    const second = `child-${randomUUID()}`;
    const start = new Date("2026-01-06T00:00:00.000Z");
    const hub = await addHubChannel(guildId, source, null, "{user}のVC", null);
    await createHubSession(guildId, first, userId, hub.id);
    await createHubSession(guildId, second, userId, hub.id);
    await setBountyVcRate(guildId, source, 60, start);

    await recordBountyVoiceState(guildId, userId, source, true, start);
    await recordBountyVoiceState(guildId, userId, first, true, new Date(start.getTime() + 15 * 60_000));
    await recordBountyVoiceState(guildId, userId, second, true, new Date(start.getTime() + 45 * 60_000));
    await recordBountyVoiceState(guildId, userId, null, false, new Date(start.getTime() + 60 * 60_000));
    assert.equal(await getBountyPoints(guildId, userId), 60);
  });

  it("follows rate changes on a panel-only Hub while already in its transferred VC", async () => {
    const guildId = await createGuild();
    const userId = `user-${randomUUID()}`;
    const source = `hub-${randomUUID()}`;
    const child = `child-${randomUUID()}`;
    const start = new Date("2026-01-07T00:00:00.000Z");
    const hub = await addHubChannel(guildId, source, null, "{user}のVC", null, null, 1, true);
    await createHubSession(guildId, child, userId, hub.id);
    await setBountyVcRate(guildId, source, 60, start);

    await recordBountyVoiceState(guildId, userId, child, true, start);
    await setBountyVcRate(guildId, source, 120, new Date(start.getTime() + 30 * 60_000));
    await recordBountyVoiceState(guildId, userId, null, false, new Date(start.getTime() + 60 * 60_000));
    assert.equal(await getBountyPoints(guildId, userId), 90);
  });

  it("respects an explicit zero rate on the destination instead of inheriting from the Hub", async () => {
    const guildId = await createGuild();
    const userId = `user-${randomUUID()}`;
    const source = `hub-${randomUUID()}`;
    const child = `child-${randomUUID()}`;
    const start = new Date("2026-01-08T00:00:00.000Z");
    const hub = await addHubChannel(guildId, source, null, "{user}のVC", null);
    await createHubSession(guildId, child, userId, hub.id);
    await setBountyVcRate(guildId, source, 60, start);
    await setBountyVcRate(guildId, child, 0, start);
    await recordBountyVoiceState(guildId, userId, child, true, start);
    await accrueBountyVoiceForGuild(guildId, new Date(start.getTime() + 60 * 60_000));
    assert.equal(await getBountyPoints(guildId, userId), 0);
    await setBountyVcRate(guildId, child, 30, new Date(start.getTime() + 60 * 60_000));
    await recordBountyVoiceState(guildId, userId, null, false, new Date(start.getTime() + 120 * 60_000));
    assert.equal(await getBountyPoints(guildId, userId), 30);
  });

  it("starts an existing voice presence at the rate configuration time", async () => {
    const guildId = await createGuild();
    const userId = `user-${randomUUID()}`;
    const channelId = `vc-${randomUUID()}`;
    const start = new Date("2026-01-03T00:00:00.000Z");
    await recordBountyVoiceState(guildId, userId, channelId, true, start);
    const effectiveAt = new Date(start.getTime() + 30 * 60_000);
    await setBountyVcRate(guildId, channelId, 9, effectiveAt);

    await accrueBountyVoiceForGuild(guildId, new Date(start.getTime() + 60 * 60_000));
    assert.equal(await getBountyPoints(guildId, userId), 0);
    await accrueBountyVoiceForGuild(guildId, new Date(start.getTime() + 90 * 60_000));
    assert.equal(await getBountyPoints(guildId, userId), 9);
  });

  it("weights each completed hour using the rates active during its minutes", async () => {
    const guildId = await createGuild();
    const userId = `user-${randomUUID()}`;
    const channelId = `vc-${randomUUID()}`;
    const start = new Date("2026-01-04T00:00:00.000Z");
    await setBountyVcRate(guildId, channelId, 100, start);
    await recordBountyVoiceState(guildId, userId, channelId, true, start);

    const rateChangeAt = new Date(start.getTime() + 30 * 60_000);
    await setBountyVcRate(guildId, channelId, 200, rateChangeAt);
    await accrueBountyVoiceForGuild(guildId, new Date(start.getTime() + 60 * 60_000));
    assert.equal(await getBountyPoints(guildId, userId), 150);
  });

  it("reconciles startup voice state without crediting offline time", async () => {
    const guildId = await createGuild();
    const connectedUser = `user-${randomUUID()}`;
    const departedUser = `user-${randomUUID()}`;
    const channelId = `vc-${randomUUID()}`;
    const start = new Date("2026-01-05T00:00:00.000Z");
    await setBountyVcRate(guildId, channelId, 100, start);
    await recordBountyVoiceState(guildId, connectedUser, channelId, true, start);
    await recordBountyVoiceState(guildId, departedUser, channelId, true, start);

    const restartAt = new Date(start.getTime() + 5 * 60 * 60_000);
    await resetBountyVoicePresences(
      guildId,
      new Map([[connectedUser, { channelId, eligible: true }]]),
      restartAt,
    );
    await accrueBountyVoiceForGuild(guildId, new Date(restartAt.getTime() + 60 * 60_000));
    assert.equal(await getBountyPoints(guildId, connectedUser), 100);
    assert.equal(await getBountyPoints(guildId, departedUser), 0);
  });

  it("completes payout periods on empty runs and ignores later retries/rate changes", async () => {
    const guildId = await createGuild();
    const userId = `user-${randomUUID()}`;
    await setBountySettings(guildId, "crew-role", "log-channel", []);
    await setBountyMonthlyRate(guildId, "salary-role", 10);
    const futureMonth = new Date();
    futureMonth.setUTCFullYear(futureMonth.getUTCFullYear() + 2);
    const monthKey = `${futureMonth.getUTCFullYear()}-${String(futureMonth.getUTCMonth() + 1).padStart(2, "0")}`;

    assert.equal(await captureTestMonth(guildId, monthKey, new Map()), true);
    assert.deepEqual(await awardBountyMonth(guildId, monthKey), []);
    await setBountyMonthlyRate(guildId, "salary-role", 50);
    assert.deepEqual(
      await awardBountyMonth(guildId, monthKey),
      [],
    );
    assert.equal(await getBountyPoints(guildId, userId), 0);

    const nextMonthDate = new Date(Date.UTC(futureMonth.getUTCFullYear(), futureMonth.getUTCMonth() + 1, 1));
    const nextMonthKey = `${nextMonthDate.getUTCFullYear()}-${String(nextMonthDate.getUTCMonth() + 1).padStart(2, "0")}`;
    const nextMonthMembers = new Map([[userId, ["crew-role", "salary-role"]]]);
    await captureTestMonth(guildId, nextMonthKey, nextMonthMembers);
    assert.equal((await awardBountyMonth(guildId, nextMonthKey))[0]?.delta, 50);
    await setBountyMonthlyRate(guildId, "salary-role", 100);
    assert.deepEqual(await awardBountyMonth(guildId, nextMonthKey), []);
    assert.equal(await getBountyPoints(guildId, userId), 50);
  });

  it("does not claim a historical period when setup was created after its cutoff", async () => {
    const guildId = await createGuild();
    const userId = `user-${randomUUID()}`;
    await setBountySettings(guildId, "crew-role", "log-channel", []);
    const now = new Date();
    const oldMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1));
    const monthKey = `${oldMonth.getUTCFullYear()}-${String(oldMonth.getUTCMonth() + 1).padStart(2, "0")}`;
    const [year, month] = monthKey.split("-").map(Number);
    const cutoff = new Date(Date.UTC(year!, month!, 1) - 9 * 60 * 60_000);

    await captureTestMonth(guildId, monthKey, new Map([[userId, ["crew-role", "salary-role"]]]));
    await assert.rejects(
      awardBountyMonth(guildId, monthKey),
      /settings were created at or after the JST payout cutoff/,
    );
    assert.equal(await getBountyPoints(guildId, userId), 0);

    await setBountyMonthlyRate(guildId, "salary-role", 10);
    await db.update(bountySettingsTable)
      .set({ createdAt: new Date(cutoff.getTime() - 1_000) })
      .where(eq(bountySettingsTable.guildId, guildId));
    await db.insert(bountyMonthlyRateHistoryTable).values({
      guildId,
      roleId: "salary-role",
      points: 10,
      effectiveAt: new Date(cutoff.getTime() - 1_000),
    });
    assert.equal((await awardBountyMonth(guildId, monthKey))[0]?.delta, 10);
  });

  it("uses the latest pre-cutoff rate for overdue payouts and excludes later roles", async () => {
    const guildId = await createGuild();
    const userId = `user-${randomUUID()}`;
    await setBountySettings(guildId, "crew-role", "log-channel", []);
    const now = new Date();
    const oldMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1));
    const monthKey = `${oldMonth.getUTCFullYear()}-${String(oldMonth.getUTCMonth() + 1).padStart(2, "0")}`;
    const [year, month] = monthKey.split("-").map(Number);
    const cutoff = new Date(Date.UTC(year!, month!, 1) - 9 * 60 * 60_000);
    await db.update(bountySettingsTable)
      .set({ createdAt: new Date(cutoff.getTime() - 1_000) })
      .where(eq(bountySettingsTable.guildId, guildId));

    await setBountyMonthlyRate(guildId, "salary-role", 100);
    const [initialVersion] = await db.select({ id: bountyMonthlyRateHistoryTable.id })
      .from(bountyMonthlyRateHistoryTable)
      .where(eq(bountyMonthlyRateHistoryTable.guildId, guildId));
    assert.ok(initialVersion);
    await db.update(bountyMonthlyRateHistoryTable)
      .set({ effectiveAt: new Date(cutoff.getTime() - 1_000) })
      .where(eq(bountyMonthlyRateHistoryTable.id, initialVersion.id));
    await db.update(bountyMonthlyRatesTable)
      .set({ effectiveAt: new Date(cutoff.getTime() - 1_000) })
      .where(eq(bountyMonthlyRatesTable.guildId, guildId));

    await setBountyMonthlyRate(guildId, "salary-role", 200);
    await setBountyMonthlyRate(guildId, "late-role", 300);
    const members = new Map([[userId, ["crew-role", "salary-role", "late-role"]]]);
    await captureTestMonth(guildId, monthKey, members);
    assert.equal((await awardBountyMonth(guildId, monthKey))[0]?.delta, 100);
    assert.deepEqual(await awardBountyMonth(guildId, monthKey), []);
    assert.equal(await getBountyPoints(guildId, userId), 100);
  });

  it("holds an unobserved cutoff until staff approve only the verified roster", async () => {
    const guildId = await createGuild();
    const approvedUser = `user-${randomUUID()}`;
    const unapprovedUser = `user-${randomUUID()}`;
    await setBountySettings(guildId, "crew-role", "log-channel", []);
    await setBountyMonthlyRate(guildId, "salary-role", 35);
    const now = new Date();
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1));
    const monthKey = month.toISOString().slice(0, 7);
    const cutoff = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1) - 9 * 60 * 60_000);
    await db.update(bountySettingsTable)
      .set({ createdAt: new Date(cutoff.getTime() - 1_000) })
      .where(eq(bountySettingsTable.guildId, guildId));
    await db.update(bountyMonthlyRateHistoryTable)
      .set({ effectiveAt: new Date(cutoff.getTime() - 1_000) })
      .where(eq(bountyMonthlyRateHistoryTable.guildId, guildId));
    await db.update(bountyMonthlyRatesTable)
      .set({ effectiveAt: new Date(cutoff.getTime() - 1_000) })
      .where(eq(bountyMonthlyRatesTable.guildId, guildId));

    await assert.rejects(awardBountyMonth(guildId, monthKey), /requires a captured or approved snapshot/);
    await holdBountyMonthForReview(guildId, monthKey);
    await assert.rejects(awardBountyMonth(guildId, monthKey), /requires a captured or approved snapshot/);
    assert.deepEqual(await listBountyMonthsNeedingAttention(guildId), [monthKey]);
    await markBountyMonthReviewNotified(guildId, monthKey);
    assert.deepEqual(await listBountyMonthsNeedingAttention(guildId), []);
    await assert.rejects(
      captureBountyMonthSnapshot(guildId, monthKey, new Map(), new Date(cutoff.getTime() + 60_000)),
      /not taken at the JST cutoff/,
    );
    await assert.rejects(
      addBountyMonthReviewMember(guildId, monthKey, unapprovedUser, "unknown-role"),
      /有効な月次付与ポイント/,
    );
    await addBountyMonthReviewMember(guildId, monthKey, approvedUser, "salary-role");
    const roster = (await getBountyMonthReview(guildId, monthKey)).members;
    assert.equal(roster.length, 1);
    assert.deepEqual(roster[0]?.roleIds, ["crew-role", "salary-role"]);
    await assert.rejects(
      approveBountyMonthReview(guildId, monthKey, "staff-id", []),
      /対象者が変更/,
    );
    await approveBountyMonthReview(guildId, monthKey, "staff-id", roster);
    assert.deepEqual(await pendingMonthlyApprovalSummaries(guildId), [
      { monthKey, actorId: "staff-id", memberCount: 1 },
    ]);
    assert.deepEqual(await listBountyMonthsNeedingAttention(guildId), [monthKey]);
    await assert.rejects(
      addBountyMonthReviewMember(guildId, monthKey, unapprovedUser, "salary-role"),
      /確認待ちではありません/,
    );
    assert.equal((await awardBountyMonth(guildId, monthKey))[0]?.delta, 35);
    assert.deepEqual(await awardBountyMonth(guildId, monthKey), []);
    assert.equal(await getBountyPoints(guildId, approvedUser), 35);
    assert.equal(await getBountyPoints(guildId, unapprovedUser), 0);
    assert.equal((await getBountyMonthReview(guildId, monthKey)).paid, true);
    assert.deepEqual(await pendingMonthlyApprovalSummaries(guildId), [
      { monthKey, actorId: "staff-id", memberCount: 1 },
    ]);
    await markBountyMonthlyApprovalAuditSent(guildId, monthKey);
    await markBountyMonthlyApprovalAuditSent(guildId, monthKey);
    assert.deepEqual(await listPendingBountyMonthlyApprovalAudits(guildId), []);
    assert.deepEqual(await listBountyMonthsNeedingAttention(guildId), []);
  });

  it("queues zero-member approval atomically, without replaying old approvals or repeating payouts", async () => {
    const guildId = await createGuild();
    const monthKey = "2025-06", oldMonth = "2025-05";
    await setBountySettings(guildId, "crew-role", "log-channel", []);
    await db.update(bountySettingsTable).set({ createdAt: new Date("2025-01-01") })
      .where(eq(bountySettingsTable.guildId, guildId));
    await holdBountyMonthForReview(guildId, monthKey);
    await holdBountyMonthForReview(guildId, oldMonth);
    await db.update(bountyMonthlySnapshotsTable)
      .set({ status: "approved", approvedBy: "old-staff" })
      .where(eq(bountyMonthlySnapshotsTable.monthKey, oldMonth));
    assert.deepEqual(await listPendingBountyMonthlyApprovalAudits(guildId), []);
    await approveBountyMonthReview(guildId, monthKey, "new-staff", []);
    await assert.rejects(approveBountyMonthReview(guildId, monthKey, "new-staff", []), /確認待ち/);
    assert.deepEqual(await pendingMonthlyApprovalSummaries(guildId), [
      { monthKey, actorId: "new-staff", memberCount: 0 },
    ]);
    await assert.rejects(
      setBountyMonthlyApprovalAuditScanCursor(guildId, monthKey, "log-channel", "invalid"),
      /message ID is invalid/,
    );
    assert.equal((await listPendingBountyMonthlyApprovalAudits(guildId))[0]?.channelId, "log-channel");
    await setBountyMonthlyApprovalAuditScanCursor(guildId, monthKey, "log-channel", "123456789012345678");
    assert.equal((await listPendingBountyMonthlyApprovalAudits(guildId))[0]?.scanBeforeId, "123456789012345678");
    await assert.rejects(
      setBountyMonthlyApprovalAuditScanCursor(guildId, monthKey, "wrong-channel", null),
      /送信待ち監査通知/,
    );
    await setBountyMonthlyApprovalAuditChannel(guildId, monthKey, "log-channel", "new-audit");
    assert.equal((await listPendingBountyMonthlyApprovalAudits(guildId))[0]?.scanBeforeId, null);
    assert.equal((await listPendingBountyMonthlyApprovalAudits(guildId))[0]?.channelId, "new-audit");
    await assert.rejects(
      setBountyMonthlyApprovalAuditChannel(guildId, monthKey, "log-channel", "another-audit"),
      /送信先が変更/,
    );
    assert.deepEqual(await awardBountyMonth(guildId, monthKey), []);
    assert.deepEqual(await awardBountyMonth(guildId, monthKey), []);
    assert.deepEqual(await pendingMonthlyApprovalSummaries(guildId), [
      { monthKey, actorId: "new-staff", memberCount: 0 },
    ]);
    await markBountyMonthlyApprovalAuditSent(guildId, monthKey);
    assert.deepEqual(await listPendingBountyMonthlyApprovalAudits(guildId), []);
  });

  it("previews CSV changes and atomically imports only verified users before one-time approval", async () => {
    const guildId = await createGuild();
    const monthKey = "2025-08";
    const first = "123456789012345678", second = "123456789012345679", retained = "123456789012345680";
    const role = "223456789012345678", otherRole = "223456789012345679";
    const crew = "323456789012345678";
    await setBountySettings(guildId, crew, "log-channel", []);
    await db.update(bountySettingsTable).set({ createdAt: new Date("2025-01-01") })
      .where(eq(bountySettingsTable.guildId, guildId));
    await db.insert(bountyMonthlyRateHistoryTable).values([
      { guildId, roleId: role, points: 35, effectiveAt: new Date("2025-01-01") },
      { guildId, roleId: otherRole, points: 10, effectiveAt: new Date("2025-01-01") },
    ]);
    await holdBountyMonthForReview(guildId, monthKey);
    await addBountyMonthReviewMember(guildId, monthKey, retained, role);
    await addBountyMonthReviewMember(guildId, monthKey, first, role);
    const rows = [
      { userId: first, roleIds: [otherRole] },
      { userId: second, roleIds: [role, otherRole] },
    ];
    await assert.rejects(previewBountyMonthReviewImport(guildId, monthKey, [
      { userId: first, roleIds: ["999999999999999999"] },
    ]), /未設定/);
    await assert.rejects(previewBountyMonthReviewImport(guildId, monthKey, [rows[0]!, rows[0]!]), /重複/);
    const preview = await previewBountyMonthReviewImport(guildId, monthKey, rows);
    assert.equal(preview.changes.length, 2);
    assert.deepEqual(preview.changes[0]?.before, [crew, role]);
    assert.deepEqual(preview.changes[0]?.after, [otherRole, crew].sort());
    assert.equal((await getBountyMonthReview(guildId, monthKey)).members.length, 2);
    await addBountyMonthReviewMember(guildId, monthKey, retained, otherRole);
    await assert.rejects(commitBountyMonthReviewImport(guildId, monthKey, rows, preview), /一覧が変更/);
    const updatedPreview = await previewBountyMonthReviewImport(guildId, monthKey, rows);
    await commitBountyMonthReviewImport(guildId, monthKey, rows, updatedPreview);
    assert.equal((await getBountyMonthReview(guildId, monthKey)).members.length, 3);
    const same = await previewBountyMonthReviewImport(guildId, monthKey, rows);
    assert.deepEqual(same.changes, []);
    const roster = (await getBountyMonthReview(guildId, monthKey)).members;
    await approveBountyMonthReview(guildId, monthKey, "staff-id", roster);
    await assert.rejects(previewBountyMonthReviewImport(guildId, monthKey, rows), /確認待ち/);
    assert.equal((await awardBountyMonth(guildId, monthKey)).length, 3);
    assert.deepEqual(await awardBountyMonth(guildId, monthKey), []);
    assert.equal(await getBountyPoints(guildId, first), 10);
    assert.equal(await getBountyPoints(guildId, second), 45);
  });

  it("pays the frozen boundary roster, not a later change to member roles", async () => {
    const guildId = await createGuild();
    const wasEligible = `user-${randomUUID()}`;
    const becameEligibleLater = `user-${randomUUID()}`;
    await setBountySettings(guildId, "crew-role", "log-channel", []);
    await setBountyMonthlyRate(guildId, "salary-role", 22);
    const future = new Date();
    future.setUTCFullYear(future.getUTCFullYear() + 2);
    const monthKey = future.toISOString().slice(0, 7);
    const cutoffRoles = new Map([
      [wasEligible, ["crew-role", "salary-role"]],
      [becameEligibleLater, ["salary-role"]],
    ]);
    assert.equal(await captureTestMonth(guildId, monthKey, cutoffRoles), true);
    cutoffRoles.set(wasEligible, []);
    cutoffRoles.set(becameEligibleLater, ["crew-role", "salary-role"]);
    assert.equal(await captureTestMonth(guildId, monthKey, cutoffRoles), false);
    assert.deepEqual((await awardBountyMonth(guildId, monthKey)).map(({ userId }) => userId), [wasEligible]);
    assert.equal(await getBountyPoints(guildId, wasEligible), 22);
    assert.equal(await getBountyPoints(guildId, becameEligibleLater), 0);
  });

  it("writes manual point audits atomically and does not duplicate them on retry", async () => {
    const guildId = await createGuild();
    const userId = `user-${randomUUID()}`;
    const actorId = `actor-${randomUUID()}`;
    const dedupeKey = `audit-${randomUUID()}`;
    const first = await applyBountyPoints(guildId, userId, 17, "adjustment reason", actorId, dedupeKey);
    assert.equal(first.applied, true);
    assert.equal(first.before, 0);
    assert.equal(first.after, 17);
    const pending = await listPendingBountyAudits(guildId);
    assert.equal(pending.length, 1);
    assert.match(pending[0]!.content, /懸賞金ポイント調整 #\d+/);
    assert.match(pending[0]!.content, new RegExp(actorId));
    assert.match(pending[0]!.content, new RegExp(userId));
    assert.match(pending[0]!.content, /理由: adjustment reason/);
    assert.match(pending[0]!.content, /変更前: 0 pt → 変更後: 17 pt/);

    const replay = await applyBountyPoints(guildId, userId, 17, "adjustment reason", actorId, dedupeKey);
    assert.equal(replay.applied, false);
    assert.equal((await listPendingBountyAudits(guildId)).length, 1);
    assert.deepEqual(await listBountyAccountBalances(guildId), [{ userId, points: 17 }]);

    await markBountyAuditSent(pending[0]!.id);
    await markBountyAuditSent(pending[0]!.id);
    assert.deepEqual(await listPendingBountyAudits(guildId), []);
  });
});