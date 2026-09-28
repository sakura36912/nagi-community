import {
  and,
  asc,
  desc,
  eq,
  inArray,
  sql,
} from "drizzle-orm";
import {
  db,
  transactionsTable,
  walletsTable,
} from "./index";
import {
  dealerCasinoBetsTable,
  dealerCasinoGamesTable,
  dealerCasinoSettlementsTable,
  dealerCasinoSettingsTable,
  dealerCasinoStatsTable,
  dealerCasinoStreaksTable,
} from "./schema/dealerCasino";
import type {
  DealerCasinoBet,
  DealerCasinoGame,
  DealerCasinoSettings,
} from "./schema/dealerCasino";
import { vcHubChannelsTable, vcHubSessionsTable } from "./schema/vcHub";

export type DealerCasinoType = "chohan" | "poker";
export type DealerCasinoState =
  | "RECRUITING" | "CLOSED" | "PLAYING" | "RESULT" | "PAYOUT"
  | "FINISHED" | "CANCELLED";
export type DealerCasinoBetResult = "WON" | "LOST" | "DRAW" | "FOLDED";
export type ChohanStreakDecision = "continue" | "cashout" | "loss";

const ACTIVE_STATES: DealerCasinoState[] = [
  "RECRUITING", "CLOSED", "PLAYING", "RESULT", "PAYOUT",
];
const TRANSITIONS: Record<DealerCasinoState, DealerCasinoState[]> = {
  RECRUITING: ["CLOSED"],
  CLOSED: ["PLAYING"],
  PLAYING: ["RESULT"],
  RESULT: ["PAYOUT"],
  PAYOUT: ["FINISHED"],
  FINISHED: [],
  CANCELLED: [],
};

export class DealerCasinoError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "DealerCasinoError";
  }
}

export type DealerCasinoSettingsUpdate = Partial<
  Omit<DealerCasinoSettings, "guildId">
>;

export interface DealerCasinoGameInput {
  guildId: string;
  gameType: DealerCasinoType;
  dealerId: string;
  channelId: string;
  voiceChannelId: string;
  panelMessageId?: string | null;
}

export interface DealerCasinoBetInput {
  gameId: number;
  userId: string;
  amount: number;
  choice?: string | null;
}

export interface DealerCasinoPlayUpdate {
  cards?: string[] | null;
  handRank?: string | null;
  playerAction?: "CONTINUE" | "FOLDED" | null;
}

export interface DealerCasinoOutcome {
  userId: string;
  result: DealerCasinoBetResult;
  payout: number;
  choice?: string | null;
  cards?: string[] | null;
  handRank?: string | null;
  winStreak?: number | null;
  multiplier?: number | null;
}

export interface DealerCasinoPlayerHand {
  userId: string;
  cards: string[];
  handRank: string;
}

const MAX_POSTGRES_INTEGER = 2_147_483_647;

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_POSTGRES_INTEGER) {
    throw new DealerCasinoError(`${label} must be a positive safe integer.`, "INVALID_AMOUNT");
  }
}

function assertConfiguredSettings(
  settings: DealerCasinoSettings | undefined,
  gameType: DealerCasinoType,
): asserts settings is DealerCasinoSettings {
  if (!settings) throw new DealerCasinoError("Dealer casino settings are not configured.", "SETTINGS_REQUIRED");
  if (!settings.voiceChannelId || !settings.dealerRoleId) {
    throw new DealerCasinoError("Configure the casino voice channel and dealer role first.", "SETTINGS_REQUIRED");
  }
  if (!settings.maxPlayers || settings.maxPlayers < 1) {
    throw new DealerCasinoError("Configure a positive maximum player count before opening a game.", "SETTINGS_REQUIRED");
  }
  if (settings.maxBet < settings.minBet || settings.minBet < 1) {
    throw new DealerCasinoError("The configured betting range is invalid.", "INVALID_SETTINGS");
  }
  if (gameType === "chohan") {
    if (
      settings.chohanEnabled !== 1 ||
      !settings.chohanMultipliers ||
      !Object.keys(settings.chohanMultipliers).length ||
      settings.streakRetentionSeconds === null ||
      settings.chohanMaxStreakMultiplier === null
    ) {
      throw new DealerCasinoError(
        "丁半 is disabled until it is enabled and its streak/multiplier settings are configured.",
        "SETTINGS_REQUIRED",
      );
    }
  } else if (
    settings.pokerEnabled !== 1 ||
    settings.pokerBaseMultiplier === null ||
    settings.pokerBonusEnabled === null ||
    settings.pokerAceLowEnabled === null ||
    settings.pokerDealerQualificationEnabled === null ||
    (settings.pokerBonusEnabled === 1 && !settings.pokerBonusMultipliers) ||
    (settings.pokerDealerQualificationEnabled === 1 && !settings.pokerDealerQualificationRank) ||
    (settings.pokerDealerQualificationEnabled === 1 &&
      settings.pokerDealerQualificationRank === "high-card" &&
      settings.pokerDealerMinimumHighCard === null)
  ) {
    throw new DealerCasinoError(
      "Poker is disabled until all required rules and payout settings are configured.",
      "SETTINGS_REQUIRED",
    );
  }
}

/** Return null until an administrator has created settings for this guild. */
export async function getDealerCasinoSettings(
  guildId: string,
): Promise<DealerCasinoSettings | null> {
  const [settings] = await db
    .select()
    .from(dealerCasinoSettingsTable)
    .where(eq(dealerCasinoSettingsTable.guildId, guildId))
    .limit(1);
  return settings ?? null;
}

