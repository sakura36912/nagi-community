import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  chinchiroTablePlayersTable, chinchiroTablesTable, db, transactionsTable, walletsTable,
} from "@workspace/db";
import { buildMultiplayerChinchiroPanel, calculateRoundResults } from "../commands/chinchiroMultiplayer";
import { evaluateChinchiroRoll } from "../commands/chinchiro";
import { refundOpenRound, reserveBet, settleRound } from "../lib/chinchiroMultiplayerMoney";

const guildIds: string[] = [];
const tableIds: number[] = [];
const id = () => `chinchiro-money-${randomUUID()}`;

async function makeTable(testMode = 0) {
  const guildId = id(), ownerId = id(), parentId = id(), child1 = id(), child2 = id();
  guildIds.push(guildId);
  const [table] = await db.insert(chinchiroTablesTable).values({
    guildId, ownerId, parentId, channelId: id(), currencyName: "円",
    status: "betting", testMode, expiresAt: new Date(Date.now() + 60_000),
  }).returning();
  tableIds.push(table!.id);
  await db.insert(chinchiroTablePlayersTable).values(
    [parentId, child1, child2].map((userId, index) => ({
      tableId: table!.id, userId, joinOrder: index + 1, displayName: userId,
    })),
  );
  for (const userId of [parentId, child1, child2, ownerId]) {
    await db.insert(walletsTable).values({ guildId, userId, balance: userId === ownerId ? 500 : 20_000 });
  }
  return { table: table!, guildId, ownerId, parentId, child1, child2 };
}

async function balance(guildId: string, userId: string) {
  const [wallet] = await db.select({ balance: walletsTable.balance }).from(walletsTable)
    .where(and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId)));
  return wallet!.balance;
}

async function setBet(tableId: number, userId: string, amount: number) {
  await db.transaction(async (tx) => {
    const [table] = await tx.select().from(chinchiroTablesTable)
      .where(eq(chinchiroTablesTable.id, tableId)).for("update");
    const participants = await tx.select().from(chinchiroTablePlayersTable)
      .where(eq(chinchiroTablePlayersTable.tableId, tableId));
    await reserveBet(tx, table!, participants.find((p) => p.userId === userId)!, amount, participants.length);
    await tx.update(chinchiroTablePlayersTable).set({ bet: amount })
      .where(and(eq(chinchiroTablePlayersTable.tableId, tableId), eq(chinchiroTablePlayersTable.userId, userId)));
  });
}

afterEach(async () => {
  if (guildIds.length) {
    await db.delete(transactionsTable).where(inArray(transactionsTable.guildId, guildIds));
    await db.delete(walletsTable).where(inArray(walletsTable.guildId, guildIds));
  }
  if (tableIds.length) {
    await db.delete(chinchiroTablePlayersTable).where(inArray(chinchiroTablePlayersTable.tableId, tableIds));
    await db.delete(chinchiroTablesTable).where(inArray(chinchiroTablesTable.id, tableIds));
  }
  guildIds.length = 0;
  tableIds.length = 0;
});

