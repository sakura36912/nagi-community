import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  db, pool, walletsTable, transactionsTable, uraRecruitmentsTable, uraMatchesTable, uraReportsTable,
  createPaidUraRecruitment, cancelAndRefundUraRecruitment, createUraMatch,
  listUraMatchesReadyForDeletion, listUraMatchesForGuildBefore, removeUraMatch, URA_RECRUITMENT_FEE,
} from "@workspace/db";

const guildId = `test-ura-${randomUUID()}`;
const ownerId = `test-user-${randomUUID()}`;
const values = { guildId, recruitmentChannelId: "test-text", ownerId, type: "talk" as const, note: "test" };

afterEach(async () => {
  await db.delete(uraReportsTable).where(eq(uraReportsTable.guildId, guildId));
  await db.delete(uraMatchesTable).where(eq(uraMatchesTable.guildId, guildId));
  await db.delete(uraRecruitmentsTable).where(eq(uraRecruitmentsTable.guildId, guildId));
  await db.delete(transactionsTable).where(eq(transactionsTable.guildId, guildId));
  await db.delete(walletsTable).where(eq(walletsTable.guildId, guildId));
});
afterAll(() => pool.end());

describe("裏航海の募集料金", () => {
  it("残高不足では募集も請求も作らない", async () => {
    const result = await createPaidUraRecruitment(values);
    expect(result.status).toBe("insufficient");
    expect(await db.select().from(uraRecruitmentsTable).where(eq(uraRecruitmentsTable.guildId, guildId))).toHaveLength(0);
    expect(await db.select().from(transactionsTable).where(eq(transactionsTable.guildId, guildId))).toHaveLength(0);
  });

  it("同時募集でも一度だけ引き落とし、投稿失敗の返金も一度だけ", async () => {
    await db.insert(walletsTable).values({ guildId, userId: ownerId, balance: URA_RECRUITMENT_FEE * 2 });
    const results = await Promise.all([createPaidUraRecruitment(values), createPaidUraRecruitment(values)]);
    expect(results.map((r) => r.status).sort()).toEqual(["already_open", "created"]);
    const created = results.find((r) => r.status === "created");
    if (!created || created.status !== "created") throw new Error("Recruitment not created");
    expect((await db.select().from(walletsTable).where(eq(walletsTable.guildId, guildId)))[0]?.balance).toBe(URA_RECRUITMENT_FEE);
    expect(await cancelAndRefundUraRecruitment(created.recruitment.id)).toBe(true);
    expect(await cancelAndRefundUraRecruitment(created.recruitment.id)).toBe(false);
    expect((await db.select().from(walletsTable).where(eq(walletsTable.guildId, guildId)))[0]?.balance).toBe(URA_RECRUITMENT_FEE * 2);
    expect((await db.select().from(transactionsTable).where(eq(transactionsTable.guildId, guildId)).orderBy(transactionsTable.id)).map((t) => t.amount))
      .toEqual([-URA_RECRUITMENT_FEE, URA_RECRUITMENT_FEE]);
  });

  it("VCは退出直後でなく作成24時間後に削除対象になる", async () => {
    const [recruitment] = await db.insert(uraRecruitmentsTable).values(values).returning();
    const match = await createUraMatch({
      guildId, recruitmentId: recruitment.id, hostId: ownerId, guestId: "test-guest", channelId: `test-vc-${randomUUID()}`,
    });
    expect((await listUraMatchesReadyForDeletion(new Date(Date.now() + 23 * 60 * 60 * 1000))).some((row) => row.id === match.id)).toBe(false);
    expect((await listUraMatchesReadyForDeletion(new Date(Date.now() + 25 * 60 * 60 * 1000))).some((row) => row.id === match.id)).toBe(true);
  });

  it("マッチ削除では関連通報も消し、募集履歴のVC参照を解除する", async () => {
    const [recruitment] = await db.insert(uraRecruitmentsTable).values(values).returning();
    const match = await createUraMatch({
      guildId, recruitmentId: recruitment.id, hostId: ownerId, guestId: "test-guest", channelId: `test-vc-${randomUUID()}`,
    });
    await db.insert(uraReportsTable).values({
      guildId, matchId: match.id, reporterId: ownerId, reportedId: "test-guest",
      reason: "test", details: "test",
    });
    expect((await listUraMatchesForGuildBefore(guildId, new Date(Date.now() + 1000))).map((row) => row.id)).toContain(match.id);
    expect(await removeUraMatch(guildId, match.id)).toBe(true);
    expect(await removeUraMatch(guildId, match.id)).toBe(false);
    expect(await db.select().from(uraMatchesTable).where(eq(uraMatchesTable.id, match.id))).toHaveLength(0);
    expect(await db.select().from(uraReportsTable).where(eq(uraReportsTable.matchId, match.id))).toHaveLength(0);
    expect((await db.select().from(uraRecruitmentsTable).where(eq(uraRecruitmentsTable.id, recruitment.id)))[0]?.vcChannelId).toBeNull();
  });
});