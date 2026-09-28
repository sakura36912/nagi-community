import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  cancelDealerCasinoGame,
  createDealerCasinoGame,
  db,
  dealerCasinoBetsTable,
  dealerCasinoGamesTable,
  dealerCasinoSettingsTable,
  dealerCasinoSettlementsTable,
  dealerCasinoStatsTable,
  dealerCasinoStreaksTable,
  endDealerCasinoSession,
  listAllDealerCasinoBets,
  listDealerCasinoBets,
  placeDealerCasinoBet,
  recordDealerCasinoResult,
  setDealerCasinoSettings,
  settleDealerCasinoGame,
  transitionDealerCasinoGame,
  transactionsTable,
  walletsTable,
  withdrawDealerCasinoBet,
} from "@workspace/db";

const guildIds: string[] = [];
const gameIds: number[] = [];

function userId(): string {
  return `dealer-casino-integrity-${randomUUID()}`;
}

async function createGame(maxPlayers = 1): Promise<{
  guildId: string;
  dealerId: string;
  gameId: number;
}> {
  const guildId = `dealer-casino-integrity-${randomUUID()}`;
  const dealerId = userId();
  const voiceChannelId = userId();
  guildIds.push(guildId);
  await setDealerCasinoSettings(guildId, {
    voiceChannelId,
    dealerRoleId: userId(),
    maxPlayers,
    chohanEnabled: 1,
    chohanMultipliers: { 1: 2 },
    chohanMaxStreakMultiplier: 2,
    streakRetentionSeconds: 3600,
  });
  const game = await createDealerCasinoGame({
    guildId,
    gameType: "chohan",
    dealerId,
    channelId: userId(),
    voiceChannelId,
  });
  gameIds.push(game.id);
  return { guildId, dealerId, gameId: game.id };
}

async function setBalance(guildId: string, userId: string, balance: number): Promise<void> {
  await db.insert(walletsTable)
    .values({ guildId, userId, balance })
    .onConflictDoUpdate({
      target: [walletsTable.guildId, walletsTable.userId],
      set: { balance },
    });
}

async function getBalance(guildId: string, userId: string): Promise<number> {
  const [wallet] = await db.select({ balance: walletsTable.balance })
    .from(walletsTable)
    .where(and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId)));
  return wallet?.balance ?? 0;
}

function outcome(userId: string, result: "WON" | "LOST", payout: number) {
  return {
    userId,
    result,
    payout,
    choice: "cho",
    winStreak: result === "WON" ? 1 : 0,
    multiplier: result === "WON" ? 2 : 0,
  } as const;
}

afterEach(async () => {
  if (gameIds.length) {
    await db.delete(dealerCasinoSettlementsTable)
      .where(inArray(dealerCasinoSettlementsTable.gameId, gameIds));
    await db.delete(dealerCasinoBetsTable)
      .where(inArray(dealerCasinoBetsTable.gameId, gameIds));
    await db.delete(dealerCasinoGamesTable)
      .where(inArray(dealerCasinoGamesTable.id, gameIds));
  }
  if (guildIds.length) {
    await db.delete(dealerCasinoStatsTable)
      .where(inArray(dealerCasinoStatsTable.guildId, guildIds));
    await db.delete(dealerCasinoStreaksTable)
      .where(inArray(dealerCasinoStreaksTable.guildId, guildIds));
    await db.delete(dealerCasinoSettingsTable)
      .where(inArray(dealerCasinoSettingsTable.guildId, guildIds));
    await db.delete(transactionsTable)
      .where(inArray(transactionsTable.guildId, guildIds));
    await db.delete(walletsTable)
      .where(inArray(walletsTable.guildId, guildIds));
  }
  gameIds.length = 0;
  guildIds.length = 0;
});

