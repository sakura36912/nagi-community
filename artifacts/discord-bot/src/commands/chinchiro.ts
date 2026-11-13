import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  chinchiroGamesTable,
  db,
  transactionsTable,
  walletsTable,
  type ChinchiroGame,
} from "@workspace/db";
import { getGuildSettings, getOrCreateWallet } from "../lib/economy";
import { CASINO_DEFAULT_MAX_BET } from "./casino";
import { logger } from "../lib/logger";
import { chinchiroRecruitCommand } from "./chinchiroMultiplayer";

export const CHINCHIRO_PREFIX = "chinchiro:";

const MIN_BET = 1_000;
const CHALLENGE_TTL_MS = 60_000;
const ROLL_TTL_MS = 2 * 60_000;
const COLOR_NEUTRAL = 0x5865f2;
const COLOR_WIN = 0x57f287;
const COLOR_DRAW = 0xfee75c;
const COLOR_CANCEL = 0x747f8d;
const LEGACY_PENDING_STATUS = "pending";
const LEGACY_ACTIVE_STATUS = "active";
const WEIGHTED_PENDING_STATUS = "pending_weighted";
const WEIGHTED_ACTIVE_STATUS = "active_weighted";
const PENDING_STATUSES = [LEGACY_PENDING_STATUS, WEIGHTED_PENDING_STATUS];
const ACTIVE_STATUSES = [LEGACY_ACTIVE_STATUS, WEIGHTED_ACTIVE_STATUS];
const OPEN_STATUSES = [...PENDING_STATUSES, ...ACTIVE_STATUSES];
const MAX_PAYOUT_MULTIPLIER = 5;
const MAX_DATABASE_BALANCE = 2_147_483_647;
const DICE = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"] as const;

function isWeightedGame(status: string): boolean {
  return status === WEIGHTED_PENDING_STATUS || status === WEIGHTED_ACTIVE_STATUS;
}

function requiredEscrow(bet: number, status: string): number {
  return bet * (isWeightedGame(status) ? MAX_PAYOUT_MULTIPLIER : 1);
}

export type ChinchiroOutcomeKind =
  | "pinzoro"
  | "arashi"
  | "shigoro"
  | "point"
  | "menashi"
  | "hifumi"
  | "shonben";

export interface ChinchiroOutcome {
  kind: ChinchiroOutcomeKind;
  label: string;
  rank: number;
  dice: number[];
  attempts: number[][];
}

function evaluateThrow(dice: number[]): Omit<ChinchiroOutcome, "attempts"> | null {
  const sorted = [...dice].sort((a, b) => a - b);
  const key = sorted.join("");

  if (key === "111") {
    return { kind: "pinzoro", label: "ピンゾロ", rank: 9, dice };
  }
  if (sorted[0] === sorted[2]) {
    return {
      kind: "arashi",
      label: `アラシ（${sorted[0]}ゾロ）`,
      rank: 8,
      dice,
    };
  }
  if (key === "456") {
    return { kind: "shigoro", label: "シゴロ", rank: 7, dice };
  }
  if (key === "123") {
    return { kind: "hifumi", label: "ヒフミ", rank: -1, dice };
  }

  const counts = new Map<number, number>();
  for (const die of sorted) counts.set(die, (counts.get(die) ?? 0) + 1);
  const pair = [...counts.entries()].find(([, count]) => count === 2);
  if (!pair) return null;

  const point = sorted.find((die) => die !== pair[0])!;
  return { kind: "point", label: `${point}の目`, rank: point, dice };
}

export function evaluateChinchiroRoll(
  attempts: number[][],
): ChinchiroOutcome {
  for (const dice of attempts.slice(0, 3)) {
    const evaluated = evaluateThrow(dice);
    if (evaluated) return { ...evaluated, attempts };
  }
  const dice = attempts.at(-1) ?? [1, 2, 4];
  return { kind: "menashi", label: "目なし（バラバラ）", rank: 0, dice, attempts };
}

const WEIGHTED_ROLLS = {
  pinzoro: 1, // 0.5%
  arashi: 5, // 2〜6のゾロ目、合計2.5%
  shigoro: 5, // 2.5%
  hifumi: 5, // 2.5%
  point: 84, // 1〜6の目、それぞれ7%
  menashi: 96, // 48%
  shonben: 4, // 2%
} as const;
const WEIGHTED_ROLL_TOTAL = Object.values(WEIGHTED_ROLLS).reduce((sum, weight) => sum + weight, 0);
const NO_HAND_DICE: number[][] = [];
for (let first = 1; first <= 6; first++) {
  for (let second = 1; second <= 6; second++) {
    for (let third = 1; third <= 6; third++) {
      const dice = [first, second, third];
      if (new Set(dice).size !== 3) continue;
      const sortedKey = [...dice].sort((a, b) => a - b).join("");
      if (sortedKey === "123" || sortedKey === "456") continue;
      NO_HAND_DICE.push(dice);
    }
  }
}