/** Upsert only explicitly supplied values; NULL intentionally clears settings. */
export async function setDealerCasinoSettings(
  guildId: string,
  changes: DealerCasinoSettingsUpdate,
): Promise<DealerCasinoSettings> {
  if (!Object.keys(changes).length) {
    throw new DealerCasinoError("At least one setting must be supplied.", "EMPTY_SETTINGS");
  }
  if (changes.minBet !== undefined && (!Number.isSafeInteger(changes.minBet) || changes.minBet < 1 || changes.minBet > MAX_POSTGRES_INTEGER)) {
    throw new DealerCasinoError("Minimum bet must be a positive integer.", "INVALID_SETTINGS");
  }
  if (changes.maxBet !== undefined && (!Number.isSafeInteger(changes.maxBet) || changes.maxBet < 1 || changes.maxBet > MAX_POSTGRES_INTEGER)) {
    throw new DealerCasinoError("Maximum bet must be a positive integer.", "INVALID_SETTINGS");
  }
  if (changes.maxPlayers !== undefined && changes.maxPlayers !== null && (!Number.isSafeInteger(changes.maxPlayers) || changes.maxPlayers < 1 || changes.maxPlayers > MAX_POSTGRES_INTEGER)) {
    throw new DealerCasinoError("Maximum players must be a positive integer or NULL.", "INVALID_SETTINGS");
  }
  if (changes.pokerBonusEnabled !== undefined && changes.pokerBonusEnabled !== null && ![0, 1].includes(changes.pokerBonusEnabled)) {
    throw new DealerCasinoError("pokerBonusEnabled must be 0, 1, or NULL.", "INVALID_SETTINGS");
  }
  if (changes.pokerDealerQualificationEnabled !== undefined && changes.pokerDealerQualificationEnabled !== null && ![0, 1].includes(changes.pokerDealerQualificationEnabled)) {
    throw new DealerCasinoError("pokerDealerQualificationEnabled must be 0, 1, or NULL.", "INVALID_SETTINGS");
  }
  if (changes.pokerDealerMinimumHighCard !== undefined && changes.pokerDealerMinimumHighCard !== null &&
      (!Number.isSafeInteger(changes.pokerDealerMinimumHighCard) ||
        changes.pokerDealerMinimumHighCard < 2 || changes.pokerDealerMinimumHighCard > 14)) {
    throw new DealerCasinoError("Poker dealer minimum high-card rank must be an integer from 2 through 14 or NULL.", "INVALID_SETTINGS");
  }
  if (changes.pokerAceLowEnabled !== undefined && changes.pokerAceLowEnabled !== null && ![0, 1].includes(changes.pokerAceLowEnabled)) {
    throw new DealerCasinoError("pokerAceLowEnabled must be 0, 1, or NULL.", "INVALID_SETTINGS");
  }
  if (changes.chohanEnabled !== undefined && changes.chohanEnabled !== null && ![0, 1].includes(changes.chohanEnabled)) {
    throw new DealerCasinoError("chohanEnabled must be 0, 1, or NULL.", "INVALID_SETTINGS");
  }
  if (changes.pokerEnabled !== undefined && changes.pokerEnabled !== null && ![0, 1].includes(changes.pokerEnabled)) {
    throw new DealerCasinoError("pokerEnabled must be 0, 1, or NULL.", "INVALID_SETTINGS");
  }
  if (changes.pokerTimeoutSeconds !== undefined && (!Number.isSafeInteger(changes.pokerTimeoutSeconds) || changes.pokerTimeoutSeconds < 1 || changes.pokerTimeoutSeconds > MAX_POSTGRES_INTEGER)) {
    throw new DealerCasinoError("Poker timeout must be a positive integer.", "INVALID_SETTINGS");
  }
  if (changes.activityPointsPerGame !== undefined && changes.activityPointsPerGame !== null &&
      (!Number.isSafeInteger(changes.activityPointsPerGame) || changes.activityPointsPerGame < 0 || changes.activityPointsPerGame > MAX_POSTGRES_INTEGER)) {
    throw new DealerCasinoError("Activity points per game must be a non-negative integer or NULL.", "INVALID_SETTINGS");
  }
  const retention = changes.streakRetentionSeconds;
  if (retention !== undefined && retention !== null && (!Number.isSafeInteger(retention) || retention < 1 || retention > MAX_POSTGRES_INTEGER)) {
    throw new DealerCasinoError("streakRetentionSeconds must be a positive integer or NULL.", "INVALID_SETTINGS");
  }
  for (const key of ["chohanMaxStreakMultiplier", "pokerBaseMultiplier"] as const) {
    const value = changes[key];
    if (value !== undefined && value !== null &&
        (!Number.isFinite(value) ||
          value <= 0 ||
          value > MAX_NUMERIC_MULTIPLIER ||
          Math.round(value * 1_000_000) / 1_000_000 !== value)) {
      throw new DealerCasinoError(`${key} must be a positive multiplier with at most six decimal places or NULL.`, "INVALID_SETTINGS");
    }
  }
  for (const [key, value] of Object.entries(changes)) {
    if (key.toLowerCase().includes("multiplier") && value && typeof value === "object") {
      const values = Object.values(value as Record<string, unknown>);
      if (values.some((multiplier) => typeof multiplier !== "number" || !Number.isFinite(multiplier) || multiplier <= 0)) {
        throw new DealerCasinoError(`${key} must contain positive finite multipliers.`, "INVALID_SETTINGS");
      }
    }
  }
  if (changes.minBet !== undefined && changes.maxBet !== undefined && changes.maxBet < changes.minBet) {
    throw new DealerCasinoError("Maximum bet cannot be lower than minimum bet.", "INVALID_SETTINGS");
  }

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(dealerCasinoSettingsTable)
      .where(eq(dealerCasinoSettingsTable.guildId, guildId))
      .for("update")
      .limit(1);
    const next = { ...(current ?? { guildId }), ...changes };
    if (next.maxBet < next.minBet) {
      throw new DealerCasinoError("Maximum bet cannot be lower than minimum bet.", "INVALID_SETTINGS");
    }
    const [saved] = await tx
      .insert(dealerCasinoSettingsTable)
      .values(next)
      .onConflictDoUpdate({
        target: dealerCasinoSettingsTable.guildId,
        set: changes,
      })
      .returning();
    if (!saved) throw new DealerCasinoError("Settings could not be saved.", "DATABASE_ERROR");
    return saved;
  });
}

export async function createDealerCasinoGame(
  input: DealerCasinoGameInput,
): Promise<DealerCasinoGame> {
  return db.transaction(async (tx) => {
    const [settings] = await tx
      .select()
      .from(dealerCasinoSettingsTable)
      .where(eq(dealerCasinoSettingsTable.guildId, input.guildId))
      .limit(1);
    assertConfiguredSettings(settings, input.gameType);
    if (input.voiceChannelId !== settings.voiceChannelId) {
      const [transferred] = await tx
        .select({ id: vcHubSessionsTable.id })
        .from(vcHubSessionsTable)
        .innerJoin(vcHubChannelsTable, eq(vcHubSessionsTable.hubId, vcHubChannelsTable.id))
        .where(and(
          eq(vcHubSessionsTable.channelId, input.voiceChannelId),
          eq(vcHubSessionsTable.guildId, input.guildId),
          eq(vcHubChannelsTable.guildId, input.guildId),
          eq(vcHubChannelsTable.hubChannelId, settings.voiceChannelId),
        ))
        .limit(1);
      if (!transferred) {
        throw new DealerCasinoError("The dealer is not in the configured casino voice channel or its transfer destination.", "VOICE_CHANNEL_MISMATCH");
      }
    }

    const [existing] = await tx
      .select({ id: dealerCasinoGamesTable.id })
      .from(dealerCasinoGamesTable)
      .where(and(
        eq(dealerCasinoGamesTable.guildId, input.guildId),
        inArray(dealerCasinoGamesTable.state, ACTIVE_STATES),
      ))
      .limit(1);
    if (existing) throw new DealerCasinoError("This server already has an active dealer-led game.", "ACTIVE_GAME_EXISTS");

    try {
      const [game] = await tx.insert(dealerCasinoGamesTable).values({
        guildId: input.guildId,
        gameType: input.gameType,
        dealerId: input.dealerId,
        channelId: input.channelId,
        voiceChannelId: input.voiceChannelId,
        panelMessageId: input.panelMessageId ?? null,
        state: "RECRUITING",
      }).returning();
      if (!game) throw new DealerCasinoError("Game could not be created.", "DATABASE_ERROR");
      return game;
    } catch (error) {
      if (error instanceof DealerCasinoError) throw error;
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
        throw new DealerCasinoError("This server already has an active dealer-led game.", "ACTIVE_GAME_EXISTS");
      }
      throw error;
    }
  });
}

export async function getActiveDealerCasinoGame(
  guildId: string,
): Promise<DealerCasinoGame | null> {
  const [game] = await db
    .select()
    .from(dealerCasinoGamesTable)
    .where(and(
      eq(dealerCasinoGamesTable.guildId, guildId),
      inArray(dealerCasinoGamesTable.state, ACTIVE_STATES),
    ))
    .limit(1);
  return game ?? null;
}

export async function getDealerCasinoGame(
  gameId: number,
): Promise<DealerCasinoGame | null> {
  const [game] = await db
    .select()
    .from(dealerCasinoGamesTable)
    .where(eq(dealerCasinoGamesTable.id, gameId))
    .limit(1);
  return game ?? null;
}

/** Return the most recently created game, including finished/cancelled games. */
export async function getLatestDealerCasinoGame(
  guildId: string,
): Promise<DealerCasinoGame | null> {
  const [game] = await db
    .select()
    .from(dealerCasinoGamesTable)
    .where(eq(dealerCasinoGamesTable.guildId, guildId))
    .orderBy(desc(dealerCasinoGamesTable.createdAt), desc(dealerCasinoGamesTable.id))
    .limit(1);
  return game ?? null;
}

/**
 * Mark the most recent game as the dealer session's terminal game. Only its
 * owning dealer may end a session, and the latest game must already be done.
 */
