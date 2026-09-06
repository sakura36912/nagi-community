import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { chinchiroGamesTable, db, walletsTable } from "@workspace/db";
import { refundExpiredChinchiroGames } from "../commands/chinchiro";

const guildId = `test-chinchiro-${randomUUID()}`;
const challengerId = `challenger-${randomUUID()}`;
const opponentId = `opponent-${randomUUID()}`;

async function balances(): Promise<Map<string, number>> {
  const rows = await db
    .select({ userId: walletsTable.userId, balance: walletsTable.balance })
    .from(walletsTable)
    .where(and(
      eq(walletsTable.guildId, guildId),
      inArray(walletsTable.userId, [challengerId, opponentId]),
    ));
  return new Map(rows.map((row) => [row.userId, row.balance]));
}

beforeEach(async () => {
  await db.delete(chinchiroGamesTable).where(eq(chinchiroGamesTable.guildId, guildId));
  await db.delete(walletsTable).where(eq(walletsTable.guildId, guildId));
  await db.insert(walletsTable).values([
    { guildId, userId: challengerId, balance: 9_000 },
    { guildId, userId: opponentId, balance: 9_000 },
  ]);
});

afterAll(async () => {
  await db.delete(chinchiroGamesTable).where(eq(chinchiroGamesTable.guildId, guildId));
  await db.delete(walletsTable).where(eq(walletsTable.guildId, guildId));
});

describe("対人チンチロの期限切れ返金", () => {
  it("承認済み対戦では両者へ賭け金を1回だけ返金する", async () => {
    await db.insert(chinchiroGamesTable).values({
      guildId,
      channelId: "channel",
      challengerId,
      opponentId,
      bet: 1_000,
      currencyName: "$",
      status: "active",
      expiresAt: new Date(Date.now() - 1_000),
    });

    expect(await refundExpiredChinchiroGames()).toBe(1);
    expect(await balances()).toEqual(new Map([
      [challengerId, 10_000],
      [opponentId, 10_000],
    ]));

    expect(await refundExpiredChinchiroGames()).toBe(0);
    expect(await balances()).toEqual(new Map([
      [challengerId, 10_000],
      [opponentId, 10_000],
    ]));
  });

  it("未承認の挑戦では預け済みの挑戦者だけへ返金する", async () => {
    await db.insert(chinchiroGamesTable).values({
      guildId,
      channelId: "channel",
      challengerId,
      opponentId,
      bet: 1_000,
      currencyName: "$",
      status: "pending",
      expiresAt: new Date(Date.now() - 1_000),
    });

    expect(await refundExpiredChinchiroGames()).toBe(1);
    expect(await balances()).toEqual(new Map([
      [challengerId, 10_000],
      [opponentId, 9_000],
    ]));
  });
});