function randomIndex(length: number, random: () => number): number {
  return Math.min(length - 1, Math.floor(random() * length));
}

function randomPermutation(dice: number[], random: () => number): number[] {
  const result = [...dice];
  for (let index = result.length - 1; index > 0; index--) {
    const swapIndex = randomIndex(index + 1, random);
    [result[index], result[swapIndex]] = [result[swapIndex]!, result[index]!];
  }
  return result;
}

/** One throw follows the configured percentage table (increments of 0.5%). */
export function rollChinchiroThrow(random: () => number = Math.random): Omit<ChinchiroOutcome, "attempts"> {
  const draw = random() * WEIGHTED_ROLL_TOTAL;
  let boundary = WEIGHTED_ROLLS.pinzoro;
  if (draw < boundary) return { kind: "pinzoro", label: "ピンゾロ", rank: 9, dice: [1, 1, 1] };

  boundary += WEIGHTED_ROLLS.arashi;
  if (draw < boundary) {
    const face = 2 + randomIndex(5, random);
    return { kind: "arashi", label: `${face}ゾロ`, rank: 8, dice: [face, face, face] };
  }

  boundary += WEIGHTED_ROLLS.shigoro;
  if (draw < boundary) {
    return { kind: "shigoro", label: "シゴロ", rank: 7, dice: randomPermutation([4, 5, 6], random) };
  }

  boundary += WEIGHTED_ROLLS.hifumi;
  if (draw < boundary) {
    return { kind: "hifumi", label: "ヒフミ", rank: -1, dice: randomPermutation([1, 2, 3], random) };
  }

  boundary += WEIGHTED_ROLLS.point;
  if (draw < boundary) {
    const point = Math.floor((draw - (WEIGHTED_ROLLS.pinzoro
      + WEIGHTED_ROLLS.arashi + WEIGHTED_ROLLS.shigoro + WEIGHTED_ROLLS.hifumi)) / 14) + 1;
    const pairFace = 1 + randomIndex(5, random);
    const differentPairFace = pairFace >= point ? pairFace + 1 : pairFace;
    const dice = [differentPairFace, differentPairFace, point];
    const pointPosition = randomIndex(3, random);
    [dice[pointPosition], dice[2]] = [dice[2]!, dice[pointPosition]!];
    return { kind: "point", label: `${point}の目`, rank: point, dice };
  }

  boundary += WEIGHTED_ROLLS.menashi;
  if (draw < boundary) {
    const dice = NO_HAND_DICE[randomIndex(NO_HAND_DICE.length, random)]!;
    return { kind: "menashi", label: "目なし（バラバラ）", rank: 0, dice: [...dice] };
  }

  return {
    kind: "shonben",
    label: "ションベン（サイコロが椀の外へ）",
    rank: -2,
    dice: Array.from({ length: 3 }, () => randomIndex(6, random) + 1),
  };
}

export function rollChinchiroHand(random: () => number = Math.random): ChinchiroOutcome {
  const attempts: number[][] = [];
  for (let i = 0; i < 3; i++) {
    const outcome = rollChinchiroThrow(random);
    attempts.push(outcome.dice);
    if (outcome.kind !== "menashi" || i === 2) return { ...outcome, attempts };
  }
  return evaluateChinchiroRoll(attempts);
}

/** Roll exactly once, preserving earlier no-hand attempts for manual play. */
export function rollChinchiroOnce(
  previousAttempts: number[][] = [],
  random: () => number = Math.random,
): ChinchiroOutcome {
  const attempts = previousAttempts.slice(0, 2).map((dice) => [...dice]);
  const outcome = rollChinchiroThrow(random);
  attempts.push(outcome.dice);
  return { ...outcome, attempts };
}

export function isChinchiroHandComplete(outcome: ChinchiroOutcome): boolean {
  return outcome.kind !== "menashi" || outcome.attempts.length >= 3;
}

export function chinchiroMultiplier(outcome: Pick<ChinchiroOutcome, "kind">): number {
  switch (outcome.kind) {
    case "pinzoro": return 5;
    case "arashi": return 3;
    case "shigoro": return 2;
    case "point":
    case "menashi":
    case "hifumi":
    case "shonben": return 1;
  }
}