export async function endDealerCasinoSession(
  guildId: string,
  dealerId: string,
): Promise<DealerCasinoGame> {
  return db.transaction(async (tx) => {
    const [latest] = await tx.select()
      .from(dealerCasinoGamesTable)
      .where(eq(dealerCasinoGamesTable.guildId, guildId))
      .orderBy(desc(dealerCasinoGamesTable.createdAt), desc(dealerCasinoGamesTable.id))
      .for("update")
      .limit(1);
    if (!latest) throw new DealerCasinoError("No dealer casino game exists for this server.", "GAME_NOT_FOUND");
    if (latest.dealerId !== dealerId) {
      throw new DealerCasinoError("Only the dealer who owns the latest game may end this session.", "NOT_GAME_DEALER");
    }
    if (latest.state !== "FINISHED" && latest.state !== "CANCELLED") {
      throw new DealerCasinoError("The latest game must be finished or cancelled before ending its session.", "GAME_NOT_FINISHED");
    }
    const [ended] = await tx.update(dealerCasinoGamesTable)
      .set({ sessionEnded: 1 })
      .where(eq(dealerCasinoGamesTable.id, latest.id))
      .returning();
    if (!ended) throw new DealerCasinoError("Could not end the dealer session.", "DATABASE_ERROR");
    await tx.update(dealerCasinoStreaksTable)
      .set({ winStreak: 0, updatedAt: new Date() })
      .where(eq(dealerCasinoStreaksTable.guildId, guildId));
    return ended;
  });
}

/** Read a persisted hidden hand/deadline for recovering an in-progress round. */
export async function getDealerCasinoPokerDeal(
  gameId: number,
): Promise<{ dealerCards: string[]; actionDeadline: Date } | null> {
  const [game] = await db.select({
    state: dealerCasinoGamesTable.state,
    gameType: dealerCasinoGamesTable.gameType,
    result: dealerCasinoGamesTable.result,
    dealerCards: dealerCasinoGamesTable.dealerCards,
    actionDeadline: dealerCasinoGamesTable.actionDeadline,
  })
    .from(dealerCasinoGamesTable)
    .where(eq(dealerCasinoGamesTable.id, gameId))
    .limit(1);
  if (
    !game ||
    game.gameType !== "poker" ||
    game.state !== "PLAYING" ||
    game.result !== null ||
    !game.dealerCards ||
    !game.actionDeadline
  ) return null;
  return { dealerCards: game.dealerCards, actionDeadline: game.actionDeadline };
}

/** Current participants only; withdrawn rows remain available through listAllDealerCasinoBets. */
export async function listDealerCasinoBets(
  gameId: number,
): Promise<DealerCasinoBet[]> {
  return db
    .select()
    .from(dealerCasinoBetsTable)
    .where(and(
      eq(dealerCasinoBetsTable.gameId, gameId),
      sql`(${dealerCasinoBetsTable.state} <> 'REFUNDED' OR ${dealerCasinoBetsTable.result} IS DISTINCT FROM 'WITHDRAWN')`,
    ))
    .orderBy(asc(dealerCasinoBetsTable.createdAt), asc(dealerCasinoBetsTable.id));
}

/** Include withdrawn rows for explicit audit/reconciliation views. */
export async function listAllDealerCasinoBets(
  gameId: number,
): Promise<DealerCasinoBet[]> {
  return db
    .select()
    .from(dealerCasinoBetsTable)
    .where(eq(dealerCasinoBetsTable.gameId, gameId))
    .orderBy(asc(dealerCasinoBetsTable.createdAt), asc(dealerCasinoBetsTable.id));
}

/** Lock the game row, then debit and create its stake ledger entry atomically. */
export async function placeDealerCasinoBet(
  input: DealerCasinoBetInput,
): Promise<DealerCasinoBet> {
  assertPositiveInteger(input.amount, "Bet");
  return db.transaction(async (tx) => {
    const [game] = await tx
      .select()
      .from(dealerCasinoGamesTable)
      .where(eq(dealerCasinoGamesTable.id, input.gameId))
      .for("update")
      .limit(1);
    if (!game) throw new DealerCasinoError("Game not found.", "GAME_NOT_FOUND");
    if (game.state !== "RECRUITING") {
      throw new DealerCasinoError("This game's entry period is closed.", "GAME_NOT_RECRUITING");
    }
    if (game.dealerId === input.userId) {
      throw new DealerCasinoError("The dealer cannot join their own game.", "DEALER_CANNOT_BET");
    }
    const [settings] = await tx
      .select()
      .from(dealerCasinoSettingsTable)
      .where(eq(dealerCasinoSettingsTable.guildId, game.guildId))
      .limit(1);
    if (!settings) throw new DealerCasinoError("Dealer casino settings are missing.", "SETTINGS_REQUIRED");
    if (input.amount < settings.minBet || input.amount > settings.maxBet) {
      throw new DealerCasinoError(`Bet must be between ${settings.minBet} and ${settings.maxBet}.`, "BET_OUT_OF_RANGE");
    }

    const [existingBet] = await tx
      .select({
        id: dealerCasinoBetsTable.id,
        state: dealerCasinoBetsTable.state,
        result: dealerCasinoBetsTable.result,
      })
      .from(dealerCasinoBetsTable)
      .where(and(
        eq(dealerCasinoBetsTable.gameId, game.id),
        eq(dealerCasinoBetsTable.userId, input.userId),
      ))
      .for("update")
      .limit(1);
    if (existingBet) {
      if (existingBet.state === "REFUNDED" && existingBet.result === "WITHDRAWN") {
        throw new DealerCasinoError("You withdrew from this game and cannot rejoin; the withdrawal remains in the audit history.", "WITHDRAWN_CANNOT_REJOIN");
      }
      throw new DealerCasinoError("You have already joined this game.", "ALREADY_JOINED");
    }

    const [{ playerCount }] = await tx
      .select({ playerCount: sql<number>`count(*)::int` })
      .from(dealerCasinoBetsTable)
      .where(and(
        eq(dealerCasinoBetsTable.gameId, game.id),
        sql`(${dealerCasinoBetsTable.state} <> 'REFUNDED' OR ${dealerCasinoBetsTable.result} IS DISTINCT FROM 'WITHDRAWN')`,
      ));
    if (settings.maxPlayers === null || playerCount >= settings.maxPlayers) {
      throw new DealerCasinoError("The configured player limit has been reached or is not set.", "PLAYER_LIMIT");
    }

    await tx.insert(walletsTable)
      .values({ guildId: game.guildId, userId: input.userId })
      .onConflictDoNothing();
    const [wallet] = await tx
      .update(walletsTable)
      .set({ balance: sql`${walletsTable.balance} - ${input.amount}` })
      .where(and(
        eq(walletsTable.guildId, game.guildId),
        eq(walletsTable.userId, input.userId),
        sql`${walletsTable.balance} >= ${input.amount}`,
      ))
      .returning({ balance: walletsTable.balance });
    if (!wallet) throw new DealerCasinoError("Insufficient funds for this bet.", "INSUFFICIENT_FUNDS");

    const [bet] = await tx.insert(dealerCasinoBetsTable).values({
      gameId: game.id,
      userId: input.userId,
      betAmount: input.amount,
      choice: input.choice ?? null,
    }).returning();
    if (!bet) throw new DealerCasinoError("Bet could not be recorded.", "DATABASE_ERROR");

    await tx.insert(transactionsTable).values({
      guildId: game.guildId,
      userId: input.userId,
      amount: -input.amount,
      reason: `賭場${game.gameType}参加 (賭け: ${input.amount})`,
      relatedUserId: game.dealerId,
      sessionKey: `dealer-casino:${game.id}:bet:${bet.id}:rev:${bet.betRevision}`,
    });
    return bet;
  });
}

