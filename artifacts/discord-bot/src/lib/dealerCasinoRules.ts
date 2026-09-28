import { randomInt } from "node:crypto";

export type ChohanSide = "cho" | "han";

export interface ChohanRoll {
  dice: [number, number];
  total: number;
  result: ChohanSide;
}

export function rollChohan(): ChohanRoll {
  const dice: [number, number] = [randomInt(1, 7), randomInt(1, 7)];
  const total = dice[0] + dice[1];
  return { dice, total, result: total % 2 === 0 ? "cho" : "han" };
}

export function resolveChohanBet(
  choice: ChohanSide,
  roll: Pick<ChohanRoll, "dice">,
): { total: number; result: ChohanSide; won: boolean } {
  if (choice !== "cho" && choice !== "han") {
    throw new TypeError("丁半の選択は cho または han を指定してください。");
  }
  if (
    !Array.isArray(roll.dice) ||
    roll.dice.length !== 2 ||
    roll.dice.some((die) => !Number.isInteger(die) || die < 1 || die > 6)
  ) {
    throw new RangeError("サイコロの出目は1から6の整数を2個指定してください。");
  }

  const total = roll.dice[0] + roll.dice[1];
  const result: ChohanSide = total % 2 === 0 ? "cho" : "han";
  return { total, result, won: choice === result };
}

export interface ChohanStreakMultiplier {
  /** The multiplier applies at this streak length and all higher lengths. */
  minimumWinStreak: number;
  multiplier: number;
}

export function getChohanStreakMultiplier(
  winStreak: number,
  configuredMultipliers: readonly ChohanStreakMultiplier[],
): number {
  assertPositiveInteger(winStreak, "連勝数");
  validateStreakMultipliers(configuredMultipliers);

  const applicable = configuredMultipliers
    .filter(({ minimumWinStreak }) => minimumWinStreak <= winStreak)
    .sort((left, right) => right.minimumWinStreak - left.minimumWinStreak)[0];
  if (!applicable) {
    throw new RangeError(`連勝${winStreak}回に適用できる丁半倍率が設定されていません。`);
  }
  return applicable.multiplier;
}

export function calculatePayout(bet: number, multiplier: number): number {
  assertPositiveInteger(bet, "掛け金");
  assertFiniteNonNegative(multiplier, "配当倍率");

  // Wallets and settlement rows hold whole currency units in PostgreSQL integers.
  // Round fractions down once, before the result is persisted, never during settlement.
  const payout = Math.floor(bet * multiplier);
  if (!Number.isSafeInteger(payout) || payout > 2_147_483_647) {
    throw new RangeError("払戻額が保存可能な整数の範囲を超えています。");
  }
  return payout;
}

export const CARD_SUITS = ["spades", "hearts", "diamonds", "clubs"] as const;
export type CardSuit = (typeof CARD_SUITS)[number];
export type CardRank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export interface PokerCard {
  suit: CardSuit;
  rank: CardRank;
}

export type PokerHandRank =
  | "straight-flush"
  | "three-of-a-kind"
  | "straight"
  | "flush"
  | "pair"
  | "high-card";

export interface PokerHandValue {
  rank: PokerHandRank;
  /** Rank-specific comparison values, highest-priority value first. */
  tieBreakers: number[];
}

const RANK_STRENGTH: Record<PokerHandRank, number> = {
  "high-card": 0,
  pair: 1,
  flush: 2,
  straight: 3,
  "three-of-a-kind": 4,
  "straight-flush": 5,
};

export const THREE_CARD_POKER_BASE_MULTIPLIER = 2;

export interface PokerPayoutConfig {
  /** The ordinary winning payout multiplier; the specification's baseline is 2.0. */
  baseWinMultiplier: number;
  roleBonusEnabled: boolean;
  /**
   * When role bonuses are enabled, the configured value replaces the ordinary
   * multiplier for that role. No role-specific values are assumed by this module.
   */
  roleBonusMultipliers?: Partial<Record<PokerHandRank, number>>;
}

export interface DealerQualificationConfig {
  enabled: boolean;
  minimumCategory?: PokerHandRank;
  /** Optional high-card threshold when the dealer has exactly minimumCategory. */
  minimumHighCard?: CardRank;
}