describe("multiplayer chinchiro live settlement", () => {
  it("reserves the worst-case loss, pays the original winner amounts and gives all losses to the table owner once", async () => {
    const { table, guildId, ownerId, parentId, child1, child2 } = await makeTable();
    for (const userId of [parentId, child1, child2]) await setBet(table.id, userId, 1000);
    expect(await balance(guildId, parentId)).toBe(10_000);
    expect(await balance(guildId, child1)).toBe(15_000);
    const rolls = [
      [parentId, [[2, 2, 5]]], [child1, [[1, 1, 3]]], [child2, [[1, 1, 1]]],
    ] as const;
    for (const [userId, attempts] of rolls) {
      await db.update(chinchiroTablePlayersTable)
        .set({ roll: JSON.stringify(evaluateChinchiroRoll(attempts.map((dice) => [...dice]))) })
        .where(and(eq(chinchiroTablePlayersTable.tableId, table.id), eq(chinchiroTablePlayersTable.userId, userId)));
    }
    await db.update(chinchiroTablesTable).set({ status: "rolling" }).where(eq(chinchiroTablesTable.id, table.id));
    const settle = () => db.transaction(async (tx) => {
      const [current] = await tx.select().from(chinchiroTablesTable)
        .where(eq(chinchiroTablesTable.id, table.id)).for("update");
      if (current?.status !== "rolling") return false;
      const ps = await tx.select().from(chinchiroTablePlayersTable)
        .where(eq(chinchiroTablePlayersTable.tableId, table.id));
      const result = calculateRoundResults(parentId, ps);
      expect(result.net).toEqual({ [parentId]: -4000, [child1]: -1000, [child2]: 5000 });
      await settleRound(tx, current, ps, result.net);
      await tx.update(chinchiroTablesTable).set({ status: "finished", results: JSON.stringify(result) })
        .where(eq(chinchiroTablesTable.id, table.id));
      return true;
    });
    expect((await Promise.all([settle(), settle()])).sort()).toEqual([false, true]);
    expect(await balance(guildId, parentId)).toBe(16_000);
    expect(await balance(guildId, child1)).toBe(19_000);
    expect(await balance(guildId, child2)).toBe(25_000);
    expect(await balance(guildId, ownerId)).toBe(5500);
    const [finished] = await db.select().from(chinchiroTablesTable).where(eq(chinchiroTablesTable.id, table.id));
    const ps = await db.select().from(chinchiroTablePlayersTable).where(eq(chinchiroTablePlayersTable.tableId, table.id));
    expect(buildMultiplayerChinchiroPanel(finished!, ps).toJSON().fields?.at(-1)).toMatchObject({
      name: "【ディーラーへの送金額】",
      value: `<@${ownerId}>：5,000 円`,
    });
    const dealerRows = await db.select().from(transactionsTable).where(and(
      eq(transactionsTable.guildId, guildId), eq(transactionsTable.userId, ownerId),
    ));
    expect(dealerRows).toMatchObject([{ amount: 5000, sessionKey: `chinchiro-mp:${table.id}:1:dealer` }]);
  });

  it("returns every reserved amount on cancellation, including after bet changes", async () => {
    const { table, guildId, parentId, child1 } = await makeTable();
    await setBet(table.id, parentId, 1000);
    await setBet(table.id, child1, 1000);
    await setBet(table.id, child1, 2000);
    await setBet(table.id, child1, 500);
    expect(await balance(guildId, child1)).toBe(17_500);
    const close = () => db.transaction(async (tx) => {
      const [current] = await tx.select().from(chinchiroTablesTable)
        .where(eq(chinchiroTablesTable.id, table.id)).for("update");
      if (current?.status === "closed") return;
      await refundOpenRound(tx, current!);
      await tx.update(chinchiroTablesTable).set({ status: "closed" })
        .where(eq(chinchiroTablesTable.id, table.id));
    });
    await Promise.all([close(), close()]);
    expect(await balance(guildId, parentId)).toBe(20_000);
    expect(await balance(guildId, child1)).toBe(20_000);
  });

  it("rolls back all payouts and the result when the dealer cannot receive losses", async () => {
    const { table, guildId, ownerId, parentId, child1, child2 } = await makeTable();
    for (const userId of [parentId, child1, child2]) await setBet(table.id, userId, 1000);
    await db.update(walletsTable).set({ balance: 2_147_483_647 }).where(and(
      eq(walletsTable.guildId, guildId), eq(walletsTable.userId, ownerId),
    ));
    await expect(db.transaction(async (tx) => {
      const [current] = await tx.select().from(chinchiroTablesTable).where(eq(chinchiroTablesTable.id, table.id)).for("update");
      const ps = await tx.select().from(chinchiroTablePlayersTable).where(eq(chinchiroTablePlayersTable.tableId, table.id));
      await settleRound(tx, current!, ps, { [parentId]: 1000, [child1]: -1000, [child2]: 0 });
      await tx.update(chinchiroTablesTable).set({ status: "finished" }).where(eq(chinchiroTablesTable.id, table.id));
    })).rejects.toThrow("上限");
    expect(await balance(guildId, parentId)).toBe(10_000);
    expect((await db.select().from(chinchiroTablesTable).where(eq(chinchiroTablesTable.id, table.id)))[0]?.status).toBe("betting");
    const credited = await db.select().from(transactionsTable).where(and(
      eq(transactionsTable.guildId, guildId), eq(transactionsTable.userId, ownerId),
    ));
    expect(credited).toHaveLength(0);
  });

  it("leaves test-mode wallets untouched", async () => {
    const { table, guildId, ownerId, parentId } = await makeTable(1);
    await setBet(table.id, parentId, 1000);
    await db.transaction(async (tx) => {
      await settleRound(tx, table, [], {});
      await refundOpenRound(tx, table);
    });
    expect(await balance(guildId, parentId)).toBe(20_000);
    expect(await balance(guildId, ownerId)).toBe(500);
  });
});