describe("dealer casino financial integrity", () => {
  it("keeps withdrawals auditable, excludes them from capacity and settlement, and never double-refunds cancellation", async () => {
    const { guildId, gameId } = await createGame(1);
    const withdrawnUser = userId();
    const activeUser = userId();
    await setBalance(guildId, withdrawnUser, 5000);
    await setBalance(guildId, activeUser, 5000);
    await db.insert(dealerCasinoStreaksTable).values({
      guildId,
      userId: withdrawnUser,
      winStreak: 4,
    });
    await placeDealerCasinoBet({ gameId, userId: withdrawnUser, amount: 1000, choice: "cho" });

    const withdrawal = await withdrawDealerCasinoBet(gameId, withdrawnUser);
    expect(withdrawal.bet.state).toBe("REFUNDED");
    expect(withdrawal.bet.result).toBe("WITHDRAWN");
    expect(await getBalance(guildId, withdrawnUser)).toBe(5000);
    const [withdrawnStreak] = await db.select().from(dealerCasinoStreaksTable)
      .where(and(
        eq(dealerCasinoStreaksTable.guildId, guildId),
        eq(dealerCasinoStreaksTable.userId, withdrawnUser),
      ));
    expect(withdrawnStreak?.winStreak).toBe(0);
    await expect(placeDealerCasinoBet({
      gameId,
      userId: withdrawnUser,
      amount: 1000,
      choice: "cho",
    })).rejects.toMatchObject({ code: "WITHDRAWN_CANNOT_REJOIN" });

    await placeDealerCasinoBet({ gameId, userId: activeUser, amount: 1000, choice: "cho" });
    await expect(placeDealerCasinoBet({
      gameId,
      userId: userId(),
      amount: 1000,
      choice: "cho",
    })).rejects.toMatchObject({ code: "PLAYER_LIMIT" });

    expect((await listDealerCasinoBets(gameId)).map((bet) => bet.userId)).toEqual([activeUser]);
    const auditRows = await listAllDealerCasinoBets(gameId);
    expect(auditRows).toHaveLength(2);
    expect(auditRows.find((bet) => bet.userId === withdrawnUser)?.result).toBe("WITHDRAWN");

    await transitionDealerCasinoGame(gameId, "RECRUITING", "CLOSED");
    await transitionDealerCasinoGame(gameId, "CLOSED", "PLAYING");
    const activeOutcome = outcome(activeUser, "LOST", 0);
    await recordDealerCasinoResult(gameId, {
      kind: "chohan",
      outcomes: [activeOutcome],
    });
    await settleDealerCasinoGame(gameId, [activeOutcome]);

    const [stats] = await db.select().from(dealerCasinoStatsTable)
      .where(eq(dealerCasinoStatsTable.guildId, guildId));
    expect(stats?.playersServed).toBe(1);
    expect(await getBalance(guildId, withdrawnUser)).toBe(5000);
    expect(await getBalance(guildId, activeUser)).toBe(4000);

    const cancelGame = await createGame(2);
    const cancelWithdrawnUser = userId();
    const cancelActiveUser = userId();
    await setBalance(cancelGame.guildId, cancelWithdrawnUser, 5000);
    await setBalance(cancelGame.guildId, cancelActiveUser, 5000);
    await placeDealerCasinoBet({
      gameId: cancelGame.gameId,
      userId: cancelWithdrawnUser,
      amount: 1000,
    });
    await withdrawDealerCasinoBet(cancelGame.gameId, cancelWithdrawnUser);
    await placeDealerCasinoBet({
      gameId: cancelGame.gameId,
      userId: cancelActiveUser,
      amount: 1000,
    });
    const cancellation = await cancelDealerCasinoGame(cancelGame.gameId);
    expect(cancellation.refundedCount).toBe(1);
    expect(await getBalance(cancelGame.guildId, cancelWithdrawnUser)).toBe(5000);
    expect(await getBalance(cancelGame.guildId, cancelActiveUser)).toBe(5000);
    const cancelRows = await db.select().from(dealerCasinoBetsTable)
      .where(eq(dealerCasinoBetsTable.gameId, cancelGame.gameId));
    expect(cancelRows.find((bet) => bet.userId === cancelWithdrawnUser)?.result).toBe("WITHDRAWN");
  }, 30_000);

  it("rejects refunds after result lock and settles only the immutable outcome, including finished retries", async () => {
    const { guildId, gameId } = await createGame();
    const playerId = userId();
    await setBalance(guildId, playerId, 5000);
    await placeDealerCasinoBet({ gameId, userId: playerId, amount: 1000, choice: "cho" });
    await transitionDealerCasinoGame(gameId, "RECRUITING", "CLOSED");
    await transitionDealerCasinoGame(gameId, "CLOSED", "PLAYING");
    const lockedOutcome = outcome(playerId, "LOST", 0);
    await recordDealerCasinoResult(gameId, {
      kind: "chohan",
      outcomes: [lockedOutcome],
    });

    await expect(cancelDealerCasinoGame(gameId))
      .rejects.toMatchObject({ code: "RESULT_LOCKED" });
    await expect(settleDealerCasinoGame(gameId, [outcome(playerId, "WON", 2000)]))
      .rejects.toMatchObject({ code: "OUTCOME_MISMATCH" });
    expect(await getBalance(guildId, playerId)).toBe(4000);

    const settled = await settleDealerCasinoGame(gameId, [lockedOutcome]);
    expect(settled.game.state).toBe("FINISHED");
    expect(settled.alreadySettled).toBe(false);
    await expect(settleDealerCasinoGame(gameId, [outcome(playerId, "WON", 2000)]))
      .rejects.toMatchObject({ code: "OUTCOME_MISMATCH" });
    const retry = await settleDealerCasinoGame(gameId, [lockedOutcome]);
    expect(retry.alreadySettled).toBe(true);
    expect(await getBalance(guildId, playerId)).toBe(4000);
  });

  it("preserves streaks on game cancellation and resets every guild streak when the session ends", async () => {
    const { guildId, dealerId, gameId } = await createGame(2);
    const firstPlayer = userId();
    const secondPlayer = userId();
    await db.insert(dealerCasinoStreaksTable).values([
      { guildId, userId: firstPlayer, winStreak: 3 },
      { guildId, userId: secondPlayer, winStreak: 6 },
    ]);

    await cancelDealerCasinoGame(gameId);
    const afterCancellation = await db.select().from(dealerCasinoStreaksTable)
      .where(eq(dealerCasinoStreaksTable.guildId, guildId));
    expect(afterCancellation.map((streak) => streak.winStreak).sort()).toEqual([3, 6]);

    await endDealerCasinoSession(guildId, dealerId);
    const afterSessionEnd = await db.select().from(dealerCasinoStreaksTable)
      .where(eq(dealerCasinoStreaksTable.guildId, guildId));
    expect(afterSessionEnd.map((streak) => streak.winStreak).sort()).toEqual([0, 0]);
  });
});