/** Atomically adjust an existing recruiting-phase wager and its balance delta. */
export async function updateDealerCasinoBet(input: {
  gameId: number;
  userId: string;
  amount: number;
  choice?: string | null;
}): Promise<DealerCasinoBet> {
  assertPositiveInteger(input.amount, "Bet");
  return db.transaction(async (tx) => {
    const [game] = await tx.select()
      .from(dealerCasinoGamesTable)
      .where(eq(dealerCasinoGamesTable.id, input.gameId))
      .for("update")
      .limit(1);
    if (!game || game.state !== "RECRUITING") {
      throw new DealerCasinoError("This game's entry period is closed.", "GAME_NOT_RECRUITING");
    }
    if (game.dealerId === input.userId) {
      throw new DealerCasinoError("The dealer cannot join their own game.", "DEALER_CANNOT_BET");
    }
    const [settings] = await tx.select()
      .from(dealerCasinoSettingsTable)
      .where(eq(dealerCasinoSettingsTable.guildId, game.guildId))
      .limit(1);
    if (!settings || input.amount < settings.minBet || input.amount > settings.maxBet) {
      throw new DealerCasinoError("Bet is outside the configured range.", "BET_OUT_OF_RANGE");
    }
    const [bet] = await tx.select()
      .from(dealerCasinoBetsTable)
      .where(and(
        eq(dealerCasinoBetsTable.gameId, game.id),
        eq(dealerCasinoBetsTable.userId, input.userId),
      ))
      .for("update")
      .limit(1);
    if (!bet || bet.state !== "ACTIVE") {
      throw new DealerCasinoError("Join the game before changing your bet.", "BET_NOT_FOUND");
    }
    const delta = input.amount - bet.betAmount;
    if (delta > 0) {
      const [wallet] = await tx.update(walletsTable)
        .set({ balance: sql`${walletsTable.balance} - ${delta}` })
        .where(and(
          eq(walletsTable.guildId, game.guildId),
          eq(walletsTable.userId, input.userId),
          sql`${walletsTable.balance} >= ${delta}`,
        ))
        .returning({ balance: walletsTable.balance });
      if (!wallet) throw new DealerCasinoError("Insufficient funds for the increased bet.", "INSUFFICIENT_FUNDS");
    } else if (delta < 0) {
      await tx.insert(walletsTable)
        .values({ guildId: game.guildId, userId: input.userId })
        .onConflictDoNothing();
      const [wallet] = await tx.update(walletsTable)
        .set({ balance: sql`${walletsTable.balance} + ${-delta}` })
        .where(and(
          eq(walletsTable.guildId, game.guildId),
          eq(walletsTable.userId, input.userId),
          sql`${walletsTable.balance} <= ${MAX_POSTGRES_INTEGER - -delta}`,
        ))
        .returning({ balance: walletsTable.balance });
      if (!wallet) throw new DealerCasinoError("Reducing the bet would exceed the wallet balance limit.", "WALLET_OVERFLOW");
    }
    const nextRevision = bet.betRevision + 1;
    const [updated] = await tx.update(dealerCasinoBetsTable)
      .set({
        betAmount: input.amount,
        ...(input.choice !== undefined ? { choice: input.choice } : {}),
        betRevision: nextRevision,
      })
      .where(and(
        eq(dealerCasinoBetsTable.id, bet.id),
        eq(dealerCasinoBetsTable.state, "ACTIVE"),
      ))
      .returning();
    if (!updated) throw new DealerCasinoError("Bet changed concurrently.", "STATE_CONFLICT");
    if (delta !== 0) {
      await tx.insert(transactionsTable).values({
        guildId: game.guildId,
        userId: input.userId,
        amount: -delta,
        reason: `賭場${game.gameType}掛け金変更 (賭け: ${input.amount})`,
        relatedUserId: game.dealerId,
        sessionKey: `dealer-casino:${game.id}:bet:${bet.id}:rev:${nextRevision}`,
      });
    }
    return updated;
  });
}

/** A participant may withdraw only before the dealer closes recruitment. */
export async function withdrawDealerCasinoBet(
  gameId: number,
  userId: string,
): Promise<{ bet: DealerCasinoBet; refunded: number }> {
  return db.transaction(async (tx) => {
    const [game] = await tx.select()
      .from(dealerCasinoGamesTable)
      .where(eq(dealerCasinoGamesTable.id, gameId))
      .for("update")
      .limit(1);
    if (!game || game.state !== "RECRUITING") {
      throw new DealerCasinoError("Participation can only be cancelled during recruitment.", "GAME_NOT_RECRUITING");
    }
    const [bet] = await tx.select()
      .from(dealerCasinoBetsTable)
      .where(and(
        eq(dealerCasinoBetsTable.gameId, gameId),
        eq(dealerCasinoBetsTable.userId, userId),
      ))
      .for("update")
      .limit(1);
    if (!bet || bet.state !== "ACTIVE") {
      throw new DealerCasinoError("No active bet was found for this player.", "BET_NOT_FOUND");
    }
    const [updated] = await tx.update(dealerCasinoBetsTable)
      .set({
        state: "REFUNDED",
        payout: bet.betAmount,
        result: "WITHDRAWN",
        betRevision: bet.betRevision + 1,
      })
      .where(and(
        eq(dealerCasinoBetsTable.id, bet.id),
        eq(dealerCasinoBetsTable.state, "ACTIVE"),
      ))
      .returning();
    if (!updated) throw new DealerCasinoError("Bet changed concurrently.", "STATE_CONFLICT");
    if (game.gameType === "chohan") {
      await tx.insert(dealerCasinoStreaksTable)
        .values({ guildId: game.guildId, userId, winStreak: 0, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [dealerCasinoStreaksTable.guildId, dealerCasinoStreaksTable.userId],
          set: { winStreak: 0, updatedAt: new Date() },
        });
    }
    await tx.insert(walletsTable)
      .values({ guildId: game.guildId, userId })
      .onConflictDoNothing();
    const [wallet] = await tx.update(walletsTable)
      .set({ balance: sql`${walletsTable.balance} + ${bet.betAmount}` })
      .where(and(
        eq(walletsTable.guildId, game.guildId),
        eq(walletsTable.userId, userId),
        sql`${walletsTable.balance} <= ${MAX_POSTGRES_INTEGER - bet.betAmount}`,
      ))
      .returning({ balance: walletsTable.balance });
    if (!wallet) throw new DealerCasinoError("Returning the stake would exceed the wallet balance limit.", "WALLET_OVERFLOW");
    await tx.insert(transactionsTable).values({
      guildId: game.guildId,
      userId,
      amount: bet.betAmount,
      reason: `賭場${game.gameType}参加取消 (賭け: ${bet.betAmount})`,
      relatedUserId: game.dealerId,
      sessionKey: `dealer-casino:${game.id}:bet:${bet.id}:rev:${updated.betRevision}`,
    });
    return { bet: updated, refunded: bet.betAmount };
  });
}

/** Game-state changes only proceed from their expected state. */
export async function transitionDealerCasinoGame(
  gameId: number,
  expectedState: DealerCasinoState,
  nextState: DealerCasinoState,
): Promise<DealerCasinoGame> {
  if (!TRANSITIONS[expectedState]?.includes(nextState)) {
    throw new DealerCasinoError(`Illegal game-state transition: ${expectedState} -> ${nextState}.`, "INVALID_TRANSITION");
  }
  return db.transaction(async (tx) => {
    const [game] = await tx
      .select()
      .from(dealerCasinoGamesTable)
      .where(eq(dealerCasinoGamesTable.id, gameId))
      .for("update")
      .limit(1);
    if (!game) throw new DealerCasinoError("Game not found.", "GAME_NOT_FOUND");
    if (game.gameType === "poker" && nextState === "PLAYING") {
      throw new DealerCasinoError("Use dealDealerCasinoPoker to atomically persist poker cards and the deadline.", "USE_POKER_DEAL_API");
    }
    if (nextState === "RESULT") {
      throw new DealerCasinoError("Use recordDealerCasinoResult to lock the immutable result before settlement.", "USE_RESULT_API");
    }
    if (game.state !== expectedState) {
      throw new DealerCasinoError(`Game is ${game.state}, not ${expectedState}.`, "STATE_CONFLICT");
    }
    const [updated] = await tx
      .update(dealerCasinoGamesTable)
      .set({
        state: nextState,
        endedAt: nextState === "FINISHED" ? new Date() : game.endedAt,
      })
      .where(and(
        eq(dealerCasinoGamesTable.id, gameId),
        eq(dealerCasinoGamesTable.state, expectedState),
      ))
      .returning();
    if (!updated) throw new DealerCasinoError("Game state changed concurrently.", "STATE_CONFLICT");
    return updated;
  });
}

export async function setDealerCasinoPanelMessage(
  gameId: number,
  messageId: string,
): Promise<void> {
  const [updated] = await db
    .update(dealerCasinoGamesTable)
    .set({ panelMessageId: messageId })
    .where(and(
      eq(dealerCasinoGamesTable.id, gameId),
      eq(dealerCasinoGamesTable.state, "RECRUITING"),
    ))
    .returning({ id: dealerCasinoGamesTable.id });
  if (!updated) throw new DealerCasinoError("Recruiting game not found.", "GAME_NOT_RECRUITING");
}

