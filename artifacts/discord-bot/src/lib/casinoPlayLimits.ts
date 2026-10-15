import { and, eq, sql } from "drizzle-orm";
import {
  casinoDailyPlayCountsTable,
  casinoPlayLimitsTable,
  db,
  walletsTable,
} from "@workspace/db";

export const CASINO_LIMITED_GAMES = [
  "slot",
  "blackjack",
  "highlow",
  "baccarat",
  "poker",
] as const;

export type CasinoLimitedGame = (typeof CASINO_LIMITED_GAMES)[number];

export const CASINO_GAME_LABELS: Record<CasinoLimitedGame, string> = {
  slot: "スロット",
  blackjack: "ブラックジャック",
  highlow: "ハイアンドロー",
  baccarat: "バカラ",
  poker: "ポーカー",
};

export interface CasinoPlayLimit {
  game: CasinoLimitedGame;
  dailyLimit: number | null;
}

export type StartCasinoPlayResult =
  | { ok: true; balance: number; used: number | null; limit: number | null }
  | { ok: false; reason: "insufficient_funds" }
  | { ok: false; reason: "daily_limit_reached"; limit: number };

/** Return the calendar date in Japan Standard Time, e.g. 2026-08-20. */
export function jstDateString(now = new Date()): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Return the following midnight in Japan Standard Time. */
export function nextJstMidnight(now = new Date()): Date {
  const shifted = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const nextMidnightUtc = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() + 1,
  );
  return new Date(nextMidnightUtc - 9 * 60 * 60 * 1000);
}

export function dailyLimitReachedMessage(game: CasinoLimitedGame, limit: number): string {
  const resetUnix = Math.floor(nextJstMidnight().getTime() / 1000);
  return [
    `❌ ${CASINO_GAME_LABELS[game]}は本日のプレイ上限（**${limit}回**）に達しています。`,
    `次回リセット: <t:${resetUnix}:R>（毎日 0:00 JST）`,
  ].join("\n");
}

/** Read all configured limits. A missing row is represented as null (unlimited). */
export async function getCasinoPlayLimits(guildId: string): Promise<CasinoPlayLimit[]> {
  const rows = await db
    .select()
    .from(casinoPlayLimitsTable)
    .where(eq(casinoPlayLimitsTable.guildId, guildId));
  const byGame = new Map(rows.map((row) => [row.game, row.dailyLimit]));
  return CASINO_LIMITED_GAMES.map((game) => ({
    game,
    dailyLimit: byGame.get(game) ?? null,
  }));
}

/** Set one game's cap. null removes the cap and restores unlimited play. */
export async function setCasinoPlayLimit(
  guildId: string,
  game: CasinoLimitedGame,
  dailyLimit: number | null,
): Promise<void> {
  if (dailyLimit === null) {
    await db
      .delete(casinoPlayLimitsTable)
      .where(and(eq(casinoPlayLimitsTable.guildId, guildId), eq(casinoPlayLimitsTable.game, game)));
    return;
  }

  await db
    .insert(casinoPlayLimitsTable)
    .values({ guildId, game, dailyLimit })
    .onConflictDoUpdate({
      target: [casinoPlayLimitsTable.guildId, casinoPlayLimitsTable.game],
      set: { dailyLimit },
    });
}

/**
 * Atomically reserve a daily play slot and debit the bet. It is deliberately
 * called only for a new paid round; continuation actions must not use it.
 */
export async function tryStartCasinoPlay(
  guildId: string,
  userId: string,
  game: CasinoLimitedGame,
  bet: number,
  now = new Date(),
): Promise<StartCasinoPlayResult> {
  const date = jstDateString(now);

  return db.transaction(async (tx) => {
    const [configuredLimit] = await tx
      .select({ dailyLimit: casinoPlayLimitsTable.dailyLimit })
      .from(casinoPlayLimitsTable)
      .where(and(eq(casinoPlayLimitsTable.guildId, guildId), eq(casinoPlayLimitsTable.game, game)));
    const limit = configuredLimit?.dailyLimit ?? null;

    let used: number | null = null;
    if (limit !== null) {
      const [count] = await tx
        .insert(casinoDailyPlayCountsTable)
        .values({ guildId, userId, game, date, playCount: 1 })
        .onConflictDoUpdate({
          target: [
            casinoDailyPlayCountsTable.guildId,
            casinoDailyPlayCountsTable.userId,
            casinoDailyPlayCountsTable.game,
            casinoDailyPlayCountsTable.date,
          ],
          set: { playCount: sql`${casinoDailyPlayCountsTable.playCount} + 1` },
          where: sql`${casinoDailyPlayCountsTable.playCount} < ${limit}`,
        })
        .returning({ playCount: casinoDailyPlayCountsTable.playCount });

      if (!count) return { ok: false, reason: "daily_limit_reached", limit };
      used = count.playCount;
    }

    const [wallet] = await tx
      .update(walletsTable)
      .set({ balance: sql`${walletsTable.balance} - ${bet}` })
      .where(and(
        eq(walletsTable.guildId, guildId),
        eq(walletsTable.userId, userId),
        sql`${walletsTable.balance} >= ${bet}`,
      ))
      .returning({ balance: walletsTable.balance });

    if (wallet) return { ok: true, balance: wallet.balance, used, limit };

    // The counter was reserved first, so release it before committing an
    // insufficient-funds result. The row lock from the upsert keeps this safe
    // against concurrent attempts for the same user/game/day.
    if (limit !== null) {
      await tx
        .update(casinoDailyPlayCountsTable)
        .set({ playCount: sql`MAX(0, ${casinoDailyPlayCountsTable.playCount} - 1)` })
        .where(and(
          eq(casinoDailyPlayCountsTable.guildId, guildId),
          eq(casinoDailyPlayCountsTable.userId, userId),
          eq(casinoDailyPlayCountsTable.game, game),
          eq(casinoDailyPlayCountsTable.date, date),
        ));
    }
    return { ok: false, reason: "insufficient_funds" };
  });
}