/**
 * Creates and cryptographically shuffles a standard 52-card deck.
 * Fisher–Yates uses node:crypto's unbiased randomInt instead of Math.random.
 */
export function createShuffledPokerDeck(): PokerCard[] {
  const deck: PokerCard[] = CARD_SUITS.flatMap((suit) =>
    Array.from({ length: 13 }, (_, index) => ({
      suit,
      rank: (index + 2) as CardRank,
    })),
  );
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const otherIndex = randomInt(index + 1);
    [deck[index], deck[otherIndex]] = [deck[otherIndex]!, deck[index]!];
  }
  return deck;
}

export interface ThreeCardDeal {
  players: PokerCard[][];
  dealer: PokerCard[];
}

/** Deals three cards to every player and the dealer from one shuffled deck. */
export function dealThreeCardPoker(playerCount: number): ThreeCardDeal {
  if (!Number.isInteger(playerCount) || playerCount < 1 || playerCount > 16) {
    throw new RangeError("参加人数は1から16人で指定してください（ディーラーを含む52枚デッキの上限）。");
  }

  const deck = createShuffledPokerDeck();
  let nextCard = 0;
  const players = Array.from({ length: playerCount }, () =>
    deck.slice(nextCard, (nextCard += 3)),
  );
  const dealer = deck.slice(nextCard, nextCard + 3);
  return { players, dealer };
}

/**
 * Evaluates exactly three distinct cards. A-2-3 is recognized only when the
 * caller explicitly supplies `true`; no rule default is silently selected.
 */
export function evaluatePokerHand(
  cards: readonly PokerCard[],
  aceLowStraightEnabled: boolean,
): PokerHandValue {
  if (typeof aceLowStraightEnabled !== "boolean") {
    throw new TypeError("A-2-3の有効・無効をbooleanで明示してください。");
  }
  if (cards.length !== 3) {
    throw new RangeError("スリーカードポーカーの役判定にはカードが3枚必要です。");
  }
  cards.forEach(assertValidCard);
  if (new Set(cards.map((card) => `${card.suit}:${card.rank}`)).size !== 3) {
    throw new RangeError("同じカードを含む手札は判定できません。");
  }

  const ranks = cards.map(({ rank }) => rank).sort((left, right) => right - left);
  const ascending = [...ranks].reverse();
  const flush = cards.every((card) => card.suit === cards[0]!.suit);
  const unique = new Set(ranks);
  const straightHigh = getStraightHigh(ascending, aceLowStraightEnabled);

  if (flush && straightHigh !== null) {
    return { rank: "straight-flush", tieBreakers: [straightHigh] };
  }
  if (unique.size === 1) {
    return { rank: "three-of-a-kind", tieBreakers: [ranks[0]!] };
  }
  if (straightHigh !== null) {
    return { rank: "straight", tieBreakers: [straightHigh] };
  }
  if (flush) {
    return { rank: "flush", tieBreakers: ranks };
  }
  if (unique.size === 2) {
    const counts = countRanks(ranks);
    const pairRank = [...counts].find(([, count]) => count === 2)![0];
    const kicker = [...counts].find(([, count]) => count === 1)![0];
    return { rank: "pair", tieBreakers: [pairRank, kicker] };
  }
  return { rank: "high-card", tieBreakers: ranks };
}

/** Returns 1 for a stronger left hand, -1 for stronger right, and 0 for a tie. */
export function comparePokerHandValues(
  left: PokerHandValue,
  right: PokerHandValue,
): -1 | 0 | 1 {
  assertValidHandValue(left);
  assertValidHandValue(right);
  const categoryDifference = RANK_STRENGTH[left.rank] - RANK_STRENGTH[right.rank];
  if (categoryDifference !== 0) return categoryDifference > 0 ? 1 : -1;

  const length = Math.max(left.tieBreakers.length, right.tieBreakers.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left.tieBreakers[index] ?? 0;
    const rightValue = right.tieBreakers[index] ?? 0;
    if (leftValue !== rightValue) return leftValue > rightValue ? 1 : -1;
  }
  return 0;
}