/** The first committed result is immutable; an attempted reroll is rejected. */
export async function recordDealerCasinoResult(
  gameId: number,
  result: Record<string, unknown>,
): Promise<DealerCasinoGame> {
  return db.transaction(async (tx) => {
    const [game] = await tx
      .select()
      .from(dealerCasinoGamesTable)
      .where(eq(dealerCasinoGamesTable.id, gameId))
      .for("update")
      .limit(1);
    if (!game) throw new DealerCasinoError("Game not found.", "GAME_NOT_FOUND");
    if (game.state !== "PLAYING" || game.result !== null) {
      throw new DealerCasinoError("A result can only be recorded once for a PLAYING game.", "RESULT_LOCKED");
    }
    if (game.gameType === "poker" && (!game.dealerCards || !game.actionDeadline)) {
      throw new DealerCasinoError("Poker deal data is missing; refusing to publish or settle an undealt game.", "DEAL_NOT_FOUND");
    }
    const [updated] = await tx
      .update(dealerCasinoGamesTable)
      .set({ result, state: "RESULT" })
      .where(and(eq(dealerCasinoGamesTable.id, gameId), eq(dealerCasinoGamesTable.state, "PLAYING")))
      .returning();
    if (!updated) throw new DealerCasinoError("Game result was recorded concurrently.", "RESULT_LOCKED");
    return updated;
  });
}

const VALID_BET_RESULTS = new Set<DealerCasinoBetResult>(["WON", "LOST", "DRAW", "FOLDED"]);
const MAX_NUMERIC_MULTIPLIER = 999_999.999999;

function normalizeOutcome(value: unknown): DealerCasinoOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DealerCasinoError("A locked game result contains a malformed outcome.", "INVALID_LOCKED_RESULT");
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.userId !== "string" || !raw.userId ||
      typeof raw.result !== "string" || !VALID_BET_RESULTS.has(raw.result as DealerCasinoBetResult) ||
      typeof raw.payout !== "number") {
    throw new DealerCasinoError("A locked game result contains a malformed outcome.", "INVALID_LOCKED_RESULT");
  }
  assertSafePayout(raw.payout);
  if (raw.choice !== undefined && raw.choice !== null && typeof raw.choice !== "string") {
    throw new DealerCasinoError("A locked game result contains an invalid choice.", "INVALID_LOCKED_RESULT");
  }
  if (raw.cards !== undefined && raw.cards !== null &&
      (!Array.isArray(raw.cards) || raw.cards.some((card) => typeof card !== "string"))) {
    throw new DealerCasinoError("A locked game result contains invalid cards.", "INVALID_LOCKED_RESULT");
  }
  if (raw.handRank !== undefined && raw.handRank !== null && typeof raw.handRank !== "string") {
    throw new DealerCasinoError("A locked game result contains an invalid hand rank.", "INVALID_LOCKED_RESULT");
  }
  if (raw.winStreak !== undefined && raw.winStreak !== null &&
      (!Number.isSafeInteger(raw.winStreak) || (raw.winStreak as number) < 0 || (raw.winStreak as number) > MAX_POSTGRES_INTEGER)) {
    throw new DealerCasinoError("A locked game result contains an invalid win streak.", "INVALID_LOCKED_RESULT");
  }
  if (raw.multiplier !== undefined && raw.multiplier !== null &&
      (typeof raw.multiplier !== "number" ||
        !Number.isFinite(raw.multiplier) ||
        raw.multiplier < 0 ||
        raw.multiplier > MAX_NUMERIC_MULTIPLIER ||
        Math.round(raw.multiplier * 1_000_000) / 1_000_000 !== raw.multiplier)) {
    throw new DealerCasinoError("A locked game result contains an invalid payout multiplier.", "INVALID_LOCKED_RESULT");
  }
  return {
    userId: raw.userId,
    result: raw.result as DealerCasinoBetResult,
    payout: raw.payout,
    choice: raw.choice as string | null | undefined ?? null,
    cards: raw.cards as string[] | null | undefined ?? null,
    handRank: raw.handRank as string | null | undefined ?? null,
    winStreak: raw.winStreak as number | null | undefined ?? null,
    multiplier: raw.multiplier as number | null | undefined ?? null,
  };
}

function normalizeOutcomeSet(values: unknown, errorCode: string): DealerCasinoOutcome[] {
  if (!Array.isArray(values)) {
    throw new DealerCasinoError("Outcomes must be an array.", errorCode);
  }
  const normalized = values.map(normalizeOutcome);
  const seen = new Set<string>();
  for (const outcome of normalized) {
    if (seen.has(outcome.userId)) {
      throw new DealerCasinoError("Each player must have exactly one outcome.", errorCode);
    }
    seen.add(outcome.userId);
  }
  return normalized.sort((a, b) => a.userId.localeCompare(b.userId));
}

function outcomesForLockedResult(result: Record<string, unknown> | null): DealerCasinoOutcome[] {
  if (!result || !Array.isArray(result.outcomes)) {
    throw new DealerCasinoError("The game has no immutable outcome list to settle.", "INVALID_LOCKED_RESULT");
  }
  return normalizeOutcomeSet(result.outcomes, "INVALID_LOCKED_RESULT");
}

function assertOutcomesMatchLockedResult(
  supplied: DealerCasinoOutcome[],
  locked: DealerCasinoOutcome[],
): void {
  const normalizedSupplied = normalizeOutcomeSet(supplied, "OUTCOME_MISMATCH");
  if (JSON.stringify(normalizedSupplied) !== JSON.stringify(locked)) {
    throw new DealerCasinoError("Settlement outcomes must exactly match the immutable game result.", "OUTCOME_MISMATCH");
  }
}

/** Persist private hand details/action, only while that player can still act. */
export async function updateDealerCasinoPlay(
  gameId: number,
  userId: string,
  changes: DealerCasinoPlayUpdate,
): Promise<DealerCasinoBet> {
  return db.transaction(async (tx) => {
    const [game] = await tx
      .select()
      .from(dealerCasinoGamesTable)
      .where(eq(dealerCasinoGamesTable.id, gameId))
      .for("update")
      .limit(1);
    if (!game || game.state !== "PLAYING" || game.gameType !== "poker") {
      throw new DealerCasinoError("Poker is not accepting player actions.", "GAME_NOT_PLAYING");
    }
    const [bet] = await tx
      .select()
      .from(dealerCasinoBetsTable)
      .where(and(
        eq(dealerCasinoBetsTable.gameId, gameId),
        eq(dealerCasinoBetsTable.userId, userId),
      ))
      .for("update")
      .limit(1);
    if (!bet || bet.state !== "ACTIVE") {
      throw new DealerCasinoError("This player cannot act in the current game.", "PLAYER_NOT_ACTIVE");
    }
    if (changes.playerAction !== undefined && bet.playerAction !== null &&
        changes.playerAction !== bet.playerAction) {
      throw new DealerCasinoError("This player has already chosen a different action.", "PLAYER_ALREADY_ACTED");
    }
    const update: Partial<DealerCasinoBet> = {};
    if (changes.cards !== undefined) update.cards = changes.cards;
    if (changes.handRank !== undefined) update.handRank = changes.handRank;
    if (changes.playerAction !== undefined) {
      update.playerAction = changes.playerAction;
      if (changes.playerAction === "FOLDED") update.state = "FOLDED";
    }
    const [saved] = await tx
      .update(dealerCasinoBetsTable)
      .set(update)
      .where(and(
        eq(dealerCasinoBetsTable.id, bet.id),
        eq(dealerCasinoBetsTable.state, "ACTIVE"),
      ))
      .returning();
    if (!saved) throw new DealerCasinoError("Player action changed concurrently.", "PLAYER_NOT_ACTIVE");
    return saved;
  });
}

/**
 * Atomically store the dealer's private cards, every player's hand, and the
 * action deadline while changing CLOSED -> PLAYING. The dealer's cards remain
 * in a dedicated private DB column and are not copied to the public result.
 */
