import { after, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  accrueBountyVoiceForGuild,
  applyBountyPoints,
  awardBountyMonth,
  db,
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
import {
  bountyAuditOutboxTable,
  bountyMonthlyPayoutsTable,
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
  await db.delete(bountyMonthlyRateHistoryTable).where(eq(bountyMonthlyRateHistoryTable.guildId, guildId));
  await db.delete(bountyMonthlyRatesTable).where(eq(bountyMonthlyRatesTable.guildId, guildId));
  await db.delete(bountyAuditOutboxTable).where(eq(bountyAuditOutboxTable.guildId, guildId));
  await db.delete(bountyPointLedgerTable).where(eq(bountyPointLedgerTable.guildId, guildId));
  await db.delete(bountyVcProgressTable).where(eq(bountyVcProgressTable.guildId, guildId));
  await db.delete(bountyVoicePresenceTable).where(eq(bountyVoicePresenceTable.guildId, guildId));
  await db.delete(bountyVcRatesTable).where(eq(bountyVcRatesTable.guildId, guildId));
  await db.delete(bountyPointsTable).where(eq(bountyPointsTable.guildId, guildId));
  await db.delete(bountySettingsTable).where(eq(bountySettingsTable.guildId, guildId));
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

    assert.deepEqual(await awardBountyMonth(guildId, monthKey, new Map()), []);
    await setBountyMonthlyRate(guildId, "salary-role", 50);
    assert.deepEqual(
      await awardBountyMonth(guildId, monthKey, new Map([[userId, ["crew-role", "salary-role"]]])),
      [],
    );
    assert.equal(await getBountyPoints(guildId, userId), 0);

    const nextMonthDate = new Date(Date.UTC(futureMonth.getUTCFullYear(), futureMonth.getUTCMonth() + 1, 1));
    const nextMonthKey = `${nextMonthDate.getUTCFullYear()}-${String(nextMonthDate.getUTCMonth() + 1).padStart(2, "0")}`;
    const nextMonthMembers = new Map([[userId, ["crew-role", "salary-role"]]]);
    assert.equal((await awardBountyMonth(guildId, nextMonthKey, nextMonthMembers))[0]?.delta, 50);
    await setBountyMonthlyRate(guildId, "salary-role", 100);
    assert.deepEqual(await awardBountyMonth(guildId, nextMonthKey, nextMonthMembers), []);
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

    await assert.rejects(
      awardBountyMonth(guildId, monthKey, new Map([[userId, ["crew-role", "salary-role"]]])),
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
    assert.equal((await awardBountyMonth(
      guildId,
      monthKey,
      new Map([[userId, ["crew-role", "salary-role"]]]),
    ))[0]?.delta, 10);
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
    assert.equal((await awardBountyMonth(guildId, monthKey, members))[0]?.delta, 100);
    assert.deepEqual(await awardBountyMonth(guildId, monthKey, members), []);
    assert.equal(await getBountyPoints(guildId, userId), 100);
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