export function chinchiroPairMultiplier(
  winning: Pick<ChinchiroOutcome, "kind">,
  losing: Pick<ChinchiroOutcome, "kind">,
): number {
  return Math.max(chinchiroMultiplier(winning), losing.kind === "hifumi" ? 2 : 1);
}

export function calculateChinchiroPayout(
  bet: number,
  winning: Pick<ChinchiroOutcome, "kind">,
  losing: Pick<ChinchiroOutcome, "kind">,
): { multiplier: number; winnerNet: number } {
  const multiplier = chinchiroPairMultiplier(winning, losing);
  const winnerNet = bet * multiplier;
  return { multiplier, winnerNet };
}

export function compareChinchiroOutcomes(
  challenger: ChinchiroOutcome,
  opponent: ChinchiroOutcome,
): -1 | 0 | 1 {
  if (challenger.rank === opponent.rank) return 0;
  return challenger.rank > opponent.rank ? 1 : -1;
}

function parseOutcome(raw: string | null): ChinchiroOutcome | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ChinchiroOutcome;
  } catch {
    return null;
  }
}

function formatDice(dice: number[]): string {
  return dice.map((die) => DICE[die - 1] ?? String(die)).join(" ");
}

function formatOutcome(outcome: ChinchiroOutcome | null): string {
  if (!outcome) return "🎲 まだ振っていません";
  const attempts = outcome.attempts
    .map((dice, index) => {
      const outsideCup = outcome.kind === "shonben" && index === outcome.attempts.length - 1
        ? " 💨（椀の外）"
        : "";
      return `${index + 1}投目: ${formatDice(dice)}${outsideCup}`;
    })
    .join("\n");
  return `${attempts}\n**${outcome.label}**`;
}

export interface ChinchiroDisplayNames {
  challenger: string;
  opponent: string;
}

type ChinchiroNameSource = {
  displayName?: string | null;
  user?: {
    globalName?: string | null;
    username?: string | null;
  };
  globalName?: string | null;
  username?: string | null;
};

export function getChinchiroDisplayName(
  source: ChinchiroNameSource | null | undefined,
): string {
  const user = source?.user ?? source;
  return source?.displayName?.trim()
    || user?.globalName?.trim()
    || user?.username?.trim()
    || "参加者";
}

async function resolveChinchiroDisplayName(
  interaction: ButtonInteraction | ChatInputCommandInteraction,
  userId: string,
): Promise<string> {
  const guild = interaction.guild;
  const member = guild
    ? guild.members.cache.get(userId)
      ?? await guild.members.fetch(userId).catch(() => null)
    : null;
  if (member) return getChinchiroDisplayName(member);

  const user = await interaction.client.users.fetch(userId).catch(() => null);
  return getChinchiroDisplayName(user);
}

async function resolveChinchiroDisplayNames(
  interaction: ButtonInteraction | ChatInputCommandInteraction,
  game: ChinchiroGame,
): Promise<ChinchiroDisplayNames> {
  const [challenger, opponent] = await Promise.all([
    resolveChinchiroDisplayName(interaction, game.challengerId),
    resolveChinchiroDisplayName(interaction, game.opponentId),
  ]);
  return { challenger, opponent };
}

function challengeComponents(id: number): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${CHINCHIRO_PREFIX}accept:${id}`)
        .setLabel("勝負を受ける")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${CHINCHIRO_PREFIX}decline:${id}`)
        .setLabel("辞退する")
        .setEmoji("✖️")
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