export async function dealDealerCasinoPoker(
  gameId: number,
  dealerCards: string[],
  playerHands: DealerCasinoPlayerHand[],
  actionDeadline: Date,
): Promise<DealerCasinoGame> {
  if (dealerCards.length !== 3 || dealerCards.some((card) => !card.trim())) {
    throw new DealerCasinoError("The dealer hand must contain exactly three valid cards.", "INVALID_DEAL");
  }
  if (!(actionDeadline instanceof Date) || !Number.isFinite(actionDeadline.getTime())) {
    throw new DealerCasinoError("A valid poker action deadline is required.", "INVALID_DEADLINE");
  }
  const playersById = new Map<string, DealerCasinoPlayerHand>();
  for (const hand of playerHands) {
    if (!hand.userId || playersById.has(hand.userId)) {
      throw new DealerCasinoError("Each active participant must have exactly one hand.", "INVALID_DEAL");
    }
    if (hand.cards.length !== 3 || hand.cards.some((card) => !card.trim()) || !hand.handRank.trim()) {
      throw new DealerCasinoError("Each player hand must have three valid cards and a hand rank.", "INVALID_DEAL");
    }
    playersById.set(hand.userId, hand);
  }
  const allCards = [...dealerCards, ...playerHands.flatMap((hand) => hand.cards)];
  if (new Set(allCards).size !== allCards.length) {
    throw new DealerCasinoError("A card appears more than once in this deal.", "DUPLICATE_CARD");
  }

  return db.transaction(async (tx) => {
    const [game] = await tx.select()
      .from(dealerCasinoGamesTable)
      .where(eq(dealerCasinoGamesTable.id, gameId))
      .for("update")
      .limit(1);
    if (!game) throw new DealerCasinoError("Game not found.", "GAME_NOT_FOUND");
    if (game.gameType !== "poker" || game.state !== "CLOSED") {
      throw new DealerCasinoError("Cards can only be dealt to a closed poker game.", "GAME_NOT_CLOSED");
    }
    if (game.dealerCards !== null || game.actionDeadline !== null) {
      throw new DealerCasinoError("This game already has a persisted deal.", "DEAL_ALREADY_RECORDED");
    }

    const bets = await tx.select()
      .from(dealerCasinoBetsTable)
      .where(eq(dealerCasinoBetsTable.gameId, gameId))
      .orderBy(asc(dealerCasinoBetsTable.id))
      .for("update");
    const activeBets = bets.filter((bet) => !(bet.state === "REFUNDED" && bet.result === "WITHDRAWN"));
    if (activeBets.some((bet) => bet.state !== "ACTIVE") || activeBets.length !== playersById.size) {
      throw new DealerCasinoError("A hand is required for every active bet and no other participants.", "PARTICIPANT_MISMATCH");
    }
    for (const bet of activeBets) {
      if (!playersById.has(bet.userId)) {
        throw new DealerCasinoError("A hand is required for every active bet and no other participants.", "PARTICIPANT_MISMATCH");
      }
    }
    for (const bet of activeBets) {
      const hand = playersById.get(bet.userId)!;
      const [saved] = await tx.update(dealerCasinoBetsTable)
        .set({
          cards: hand.cards,
          handRank: hand.handRank,
          playerAction: null,
        })
        .where(and(
          eq(dealerCasinoBetsTable.id, bet.id),
          eq(dealerCasinoBetsTable.state, "ACTIVE"),
        ))
        .returning({ id: dealerCasinoBetsTable.id });
      if (!saved) throw new DealerCasinoError("A player hand changed while dealing.", "STATE_CONFLICT");
    }
    const [playing] = await tx.update(dealerCasinoGamesTable)
      .set({
        dealerCards,
        actionDeadline,
        state: "PLAYING",
      })
      .where(and(
        eq(dealerCasinoGamesTable.id, gameId),
        eq(dealerCasinoGamesTable.state, "CLOSED"),
      ))
      .returning();
    if (!playing) throw new DealerCasinoError("Game changed concurrently while dealing.", "STATE_CONFLICT");
    return playing;
  });
}

/**
 * Idempotently refund every non-withdrawn participant. Game lock serializes
 * cancellation with joining, transitions, and settlement; wallet/ledger
 * changes share the same transaction, so a crash cannot partly refund a game.
 */
export async function cancelDealerCasinoGame(
  gameId: number,
): Promise<{ game: DealerCasinoGame; refundedCount: number; alreadyCancelled: boolean }> {
  return db.transaction(async (tx) => {
    const [game] = await tx
      .select()
      .from(dealerCasinoGamesTable)
      .where(eq(dealerCasinoGamesTable.id, gameId))
      .for("update")
      .limit(1);
    if (!game) throw new DealerCasinoError("Game not found.", "GAME_NOT_FOUND");
    if (game.state === "CANCELLED") {
      return { game, refundedCount: 0, alreadyCancelled: true };
    }
    if (game.state === "RESULT" || game.state === "PAYOUT") {
      throw new DealerCasinoError("The result is locked; settle the game instead of cancelling/refunding it.", "RESULT_LOCKED");
    }
    if (!ACTIVE_STATES.includes(game.state as DealerCasinoState)) {
      throw new DealerCasinoError("A completed game cannot be cancelled.", "GAME_FINISHED");
    }

    const bets = await tx
      .select()
      .from(dealerCasinoBetsTable)
      .where(eq(dealerCasinoBetsTable.gameId, gameId))
      .for("update");
    let refundedCount = 0;
    for (const bet of bets) {
      if (bet.state === "REFUNDED") continue;
      const [updatedBet] = await tx
        .update(dealerCasinoBetsTable)
        .set({ state: "REFUNDED", payout: bet.betAmount, result: "REFUNDED" })
        .where(and(
          eq(dealerCasinoBetsTable.id, bet.id),
          sql`${dealerCasinoBetsTable.state} <> 'REFUNDED'`,
        ))
        .returning({ id: dealerCasinoBetsTable.id });
      if (!updatedBet) continue;
      await tx.insert(walletsTable)
        .values({ guildId: game.guildId, userId: bet.userId })
        .onConflictDoNothing();
      const [wallet] = await tx.update(walletsTable)
        .set({ balance: sql`${walletsTable.balance} + ${bet.betAmount}` })
        .where(and(
          eq(walletsTable.guildId, game.guildId),
          eq(walletsTable.userId, bet.userId),
          sql`${walletsTable.balance} <= ${MAX_POSTGRES_INTEGER - bet.betAmount}`,
        ))
        .returning({ balance: walletsTable.balance });
      if (!wallet) throw new DealerCasinoError("Refund would exceed the wallet balance limit.", "WALLET_OVERFLOW");
      await tx.insert(transactionsTable).values({
        guildId: game.guildId,
        userId: bet.userId,
        amount: bet.betAmount,
        reason: `賭場${game.gameType}取消返金 (賭け: ${bet.betAmount})`,
        relatedUserId: game.dealerId,
        sessionKey: `dealer-casino:${game.id}:refund:${bet.id}`,
      });
      refundedCount += 1;
    }
    const [cancelled] = await tx
      .update(dealerCasinoGamesTable)
      .set({ state: "CANCELLED", endedAt: new Date() })
      .where(and(
        eq(dealerCasinoGamesTable.id, gameId),
        inArray(dealerCasinoGamesTable.state, ACTIVE_STATES),
      ))
      .returning();
    if (!cancelled) throw new DealerCasinoError("Game changed concurrently during cancellation.", "STATE_CONFLICT");
    return { game: cancelled, refundedCount, alreadyCancelled: false };
  });
}

/**
 * Pays every eligible participant exactly once. The game state, each settlement record,
 * wallet credit, transaction-ledger row, and dealer stats commit atomically.
 * Payout values are gross credits (stake return plus winnings); losses/folds
 * are zero because their stakes were debited when they joined.
 */