export function comparePokerHands(
  left: readonly PokerCard[],
  right: readonly PokerCard[],
  aceLowStraightEnabled: boolean,
): -1 | 0 | 1 {
  return comparePokerHandValues(
    evaluatePokerHand(left, aceLowStraightEnabled),
    evaluatePokerHand(right, aceLowStraightEnabled),
  );
}

export function isDealerQualified(
  handValue: PokerHandValue,
  config: DealerQualificationConfig,
): boolean {
  assertValidHandValue(handValue);
  if (typeof config.enabled !== "boolean") {
    throw new TypeError("ディーラー成立条件の有効・無効を明示してください。");
  }
  if (!config.enabled) return true;
  if (!config.minimumCategory || !(config.minimumCategory in RANK_STRENGTH)) {
    throw new TypeError("成立条件が有効な場合はminimumCategoryを設定してください。");
  }
  if (config.minimumHighCard !== undefined) {
    assertValidRank(config.minimumHighCard);
  }

  const categoryDifference =
    RANK_STRENGTH[handValue.rank] - RANK_STRENGTH[config.minimumCategory];
  if (categoryDifference !== 0) return categoryDifference > 0;
  if (config.minimumHighCard === undefined) return true;
  return (handValue.tieBreakers[0] ?? 0) >= config.minimumHighCard;
}

export function getPokerPayoutMultiplier(
  handRank: PokerHandRank,
  config: PokerPayoutConfig,
): number {
  if (!(handRank in RANK_STRENGTH)) {
    throw new TypeError("認識できないポーカー役です。");
  }
  assertFiniteNonNegative(config.baseWinMultiplier, "通常勝利倍率");
  if (typeof config.roleBonusEnabled !== "boolean") {
    throw new TypeError("役ボーナスの有効・無効を明示してください。");
  }
  if (!config.roleBonusEnabled) return config.baseWinMultiplier;

  const multiplier = config.roleBonusMultipliers?.[handRank];
  if (multiplier === undefined) {
    throw new RangeError(`役「${handRank}」のボーナス倍率が設定されていません。`);
  }
  assertFiniteNonNegative(multiplier, "役ボーナス倍率");
  return multiplier;
}

function getStraightHigh(ranksAscending: number[], aceLowEnabled: boolean): number | null {
  if (ranksAscending[0] === 2 && ranksAscending[1] === 3 && ranksAscending[2] === 14) {
    return aceLowEnabled ? 3 : null;
  }
  return ranksAscending[1] === ranksAscending[0]! + 1 &&
    ranksAscending[2] === ranksAscending[1]! + 1
    ? ranksAscending[2]!
    : null;
}

function countRanks(ranks: number[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const rank of ranks) counts.set(rank, (counts.get(rank) ?? 0) + 1);
  return counts;
}

function assertValidCard(card: PokerCard): void {
  if (!card || !CARD_SUITS.includes(card.suit)) {
    throw new TypeError("カードのスートが不正です。");
  }
  assertValidRank(card.rank);
}

function assertValidRank(rank: number): asserts rank is CardRank {
  if (!Number.isInteger(rank) || rank < 2 || rank > 14) {
    throw new RangeError("カードの数字は2から14（A）の整数で指定してください。");
  }
}

function assertValidHandValue(value: PokerHandValue): void {
  if (!value || !(value.rank in RANK_STRENGTH) || !Array.isArray(value.tieBreakers)) {
    throw new TypeError("ポーカー役の判定値が不正です。");
  }
  value.tieBreakers.forEach((rank) => assertValidRank(rank));
}

function validateStreakMultipliers(
  multipliers: readonly ChohanStreakMultiplier[],
): void {
  if (multipliers.length === 0) {
    throw new RangeError("丁半の連勝倍率が設定されていません。");
  }
  const thresholds = new Set<number>();
  for (const entry of multipliers) {
    assertPositiveInteger(entry.minimumWinStreak, "倍率の適用連勝数");
    assertFiniteNonNegative(entry.multiplier, "丁半倍率");
    if (thresholds.has(entry.minimumWinStreak)) {
      throw new RangeError("丁半倍率の適用連勝数が重複しています。");
    }
    thresholds.add(entry.minimumWinStreak);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label}は正の整数で指定してください。`);
  }
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label}は0以上の有限数で指定してください。`);
  }
}