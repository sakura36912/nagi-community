import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  dealerCasinoBetsTable,
  dealerCasinoGamesTable,
  dealerCasinoSettingsTable,
  dealerCasinoSettlementsTable,
  dealerCasinoStatsTable,
  dealerCasinoStreaksTable,
  placeDealerCasinoBet,
  cancelDealerCasinoGame,
  createDealerCasinoGame,
  dealDealerCasinoPoker,
  getDealerCasinoGame,
  getDealerCasinoPokerDeal,
  listDealerCasinoBets,
  recordDealerCasinoResult,
  setDealerCasinoSettings,
  settleDealerCasinoGame,
  transitionDealerCasinoGame,
  updateDealerCasinoBet,
  withdrawDealerCasinoBet,
  DealerCasinoError,
  transactionsTable,
  walletsTable,
  type DealerCasinoOutcome,
} from "@workspace/db";

interface TestContext {
  guildId: string;
  dealerId: string;
  channelId: string;
  voiceChannelId: string;
  gameId: number;
}

const testGuildIds: string[] = [];
const testGameIds: number[] = [];

const schemaProbe = await db.execute(sql`
  SELECT to_regclass('public.dealer_casino_games') IS NOT NULL
     AND to_regclass('public.dealer_casino_bets') IS NOT NULL
     AND to_regclass('public.dealer_casino_settlements') IS NOT NULL
     AND to_regclass('public.dealer_casino_settings') IS NOT NULL
     AND to_regclass('public.dealer_casino_stats') IS NOT NULL
     AND to_regclass('public.dealer_casino_streaks') IS NOT NULL
     AS dealer_casino_schema_available
`);
const dealerCasinoSchemaAvailable = Boolean(
  schemaProbe.rows[0]?.dealer_casino_schema_available,
);
const integrationDescribe = dealerCasinoSchemaAvailable ? describe : describe.skip;

function userId(): string {
  return `test-user-${randomUUID()}`;
}

async function configureGuild(
  guildId: string,
  gameType: "chohan" | "poker" = "chohan",
): Promise<{ dealerId: string; channelId: string; voiceChannelId: string }> {
  const config = {
    dealerId: userId(),
    channelId: `test-text-${randomUUID()}`,
    voiceChannelId: `test-voice-${randomUUID()}`,
  };
  await setDealerCasinoSettings(guildId, {
    dealerRoleId: `test-dealer-role-${randomUUID()}`,
    directorRoleId: `test-director-role-${randomUUID()}`,
    voiceChannelId: config.voiceChannelId,
    maxPlayers: 8,
    ...(gameType === "chohan"
      ? {
          chohanEnabled: 1,
          chohanMultipliers: { 1: 2, 2: 2.2 },
          chohanMaxStreakMultiplier: 2.2,
          streakRetentionSeconds: 3600,
        }
      : {
          pokerEnabled: 1,
          pokerBaseMultiplier: 2,
          pokerBonusEnabled: 0,
          pokerAceLowEnabled: 1,
          pokerDealerQualificationEnabled: 0,
        }),
  });
  return config;
}

async function makeGame(
  gameType: "chohan" | "poker" = "chohan",
): Promise<TestContext> {
  const guildId = `test-dealer-casino-${randomUUID()}`;
  testGuildIds.push(guildId);
  const { dealerId, channelId, voiceChannelId } = await configureGuild(guildId, gameType);
  const game = await createDealerCasinoGame({
    guildId,
    gameType,
    dealerId,
    channelId,
    voiceChannelId,
  });
  testGameIds.push(game.id);
  return { guildId, dealerId, channelId, voiceChannelId, gameId: game.id };
}

async function setBalance(guildId: string, userId: string, balance: number): Promise<void> {
  await db.insert(walletsTable)
    .values({ guildId, userId, balance })
    .onConflictDoUpdate({
      target: [walletsTable.guildId, walletsTable.userId],
      set: { balance },
    });
}

async function balance(guildId: string, userId: string): Promise<number> {
  const [wallet] = await db.select({ balance: walletsTable.balance })
    .from(walletsTable)
    .where(and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId)));
  return wallet?.balance ?? 0;
}

function makeOutcome(
  playerId: string,
  result: DealerCasinoOutcome["result"],
  payout: number,
  choice: string | null = "cho",
): DealerCasinoOutcome {
  return {
    userId: playerId,
    result,
    payout,
    choice,
    cards: null,
    handRank: null,
    winStreak: result === "WON" ? 1 : 0,
    multiplier: result === "WON" ? 2 : 0,
  };
}

async function recordChohanResult(
  gameId: number,
  outcomes: DealerCasinoOutcome[],
): Promise<void> {
  await transitionDealerCasinoGame(gameId, "RECRUITING", "CLOSED");
  await transitionDealerCasinoGame(gameId, "CLOSED", "PLAYING");
  await recordDealerCasinoResult(gameId, { kind: "chohan", dice: [2, 2], total: 4, result: "cho", outcomes });
}