export async function settleDealerCasinoGame(
  gameId: number,
  outcomes: DealerCasinoOutcome[],
): Promise<{
  game: DealerCasinoGame;
  settlements: typeof dealerCasinoSettlementsTable.$inferSelect[];
  alreadySettled: boolean;
}> {
  return db.transaction(async (tx) => {
    const [game] = await tx
      .select()
      .from(dealerCasinoGamesTable)
      .where(eq(dealerCasinoGamesTable.id, gameId))
      .for("update")
      .limit(1);
    if (!game) throw new DealerCasinoError("Game not found.", "GAME_NOT_FOUND");
    if (game.state !== "RESULT" && game.state !== "PAYOUT" && game.state !== "FINISHED") {
      throw new DealerCasinoError("Only a game with a locked result can be settled.", "GAME_NOT_SETTLEABLE");
    }
    const lockedOutcomes = outcomesForLockedResult(game.result);
    assertOutcomesMatchLockedResult(outcomes, lockedOutcomes);
    const allBets = await tx
      .select()
      .from(dealerCasinoBetsTable)
      .where(eq(dealerCasinoBetsTable.gameId, gameId))
      .orderBy(asc(dealerCasinoBetsTable.id))
      .for("update");
    if (allBets.some((bet) => bet.state === "REFUNDED" && bet.result !== "WITHDRAWN")) {
      throw new DealerCasinoError("A non-withdrawal refunded bet cannot be settled.", "BET_ALREADY_REFUNDED");
    }
    const bets = allBets.filter(
      (bet) => !(bet.state === "REFUNDED" && bet.result === "WITHDRAWN"),
    );

    if (game.state === "FINISHED") {
      const settlements = await tx.select().from(dealerCasinoSettlementsTable)
        .where(eq(dealerCasinoSettlementsTable.gameId, gameId));
      if (settlements.length !== lockedOutcomes.length || bets.length !== lockedOutcomes.length) {
        throw new DealerCasinoError("Finished-game settlement rows do not match the locked outcomes.", "SETTLEMENT_MISMATCH");
      }
      const outcomeByUser = new Map(lockedOutcomes.map((outcome) => [outcome.userId, outcome]));
      const settlementByUser = new Map(settlements.map((entry) => [entry.userId, entry]));
      for (const bet of bets) {
        const expected = outcomeByUser.get(bet.userId);
        const settled = settlementByUser.get(bet.userId);
        if (!expected || !settled ||
            settled.betId !== bet.id ||
            settled.result !== expected.result ||
            settled.payout !== expected.payout ||
            bet.state !== expected.result ||
            bet.result !== expected.result ||
            bet.payout !== expected.payout) {
          throw new DealerCasinoError("Finished-game stored payouts/results differ from the immutable result.", "SETTLEMENT_MISMATCH");
        }
      }
      if (settlementByUser.size !== outcomeByUser.size) {
        throw new DealerCasinoError("Finished-game settlement contains unexpected participants.", "SETTLEMENT_MISMATCH");
      }
      return { game, settlements, alreadySettled: true };
    }
    if (bets.some((bet) => bet.state !== "ACTIVE" && bet.state !== "FOLDED")) {
      throw new DealerCasinoError("Only active or folded participants may be settled.", "INVALID_BET_STATE");
    }
    if (outcomes.length !== bets.length) {
      throw new DealerCasinoError("An outcome is required for every participant.", "OUTCOME_MISMATCH");
    }
    const outcomesByUser = new Map<string, DealerCasinoOutcome>();
    for (const outcome of outcomes) {
      if (outcomesByUser.has(outcome.userId) || !bets.some((bet) => bet.userId === outcome.userId)) {
        throw new DealerCasinoError("Outcomes must contain each participant exactly once.", "OUTCOME_MISMATCH");
      }
      assertSafePayout(outcome.payout);
      outcomesByUser.set(outcome.userId, outcome);
    }

    if (game.state === "RESULT") {
      const [payoutState] = await tx
        .update(dealerCasinoGamesTable)
        .set({ state: "PAYOUT" })
        .where(and(
          eq(dealerCasinoGamesTable.id, gameId),
          eq(dealerCasinoGamesTable.state, "RESULT"),
        ))
        .returning({ id: dealerCasinoGamesTable.id });
      if (!payoutState) throw new DealerCasinoError("Game state changed concurrently.", "STATE_CONFLICT");
    }

    const completed: typeof dealerCasinoSettlementsTable.$inferSelect[] = [];
    for (const bet of bets) {
      const outcome = outcomesByUser.get(bet.userId)!;
      if (bet.state === "REFUNDED") {
        throw new DealerCasinoError("A refunded bet cannot be settled.", "BET_ALREADY_REFUNDED");
      }
      if (outcome.result === "DRAW" && outcome.payout !== bet.betAmount) {
        throw new DealerCasinoError("A draw must return the full stake.", "INVALID_PAYOUT");
      }
      if ((outcome.result === "LOST" || outcome.result === "FOLDED") && outcome.payout !== 0) {
        throw new DealerCasinoError("A loss or fold cannot receive a payout.", "INVALID_PAYOUT");
      }
      if (outcome.result === "WON" && outcome.payout < bet.betAmount) {
        throw new DealerCasinoError("A winning gross payout cannot be lower than the stake.", "INVALID_PAYOUT");
      }
      if ((bet.state === "FOLDED") !== (outcome.result === "FOLDED")) {
        throw new DealerCasinoError("Folded bet state must match the locked result.", "INVALID_BET_STATE");
      }

      const [settlement] = await tx.insert(dealerCasinoSettlementsTable).values({
        gameId,
        userId: bet.userId,
        betId: bet.id,
        payout: outcome.payout,
        result: outcome.result,
        streakUpdated: game.gameType === "chohan" && outcome.result !== "WON" ? 1 : 0,
      }).onConflictDoNothing().returning();
      if (!settlement) {
        throw new DealerCasinoError("A participant settlement already exists; refusing duplicate payout.", "DUPLICATE_SETTLEMENT");
      }

      const [updatedBet] = await tx
        .update(dealerCasinoBetsTable)
        .set({
          state: outcome.result,
          result: outcome.result,
          payout: outcome.payout,
          choice: outcome.choice ?? bet.choice,
          cards: outcome.cards ?? bet.cards,
          handRank: outcome.handRank ?? bet.handRank,
          winStreak: outcome.winStreak ?? bet.winStreak,
          multiplier: outcome.multiplier ?? bet.multiplier,
        })
        .where(and(eq(dealerCasinoBetsTable.id, bet.id), sql`${dealerCasinoBetsTable.state} <> 'REFUNDED'`))
        .returning({ id: dealerCasinoBetsTable.id });
      if (!updatedBet) throw new DealerCasinoError("Could not finalize a participant's result.", "BET_UPDATE_FAILED");

      if (outcome.payout > 0) {
        await tx.insert(walletsTable)
          .values({ guildId: game.guildId, userId: bet.userId })
          .onConflictDoNothing();
        const [wallet] = await tx.update(walletsTable)
          .set({ balance: sql`${walletsTable.balance} + ${outcome.payout}` })
          .where(and(
            eq(walletsTable.guildId, game.guildId),
            eq(walletsTable.userId, bet.userId),
            sql`${walletsTable.balance} <= ${MAX_POSTGRES_INTEGER - outcome.payout}`,
          ))
          .returning({ balance: walletsTable.balance });
        if (!wallet) {
          throw new DealerCasinoError("Payout would exceed the wallet balance limit.", "WALLET_OVERFLOW");
        }
        await tx.insert(transactionsTable).values({
          guildId: game.guildId,
          userId: bet.userId,
          amount: outcome.payout,
          reason: `賭場${game.gameType}払戻 (賭け: ${bet.betAmount})`,
          relatedUserId: game.dealerId,
          sessionKey: `dealer-casino:${game.id}:payout:${bet.id}`,
        });
      }
      if (outcome.result === "LOST" || outcome.result === "FOLDED") {
        // Stakes were already debited on entry. A losing stake belongs to the
        // dealer, not the system; keep this credit in the same settlement tx.
        await tx.insert(walletsTable)
          .values({ guildId: game.guildId, userId: game.dealerId })
          .onConflictDoNothing();
        const [dealerWallet] = await tx.update(walletsTable)
          .set({ balance: sql`${walletsTable.balance} + ${bet.betAmount}` })
          .where(and(
            eq(walletsTable.guildId, game.guildId),
            eq(walletsTable.userId, game.dealerId),
            sql`${walletsTable.balance} <= ${MAX_POSTGRES_INTEGER - bet.betAmount}`,
          ))
          .returning({ balance: walletsTable.balance });
        if (!dealerWallet) {
          throw new DealerCasinoError("Dealer credit would exceed the wallet balance limit.", "WALLET_OVERFLOW");
        }
        await tx.insert(transactionsTable).values({
          guildId: game.guildId,
          userId: game.dealerId,
          amount: bet.betAmount,
          reason: `賭場${game.gameType}敗者掛け金受取 (参加者: ${bet.userId})`,
          relatedUserId: bet.userId,
          sessionKey: `dealer-casino:${game.id}:dealer-loss:${bet.id}`,
        });
      }
      if (game.gameType === "chohan" && outcome.result !== "WON") {
        await tx.insert(dealerCasinoStreaksTable).values({
          guildId: game.guildId,
          userId: bet.userId,
          winStreak: 0,
          updatedAt: new Date(),
        }).onConflictDoUpdate({
          target: [dealerCasinoStreaksTable.guildId, dealerCasinoStreaksTable.userId],
          set: { winStreak: 0, updatedAt: new Date() },
        });
      }
      completed.push(settlement);
    }

    const [finished] = await tx
      .update(dealerCasinoGamesTable)
      .set({ state: "FINISHED", endedAt: new Date() })
      .where(and(
        eq(dealerCasinoGamesTable.id, gameId),
        eq(dealerCasinoGamesTable.state, "PAYOUT"),
      ))
      .returning();
    if (!finished) throw new DealerCasinoError("Game could not be marked finished.", "STATE_CONFLICT");

    const playerCount = bets.length;
    await tx.insert(dealerCasinoStatsTable).values({
      guildId: game.guildId,
      userId: game.dealerId,
      chohanGames: game.gameType === "chohan" ? 1 : 0,
      pokerGames: game.gameType === "poker" ? 1 : 0,
      playersServed: playerCount,
    }).onConflictDoUpdate({
      target: [dealerCasinoStatsTable.guildId, dealerCasinoStatsTable.userId],
      set: {
        chohanGames: sql`${dealerCasinoStatsTable.chohanGames} + ${game.gameType === "chohan" ? 1 : 0}`,
        pokerGames: sql`${dealerCasinoStatsTable.pokerGames} + ${game.gameType === "poker" ? 1 : 0}`,
        playersServed: sql`${dealerCasinoStatsTable.playersServed} + ${playerCount}`,
        updatedAt: new Date(),
      },
    });
    return { game: finished, settlements: completed, alreadySettled: false };
  });
}