function rollComponents(id: number): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${CHINCHIRO_PREFIX}roll:${id}`)
        .setLabel("サイコロを振る")
        .setEmoji("🎲")
        .setStyle(ButtonStyle.Primary),
    ),
  ];
}

export function buildChallengeEmbed(
  game: ChinchiroGame,
  names: ChinchiroDisplayNames,
): EmbedBuilder {
  const reserve = requiredEscrow(game.bet, game.status);
  return new EmbedBuilder()
    .setTitle("🎲 対人チンチロ — 挑戦状")
    .setColor(COLOR_NEUTRAL)
    .setDescription(
      `**${names.challenger}** が **${names.opponent}** に勝負を挑みました！`,
    )
    .addFields(
      {
        name: "1人の賭け金",
        value: `**${game.bet.toLocaleString()}** ${game.currencyName}`,
        inline: true,
      },
      {
        name: "一時預かり額",
        value: `1人 **${reserve.toLocaleString()}** ${game.currencyName}${isWeightedGame(game.status) ? "（最大損失5倍分）" : ""}`,
        inline: true,
      },
    )
    .setFooter({
      text: isWeightedGame(game.status)
        ? "役倍率：シゴロ2倍／2〜6ゾロ3倍／ピンゾロ5倍／ヒフミ敗北時2倍。余剰分は返金し、引き分け・辞退・期限切れは全額返金します。"
        : "旧ルールの対戦です。引き分け・辞退・期限切れは返金されます。",
    })
    .setTimestamp();
}

export function buildActiveEmbed(
  game: ChinchiroGame,
  names: ChinchiroDisplayNames,
): EmbedBuilder {
  const reserve = requiredEscrow(game.bet, game.status);
  return new EmbedBuilder()
    .setTitle("🎲 対人チンチロ — 勝負開始")
    .setColor(COLOR_NEUTRAL)
    .addFields(
      {
        name: `挑戦者 ${names.challenger}`,
        value: formatOutcome(parseOutcome(game.challengerRoll)),
        inline: true,
      },
      {
        name: `対戦相手 ${names.opponent}`,
        value: formatOutcome(parseOutcome(game.opponentRoll)),
        inline: true,
      },
      {
        name: "賭け金",
        value: `1人 **${game.bet.toLocaleString()}** ${game.currencyName}（預かり額 **${reserve.toLocaleString()}** ${game.currencyName}）`,
      },
    );
}

export interface Settlement {
  game: ChinchiroGame;
  challengerOutcome: ChinchiroOutcome;
  opponentOutcome: ChinchiroOutcome;
  winnerId: string | null;
  payoutMultiplier?: number;
  escrowMultiplier?: number;
}

export function buildResultEmbed(
  result: Settlement,
  names: ChinchiroDisplayNames,
): EmbedBuilder {
  const { game, challengerOutcome, opponentOutcome, winnerId } = result;
  const isDraw = winnerId === null;
  const winningOutcome = winnerId === game.challengerId ? challengerOutcome : opponentOutcome;
  const losingOutcome = winnerId === game.challengerId ? opponentOutcome : challengerOutcome;
  const calculated = isDraw ? null : calculateChinchiroPayout(game.bet, winningOutcome, losingOutcome);
  const multiplier = isDraw ? 0 : result.payoutMultiplier ?? calculated!.multiplier;
  const winnerNet = game.bet * multiplier;
  return new EmbedBuilder()
    .setTitle(isDraw ? "🎲 対人チンチロ — 引き分け" : "🎲 対人チンチロ — 決着")
    .setColor(isDraw ? COLOR_DRAW : COLOR_WIN)
    .setDescription(
      isDraw
        ? `同じ強さのため、両者に **${game.bet.toLocaleString()}** ${game.currencyName} を返金しました。`
        : `🏆 **${winnerId === game.challengerId ? names.challenger : names.opponent}** の勝利！\n役倍率 **${multiplier}倍** — 今回の損益 **+${winnerNet.toLocaleString()} ${game.currencyName}**${result.escrowMultiplier && result.escrowMultiplier > multiplier ? "。預かり分の残額は返金済みです" : ""}。`,
    )
    .addFields(
      {
        name: `挑戦者 ${names.challenger}`,
        value: formatOutcome(challengerOutcome),
        inline: true,
      },
      {
        name: `対戦相手 ${names.opponent}`,
        value: formatOutcome(opponentOutcome),
        inline: true,
      },
    )
    .setTimestamp();
}

async function lockPlayers(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  guildId: string,
  userIds: string[],
): Promise<void> {
  for (const userId of [...userIds].sort()) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${guildId}:${userId}`}, 0))`,
    );
  }
}

async function creditWallet(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  guildId: string,
  userId: string,
  amount: number,
): Promise<void> {
  if (amount <= 0) return;
  if (!Number.isSafeInteger(amount) || amount > MAX_DATABASE_BALANCE) {
    throw new Error("チンチロの返金額が残高上限を超えています。");
  }
  const [credited] = await tx
    .update(walletsTable)
    .set({ balance: sql`${walletsTable.balance} + ${amount}` })
    .where(and(
      eq(walletsTable.guildId, guildId),
      eq(walletsTable.userId, userId),
      sql`${walletsTable.balance} <= ${MAX_DATABASE_BALANCE - amount}`,
    ))
    .returning({ balance: walletsTable.balance });
  if (!credited) throw new Error("返金後の残高が上限を超えます。");
}

type CreateChallengeResult =
  | { ok: true; game: ChinchiroGame }
  | { ok: false; reason: "busy" | "insufficient_funds" | "bet_too_high" };

async function createChallenge(
  guildId: string,
  channelId: string,
  challengerId: string,
  opponentId: string,
  bet: number,
  currencyName: string,
): Promise<CreateChallengeResult> {
  const reserve = bet * MAX_PAYOUT_MULTIPLIER;
  if (!Number.isSafeInteger(reserve) || reserve > MAX_DATABASE_BALANCE) {
    return { ok: false, reason: "bet_too_high" };
  }
  await Promise.all([
    getOrCreateWallet(guildId, challengerId),
    getOrCreateWallet(guildId, opponentId),
  ]);

  return db.transaction(async (tx) => {
    await lockPlayers(tx, guildId, [challengerId, opponentId]);
    const now = new Date();
    const [existing] = await tx
      .select({ id: chinchiroGamesTable.id })
      .from(chinchiroGamesTable)
      .where(and(
        eq(chinchiroGamesTable.guildId, guildId),
        inArray(chinchiroGamesTable.status, OPEN_STATUSES),
        gt(chinchiroGamesTable.expiresAt, now),
        or(
          inArray(chinchiroGamesTable.challengerId, [challengerId, opponentId]),
          inArray(chinchiroGamesTable.opponentId, [challengerId, opponentId]),
        ),
      ))
      .limit(1);
    if (existing) return { ok: false, reason: "busy" };

    const [debited] = await tx
      .update(walletsTable)
      .set({ balance: sql`${walletsTable.balance} - ${reserve}` })
      .where(and(
        eq(walletsTable.guildId, guildId),
        eq(walletsTable.userId, challengerId),
        sql`${walletsTable.balance} >= ${reserve}`,
        sql`${walletsTable.balance} <= ${MAX_DATABASE_BALANCE - reserve}`,
      ))
      .returning({ balance: walletsTable.balance });
    if (!debited) return { ok: false, reason: "insufficient_funds" };

    const [game] = await tx
      .insert(chinchiroGamesTable)
      .values({
        guildId,
        channelId,
        challengerId,
        opponentId,
        bet,
        currencyName,
        status: WEIGHTED_PENDING_STATUS,
        expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
      })
      .returning();
    if (!game) throw new Error("Failed to create Chinchiro challenge");
    return { ok: true, game };
  });
}

class OpponentFundsError extends Error {}

async function acceptChallenge(id: number): Promise<
  { ok: true; game: ChinchiroGame }
  | { ok: false; reason: "unavailable" | "insufficient_funds" }
> {
  try {
    return await db.transaction(async (tx) => {
      const [weighted] = await tx
        .update(chinchiroGamesTable)
        .set({
          status: WEIGHTED_ACTIVE_STATUS,
          expiresAt: new Date(Date.now() + ROLL_TTL_MS),
        })
        .where(and(
          eq(chinchiroGamesTable.id, id),
          eq(chinchiroGamesTable.status, WEIGHTED_PENDING_STATUS),
          gt(chinchiroGamesTable.expiresAt, new Date()),
        ))
        .returning();
      let activated = weighted;
      if (!activated) {
        const [legacy] = await tx
          .update(chinchiroGamesTable)
          .set({
            status: LEGACY_ACTIVE_STATUS,
            expiresAt: new Date(Date.now() + ROLL_TTL_MS),
          })
          .where(and(
            eq(chinchiroGamesTable.id, id),
            eq(chinchiroGamesTable.status, LEGACY_PENDING_STATUS),
            gt(chinchiroGamesTable.expiresAt, new Date()),
          ))
          .returning();
        activated = legacy;
      }
      if (!activated) return { ok: false, reason: "unavailable" };

      const reserve = requiredEscrow(activated.bet, activated.status);
      const [debited] = await tx
        .update(walletsTable)
        .set({ balance: sql`${walletsTable.balance} - ${reserve}` })
        .where(and(
          eq(walletsTable.guildId, activated.guildId),
          eq(walletsTable.userId, activated.opponentId),
          sql`${walletsTable.balance} >= ${reserve}`,
          sql`${walletsTable.balance} <= ${MAX_DATABASE_BALANCE - reserve}`,
        ))
        .returning({ balance: walletsTable.balance });
      if (!debited) throw new OpponentFundsError();
      return { ok: true, game: activated };
    });
  } catch (error) {
    if (error instanceof OpponentFundsError) {
      return { ok: false, reason: "insufficient_funds" };
    }
    throw error;
  }
}

async function closeAndRefund(
  id: number,
  statuses: string[],
  nextStatus: "declined" | "expired",
): Promise<ChinchiroGame | null> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(chinchiroGamesTable)
      .where(eq(chinchiroGamesTable.id, id))
      .for("update");
    if (!current || !statuses.includes(current.status)) return null;

    const [closed] = await tx
      .update(chinchiroGamesTable)
      .set({ status: nextStatus })
      .where(and(
        eq(chinchiroGamesTable.id, id),
        eq(chinchiroGamesTable.status, current.status),
      ))
      .returning();
    if (!closed) return null;

    const reserve = requiredEscrow(current.bet, current.status);
    await creditWallet(tx, closed.guildId, closed.challengerId, reserve);
    if (ACTIVE_STATUSES.includes(current.status)) {
      await creditWallet(tx, closed.guildId, closed.opponentId, reserve);
    }
    return closed;
  });
}

async function recordRoll(
  game: ChinchiroGame,
  userId: string,
  outcome: ChinchiroOutcome,
): Promise<ChinchiroGame | null> {
  const isChallenger = userId === game.challengerId;
  const rollColumn = isChallenger
    ? chinchiroGamesTable.challengerRoll
    : chinchiroGamesTable.opponentRoll;
  const set = isChallenger
    ? { challengerRoll: JSON.stringify(outcome) }
    : { opponentRoll: JSON.stringify(outcome) };

  const [updated] = await db
    .update(chinchiroGamesTable)
    .set(set)
    .where(and(
      eq(chinchiroGamesTable.id, game.id),
      inArray(chinchiroGamesTable.status, ACTIVE_STATUSES),
      gt(chinchiroGamesTable.expiresAt, new Date()),
      isNull(rollColumn),
    ))
    .returning();
  return updated ?? null;
}

async function settleGame(id: number): Promise<Settlement | null> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(chinchiroGamesTable)
      .where(eq(chinchiroGamesTable.id, id))
      .for("update");
    if (
      !current
      || !ACTIVE_STATUSES.includes(current.status)
      || !current.challengerRoll
      || !current.opponentRoll
    ) return null;
    const weightedGame = isWeightedGame(current.status);
    const [game] = await tx
      .update(chinchiroGamesTable)
      .set({ status: "settled" })
      .where(and(
        eq(chinchiroGamesTable.id, id),
        eq(chinchiroGamesTable.status, current.status),
        sql`${chinchiroGamesTable.challengerRoll} IS NOT NULL`,
        sql`${chinchiroGamesTable.opponentRoll} IS NOT NULL`,
      ))
      .returning();
    if (!game) return null;

    const challengerOutcome = parseOutcome(game.challengerRoll);
    const opponentOutcome = parseOutcome(game.opponentRoll);
    if (!challengerOutcome || !opponentOutcome) {
      throw new Error(`Invalid Chinchiro roll data for game ${id}`);
    }

    const comparison = compareChinchiroOutcomes(challengerOutcome, opponentOutcome);
    const winnerId = comparison === 0
      ? null
      : comparison > 0 ? game.challengerId : game.opponentId;
    const reserve = requiredEscrow(game.bet, current.status);
    let payoutMultiplier = 0;

    if (winnerId) {
      const winningOutcome = winnerId === game.challengerId ? challengerOutcome : opponentOutcome;
      const losingOutcome = winnerId === game.challengerId ? opponentOutcome : challengerOutcome;
      const payout = weightedGame
        ? calculateChinchiroPayout(game.bet, winningOutcome, losingOutcome)
        : calculateChinchiroPayout(game.bet, { kind: "point" }, { kind: "point" });
      payoutMultiplier = payout.multiplier;
      const loserRefund = reserve - payout.winnerNet;
      if (loserRefund < 0) throw new Error("チンチロの預かり額が倍率に対して不足しています。");
      const loserId = winnerId === game.challengerId ? game.opponentId : game.challengerId;
      await creditWallet(tx, game.guildId, winnerId, reserve + payout.winnerNet);
      await creditWallet(tx, game.guildId, loserId, loserRefund);
      await tx.insert(transactionsTable).values([
        {
          guildId: game.guildId,
          userId: winnerId,
          amount: payout.winnerNet,
          reason: `チンチロ 対人勝利（賭け: ${game.bet}、倍率: ${payoutMultiplier}）`,
          relatedUserId: loserId,
          sessionKey: `chinchiro:${game.id}:${winnerId}`,
        },
        {
          guildId: game.guildId,
          userId: loserId,
          amount: -payout.winnerNet,
          reason: `チンチロ 対人敗北（賭け: ${game.bet}、倍率: ${payoutMultiplier}）`,
          relatedUserId: winnerId,
          sessionKey: `chinchiro:${game.id}:${loserId}`,
        },
      ]);
    } else {
      await creditWallet(tx, game.guildId, game.challengerId, reserve);
      await creditWallet(tx, game.guildId, game.opponentId, reserve);
      await tx.insert(transactionsTable).values([
        {
          guildId: game.guildId,
          userId: game.challengerId,
          amount: 0,
          reason: `チンチロ 引き分け（賭け: ${game.bet}）`,
          relatedUserId: game.opponentId,
          sessionKey: `chinchiro:${game.id}:${game.challengerId}`,
        },
        {
          guildId: game.guildId,
          userId: game.opponentId,
          amount: 0,
          reason: `チンチロ 引き分け（賭け: ${game.bet}）`,
          relatedUserId: game.challengerId,
          sessionKey: `chinchiro:${game.id}:${game.opponentId}`,
        },
      ]);
    }

    return {
      game,
      challengerOutcome,
      opponentOutcome,
      winnerId,
      payoutMultiplier,
      escrowMultiplier: weightedGame ? MAX_PAYOUT_MULTIPLIER : 1,
    };
  });
}

export async function refundExpiredChinchiroGames(now = new Date()): Promise<number> {
  const expired = await db
    .select({ id: chinchiroGamesTable.id })
    .from(chinchiroGamesTable)
    .where(and(
      inArray(chinchiroGamesTable.status, OPEN_STATUSES),
      lt(chinchiroGamesTable.expiresAt, now),
    ));
  let refunded = 0;
  for (const { id } of expired) {
    if (await closeAndRefund(id, OPEN_STATUSES, "expired")) refunded++;
  }
  return refunded;
}

const expiryTimer = setInterval(() => {
  void refundExpiredChinchiroGames().then((count) => {
    if (count > 0) logger.info(`[chinchiro] Refunded ${count} expired game(s)`);
  }).catch((error) => logger.error("[chinchiro] Expiry refund failed", error));
}, 30_000);
expiryTimer.unref();

async function getGame(id: number): Promise<ChinchiroGame | null> {
  const [game] = await db
    .select()
    .from(chinchiroGamesTable)
    .where(eq(chinchiroGamesTable.id, id));
  return game ?? null;
}

async function handleAccept(interaction: ButtonInteraction, game: ChinchiroGame): Promise<void> {
  if (interaction.user.id !== game.opponentId) {
    await interaction.reply({
      content: "この挑戦を受けられるのは指定された対戦相手だけです。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferUpdate();
  const result = await acceptChallenge(game.id);
  if (!result.ok) {
    const content = result.reason === "insufficient_funds"
      ? `残高が不足しています。**${requiredEscrow(game.bet, game.status).toLocaleString()}** ${game.currencyName}（最大損失分）が必要です。`
      : "この挑戦はすでに終了しているか、期限切れです。";
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    return;
  }
  const names = await resolveChinchiroDisplayNames(interaction, result.game);
  await interaction.message.edit({
    content: "",
    embeds: [buildActiveEmbed(result.game, names)],
    components: rollComponents(result.game.id),
    allowedMentions: { parse: [] },
  });
}

async function handleDecline(interaction: ButtonInteraction, game: ChinchiroGame): Promise<void> {
  if (![game.challengerId, game.opponentId].includes(interaction.user.id)) {
    await interaction.reply({
      content: "この挑戦を辞退・取り消しできるのは対戦者だけです。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferUpdate();
  const closed = await closeAndRefund(game.id, PENDING_STATUSES, "declined");
  if (!closed) {
    await interaction.followUp({
      content: "この挑戦はすでに開始または終了しています。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const challengerName = await resolveChinchiroDisplayName(interaction, closed.challengerId);
  await interaction.message.edit({
    content: "",
    embeds: [
      new EmbedBuilder()
        .setTitle("🎲 対人チンチロ — キャンセル")
        .setColor(COLOR_CANCEL)
        .setDescription(`勝負はキャンセルされ、**${challengerName}** に賭け金を返金しました。`),
    ],
    components: [],
    allowedMentions: { parse: [] },
  });
}

async function handleRoll(interaction: ButtonInteraction, game: ChinchiroGame): Promise<void> {
  if (![game.challengerId, game.opponentId].includes(interaction.user.id)) {
    await interaction.reply({
      content: "サイコロを振れるのは対戦者だけです。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferUpdate();
  const outcome = rollChinchiroHand();
  const updated = await recordRoll(game, interaction.user.id, outcome);
  if (!updated) {
    await interaction.followUp({
      content: "すでにサイコロを振ったか、この勝負は期限切れです。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (updated.challengerRoll && updated.opponentRoll) {
    const settlement = await settleGame(updated.id);
    if (!settlement) {
      await interaction.followUp({
        content: "この勝負はすでに精算されています。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const names = await resolveChinchiroDisplayNames(interaction, settlement.game);
    await interaction.message.edit({
      content: "",
      embeds: [buildResultEmbed(settlement, names)],
      components: [],
      allowedMentions: { parse: [] },
    });
    return;
  }

  const names = await resolveChinchiroDisplayNames(interaction, updated);
  await interaction.message.edit({
    content: "",
    embeds: [buildActiveEmbed(updated, names)],
    components: rollComponents(updated.id),
    allowedMentions: { parse: [] },
  });
}

export async function handleChinchiroButton(interaction: ButtonInteraction): Promise<void> {
  const [, action, rawId] = interaction.customId.split(":");
  const id = Number(rawId);
  if (!Number.isSafeInteger(id)) {
    await interaction.reply({ content: "無効な対戦です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const game = await getGame(id);
  if (!game || game.guildId !== interaction.guildId) {
    await interaction.reply({
      content: "対戦データが見つかりません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (game.expiresAt <= new Date() && OPEN_STATUSES.includes(game.status)) {
    await closeAndRefund(game.id, OPEN_STATUSES, "expired");
    await interaction.update({
      content: "",
      embeds: [
        new EmbedBuilder()
          .setTitle("🎲 対人チンチロ — 期限切れ")
          .setColor(COLOR_CANCEL)
          .setDescription("勝負は期限切れになり、預けられた賭け金を返金しました。"),
      ],
      components: [],
    });
    return;
  }
  if (action === "accept") {
    await handleAccept(interaction, game);
  } else if (action === "decline") {
    await handleDecline(interaction, game);
  } else if (action === "roll") {
    await handleRoll(interaction, game);
  }
}

async function handleChallenge(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId || !interaction.channelId) return;
  const opponent = interaction.options.getUser("opponent", true);
  const bet = interaction.options.getInteger("bet", true);

  if (opponent.id === interaction.user.id) {
    await interaction.reply({
      content: "自分自身には挑戦できません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (opponent.bot) {
    await interaction.reply({
      content: "Botには挑戦できません。プレイヤーを指定してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();
  const settings = await getGuildSettings(interaction.guildId);
  const maxBet = settings.casinoMaxBet ?? CASINO_DEFAULT_MAX_BET;
  if (bet > maxBet) {
    await interaction.editReply(
      `賭け金が上限（**${maxBet.toLocaleString()}** ${settings.currencyName}）を超えています。`,
    );
    return;
  }
  const reserve = bet * MAX_PAYOUT_MULTIPLIER;
  if (!Number.isSafeInteger(reserve) || reserve > MAX_DATABASE_BALANCE) {
    await interaction.editReply("賭け金が高すぎます。最大損失分を安全に預かれる金額にしてください。");
    return;
  }

  const created = await createChallenge(
    interaction.guildId,
    interaction.channelId,
    interaction.user.id,
    opponent.id,
    bet,
    settings.currencyName,
  );
  if (!created.ok) {
    await interaction.editReply(
      created.reason === "busy"
        ? "どちらかのプレイヤーに進行中のチンチロがあります。先の勝負を終わらせてください。"
        : created.reason === "bet_too_high"
          ? "賭け金が高すぎます。最大損失分を安全に預かれる金額にしてください。"
          : `残高が不足しています。**${reserve.toLocaleString()}** ${settings.currencyName}（最大損失分）が必要です。`,
    );
    return;
  }

  try {
    const names = await resolveChinchiroDisplayNames(interaction, created.game);
    const message = await interaction.editReply({
      content: `<@${opponent.id}> 対人チンチロの挑戦が届いています。`,
      embeds: [buildChallengeEmbed(created.game, names)],
      components: challengeComponents(created.game.id),
      allowedMentions: { users: [opponent.id] },
    });
    await db
      .update(chinchiroGamesTable)
      .set({ messageId: message.id })
      .where(eq(chinchiroGamesTable.id, created.game.id));
  } catch (error) {
    await closeAndRefund(created.game.id, PENDING_STATUSES, "expired");
    throw error;
  }
}

// Keep the legacy handlers above for outstanding 1v1 messages only. New slash
// registrations deliberately expose the multiplayer recruitment flow.
export const chinchiroCommand = chinchiroRecruitCommand;