afterEach(async () => {
  if (testGameIds.length) {
    await db.delete(dealerCasinoSettlementsTable)
      .where(inArray(dealerCasinoSettlementsTable.gameId, testGameIds));
    await db.delete(dealerCasinoBetsTable)
      .where(inArray(dealerCasinoBetsTable.gameId, testGameIds));
    await db.delete(dealerCasinoGamesTable)
      .where(inArray(dealerCasinoGamesTable.id, testGameIds));
  }
  if (testGuildIds.length) {
    await db.delete(dealerCasinoStatsTable)
      .where(inArray(dealerCasinoStatsTable.guildId, testGuildIds));
    await db.delete(dealerCasinoStreaksTable)
      .where(inArray(dealerCasinoStreaksTable.guildId, testGuildIds));
    await db.delete(dealerCasinoSettingsTable)
      .where(inArray(dealerCasinoSettingsTable.guildId, testGuildIds));
    await db.delete(transactionsTable)
      .where(inArray(transactionsTable.guildId, testGuildIds));
    await db.delete(walletsTable)
      .where(inArray(walletsTable.guildId, testGuildIds));
  }
  testGameIds.length = 0;
  testGuildIds.length = 0;
});

integrationDescribe("dealer casino DB persistence", () => {
  it("atomically debits a bet and refunds it only once when cancelled", async () => {
    const context = await makeGame();
    const playerId = userId();
    await setBalance(context.guildId, playerId, 5000);

    await placeDealerCasinoBet({ gameId: context.gameId, userId: playerId, amount: 1000, choice: "cho" });
    expect(await balance(context.guildId, playerId)).toBe(4000);

    const first = await cancelDealerCasinoGame(context.gameId);
    expect(first).toMatchObject({ refundedCount: 1, alreadyCancelled: false });
    expect(await balance(context.guildId, playerId)).toBe(5000);

    const second = await cancelDealerCasinoGame(context.gameId);
    expect(second).toMatchObject({ refundedCount: 0, alreadyCancelled: true });
    expect(await balance(context.guildId, playerId)).toBe(5000);

    const ledger = await db.select({ amount: transactionsTable.amount })
      .from(transactionsTable)
      .where(and(
        eq(transactionsTable.guildId, context.guildId),
        eq(transactionsTable.userId, playerId),
      ));
    expect(ledger.map((entry) => entry.amount).sort((a, b) => a - b)).toEqual([-1000, 1000]);
  });

  it("adjusts a bet by only the balance delta and refunds a withdrawal once", async () => {
    const context = await makeGame();
    const playerId = userId();
    await setBalance(context.guildId, playerId, 10_000);

    await placeDealerCasinoBet({ gameId: context.gameId, userId: playerId, amount: 3000, choice: "cho" });
    expect(await balance(context.guildId, playerId)).toBe(7000);

    await updateDealerCasinoBet({
      gameId: context.gameId,
      userId: playerId,
      amount: 2000,
      choice: "han",
    });
    expect(await balance(context.guildId, playerId)).toBe(8000);
    expect((await listDealerCasinoBets(context.gameId))[0]).toMatchObject({
      betAmount: 2000,
      choice: "han",
    });

    await withdrawDealerCasinoBet(context.gameId, playerId);
    expect(await balance(context.guildId, playerId)).toBe(10_000);
    await expect(withdrawDealerCasinoBet(context.gameId, playerId)).rejects.toBeInstanceOf(DealerCasinoError);
    expect(await balance(context.guildId, playerId)).toBe(10_000);
    expect(await listDealerCasinoBets(context.gameId)).toHaveLength(0);
  });

  it("does not let a withdrawn player block the remaining players' result and settlement", async () => {
    const context = await makeGame();
    const withdrawnPlayer = userId();
    const activePlayer = userId();
    await setBalance(context.guildId, withdrawnPlayer, 3000);
    await setBalance(context.guildId, activePlayer, 3000);
    await placeDealerCasinoBet({ gameId: context.gameId, userId: withdrawnPlayer, amount: 1000, choice: "cho" });
    await placeDealerCasinoBet({ gameId: context.gameId, userId: activePlayer, amount: 1000, choice: "cho" });
    await withdrawDealerCasinoBet(context.gameId, withdrawnPlayer);

    const outcomes = [makeOutcome(activePlayer, "WON", 2000)];
    await recordChohanResult(context.gameId, outcomes);
    const settled = await settleDealerCasinoGame(context.gameId, outcomes);

    expect(settled.game.state).toBe("FINISHED");
    expect(settled.settlements).toHaveLength(1);
    expect(await balance(context.guildId, withdrawnPlayer)).toBe(3000);
    expect(await balance(context.guildId, activePlayer)).toBe(4000);
  });

  it("allows only one concurrent join by the same user and charges once", async () => {
    const context = await makeGame();
    const playerId = userId();
    await setBalance(context.guildId, playerId, 5000);

    const attempts = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        placeDealerCasinoBet({
          gameId: context.gameId,
          userId: playerId,
          amount: 1000,
          choice: "cho",
        }),
      ),
    );
    expect(attempts.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((entry) => entry.status === "rejected")).toHaveLength(1);
    expect(await balance(context.guildId, playerId)).toBe(4000);
    expect(await listDealerCasinoBets(context.gameId)).toHaveLength(1);
  });

  it("does not refund a result-locked game through cancellation", async () => {
    const context = await makeGame();
    const playerId = userId();
    await setBalance(context.guildId, playerId, 5000);
    await placeDealerCasinoBet({ gameId: context.gameId, userId: playerId, amount: 1000, choice: "cho" });

    const outcomes = [makeOutcome(playerId, "LOST", 0)];
    await recordChohanResult(context.gameId, outcomes);
    await expect(cancelDealerCasinoGame(context.gameId)).rejects.toBeInstanceOf(DealerCasinoError);
    expect(await balance(context.guildId, playerId)).toBe(4000);

    const settled = await settleDealerCasinoGame(context.gameId, outcomes);
    expect(settled.game.state).toBe("FINISHED");
    expect(await balance(context.guildId, playerId)).toBe(4000);
  });

  it("rejects tampered payouts and safely accepts repeated concurrent settlement", async () => {
    const context = await makeGame();
    const playerId = userId();
    await setBalance(context.guildId, playerId, 5000);
    await placeDealerCasinoBet({ gameId: context.gameId, userId: playerId, amount: 1000, choice: "cho" });

    const locked = makeOutcome(playerId, "WON", 2000);
    await recordChohanResult(context.gameId, [locked]);
    const tampered = makeOutcome(playerId, "WON", 9999);
    await expect(settleDealerCasinoGame(context.gameId, [tampered])).rejects.toBeInstanceOf(DealerCasinoError);
    expect(await balance(context.guildId, playerId)).toBe(4000);
    expect((await getDealerCasinoGame(context.gameId))?.state).toBe("RESULT");

    const results = await Promise.all([
      settleDealerCasinoGame(context.gameId, [locked]),
      settleDealerCasinoGame(context.gameId, [locked]),
    ]);
    expect(results.every((result) => result.game.state === "FINISHED")).toBe(true);
    expect(results.filter((result) => result.alreadySettled)).toHaveLength(1);
    expect(await balance(context.guildId, playerId)).toBe(6000);

    const settlements = await db.select()
      .from(dealerCasinoSettlementsTable)
      .where(eq(dealerCasinoSettlementsTable.gameId, context.gameId));
    expect(settlements).toHaveLength(1);
  });

  it("stores poker cards and deadline atomically so a deal is recoverable", async () => {
    const context = await makeGame("poker");
    const playerId = userId();
    await setBalance(context.guildId, playerId, 5000);
    await placeDealerCasinoBet({ gameId: context.gameId, userId: playerId, amount: 1000 });
    await transitionDealerCasinoGame(context.gameId, "RECRUITING", "CLOSED");

    const deadline = new Date(Date.now() + 60_000);
    const dealerCards = ["spades:14", "hearts:13", "diamonds:12"];
    const playerCards = ["clubs:11", "spades:10", "hearts:9"];
    const dealt = await dealDealerCasinoPoker(
      context.gameId,
      dealerCards,
      [{ userId: playerId, cards: playerCards, handRank: "high-card" }],
      deadline,
    );
    expect(dealt.state).toBe("PLAYING");
    expect(dealt.dealerCards).toEqual(dealerCards);
    expect(dealt.actionDeadline?.toISOString()).toBe(deadline.toISOString());
    expect(await getDealerCasinoPokerDeal(context.gameId)).toEqual({
      dealerCards,
      actionDeadline: deadline,
    });
    expect(await listDealerCasinoBets(context.gameId)).toMatchObject([
      { userId: playerId, cards: playerCards, handRank: "high-card" },
    ]);
  });

  it("rolls back a poker deal containing a duplicate card", async () => {
    const context = await makeGame("poker");
    const playerId = userId();
    await setBalance(context.guildId, playerId, 5000);
    await placeDealerCasinoBet({ gameId: context.gameId, userId: playerId, amount: 1000 });
    await transitionDealerCasinoGame(context.gameId, "RECRUITING", "CLOSED");
    const duplicateCards = ["spades:2", "hearts:3", "diamonds:4"];

    await expect(dealDealerCasinoPoker(
      context.gameId,
      duplicateCards,
      [{ userId: playerId, cards: ["spades:2", "clubs:5", "clubs:6"], handRank: "high-card" }],
      new Date(Date.now() + 60_000),
    )).rejects.toBeInstanceOf(DealerCasinoError);

    expect((await getDealerCasinoGame(context.gameId))?.state).toBe("CLOSED");
    expect(await getDealerCasinoPokerDeal(context.gameId)).toBeNull();
    expect((await listDealerCasinoBets(context.gameId))[0]?.cards).toBeNull();
  });
});