function assertSafePayout(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_POSTGRES_INTEGER) {
    throw new DealerCasinoError("Payout must be a non-negative safe integer.", "INVALID_PAYOUT");
  }
}

export async function getDealerCasinoStreak(
  guildId: string,
  userId: string,
): Promise<{ configured: boolean; winStreak: number }> {
  const [settings] = await db.select()
    .from(dealerCasinoSettingsTable)
    .where(eq(dealerCasinoSettingsTable.guildId, guildId))
    .limit(1);
  if (!settings || settings.streakRetentionSeconds === null) {
    return { configured: false, winStreak: 0 };
  }
  const [streak] = await db.select()
    .from(dealerCasinoStreaksTable)
    .where(and(
      eq(dealerCasinoStreaksTable.guildId, guildId),
      eq(dealerCasinoStreaksTable.userId, userId),
    ))
    .limit(1);
  if (!streak) return { configured: true, winStreak: 0 };
  if (Date.now() - streak.updatedAt.getTime() > settings.streakRetentionSeconds * 1000) {
    return { configured: true, winStreak: 0 };
  }
  return { configured: true, winStreak: streak.winStreak };
}

/** Persistently clear a player's consecutive 丁半 wins for this guild. */
export async function resetDealerCasinoChohanStreak(
  guildId: string,
  userId: string,
): Promise<void> {
  await db.insert(dealerCasinoStreaksTable)
    .values({ guildId, userId, winStreak: 0, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [dealerCasinoStreaksTable.guildId, dealerCasinoStreaksTable.userId],
      set: { winStreak: 0, updatedAt: new Date() },
    });
}

/** Apply the winner's continue/cash-out choice once, or reset on a loss. */
export async function applyDealerCasinoChohanStreakDecision(
  gameId: number,
  userId: string,
  decision: ChohanStreakDecision,
): Promise<{ winStreak: number; alreadyApplied: boolean }> {
  return db.transaction(async (tx) => {
    const [game] = await tx.select()
      .from(dealerCasinoGamesTable)
      .where(eq(dealerCasinoGamesTable.id, gameId))
      .for("update")
      .limit(1);
    if (!game || game.state !== "FINISHED" || game.gameType !== "chohan") {
      throw new DealerCasinoError("A finished 丁半 game is required.", "GAME_NOT_FINISHED");
    }
    const [settlement] = await tx.select()
      .from(dealerCasinoSettlementsTable)
      .where(and(
        eq(dealerCasinoSettlementsTable.gameId, gameId),
        eq(dealerCasinoSettlementsTable.userId, userId),
      ))
      .for("update")
      .limit(1);
    if (!settlement) throw new DealerCasinoError("Player settlement not found.", "SETTLEMENT_NOT_FOUND");
    const isWin = settlement.result === "WON";
    if (isWin && decision === "loss") {
      throw new DealerCasinoError("A winning player must continue or cash out.", "INVALID_STREAK_DECISION");
    }
    if (!isWin && decision !== "loss") {
      throw new DealerCasinoError("Only a winner may continue a streak or cash out.", "INVALID_STREAK_DECISION");
    }
    const [settings] = await tx.select()
      .from(dealerCasinoSettingsTable)
      .where(eq(dealerCasinoSettingsTable.guildId, game.guildId))
      .limit(1);
    if (!settings || settings.streakRetentionSeconds === null) {
      throw new DealerCasinoError("Streak retention time is not configured.", "SETTINGS_REQUIRED");
    }

    const [marked] = await tx.update(dealerCasinoSettlementsTable)
      .set({ streakUpdated: 1 })
      .where(and(
        eq(dealerCasinoSettlementsTable.id, settlement.id),
        eq(dealerCasinoSettlementsTable.streakUpdated, 0),
      ))
      .returning({ id: dealerCasinoSettlementsTable.id });
    if (!marked) {
      const [existing] = await tx.select({ winStreak: dealerCasinoStreaksTable.winStreak })
        .from(dealerCasinoStreaksTable)
        .where(and(
          eq(dealerCasinoStreaksTable.guildId, game.guildId),
          eq(dealerCasinoStreaksTable.userId, userId),
        ))
        .limit(1);
      return { winStreak: existing?.winStreak ?? 0, alreadyApplied: true };
    }

    const [current] = await tx.select()
      .from(dealerCasinoStreaksTable)
      .where(and(
        eq(dealerCasinoStreaksTable.guildId, game.guildId),
        eq(dealerCasinoStreaksTable.userId, userId),
      ))
      .for("update")
      .limit(1);
    const inWindow = current &&
      Date.now() - current.updatedAt.getTime() <= settings.streakRetentionSeconds * 1000;
    const nextCount = decision === "continue"
      ? (inWindow ? current.winStreak : 0) + 1
      : 0;
    await tx.insert(dealerCasinoStreaksTable).values({
      guildId: game.guildId,
      userId,
      winStreak: nextCount,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: [dealerCasinoStreaksTable.guildId, dealerCasinoStreaksTable.userId],
      set: { winStreak: nextCount, updatedAt: new Date() },
    });
    return { winStreak: nextCount, alreadyApplied: false };
  });
}

export async function getDealerCasinoStats(
  guildId: string,
  userId: string,
): Promise<{ chohanGames: number; pokerGames: number; playersServed: number }> {
  const [stats] = await db.select()
    .from(dealerCasinoStatsTable)
    .where(and(
      eq(dealerCasinoStatsTable.guildId, guildId),
      eq(dealerCasinoStatsTable.userId, userId),
    ))
    .limit(1);
  return {
    chohanGames: stats?.chohanGames ?? 0,
    pokerGames: stats?.pokerGames ?? 0,
    playersServed: stats?.playersServed ?? 0,
  };
}