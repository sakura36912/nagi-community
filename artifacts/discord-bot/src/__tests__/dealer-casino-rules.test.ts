import { describe, expect, it } from "vitest";
import {
  CARD_SUITS,
  THREE_CARD_POKER_BASE_MULTIPLIER,
  calculatePayout,
  comparePokerHands,
  comparePokerHandValues,
  createShuffledPokerDeck,
  dealThreeCardPoker,
  evaluatePokerHand,
  getChohanStreakMultiplier,
  getPokerPayoutMultiplier,
  isDealerQualified,
  resolveChohanBet,
  rollChohan,
  type PokerCard,
  type PokerHandRank,
} from "../lib/dealerCasinoRules.js";

const card = (suit: PokerCard["suit"], rank: number): PokerCard => ({
  suit,
  rank: rank as PokerCard["rank"],
});

describe("丁半の判定と配当", () => {
  it("サイコロを1～6の範囲で振り、出目から丁半と勝敗を判定する", () => {
    const result = rollChohan();
    expect(result.dice).toHaveLength(2);
    expect(result.dice.every((die) => die >= 1 && die <= 6)).toBe(true);
    expect(result.total).toBe(result.dice[0] + result.dice[1]);
    expect(result.result).toBe(result.total % 2 === 0 ? "cho" : "han");

    expect(resolveChohanBet("cho", { dice: [2, 4] })).toEqual({
      total: 6,
      result: "cho",
      won: true,
    });
    expect(resolveChohanBet("han", { dice: [2, 3] })).toEqual({
      total: 5,
      result: "han",
      won: true,
    });
    expect(resolveChohanBet("cho", { dice: [2, 3] }).won).toBe(false);
  });

  it("不正な出目と選択を拒否する", () => {
    expect(() => resolveChohanBet("cho", { dice: [0, 6] })).toThrow();
    expect(() => resolveChohanBet("unknown" as "cho", { dice: [1, 6] })).toThrow();
  });

  it("設定された連勝しきい値のうち最も高い該当倍率を選ぶ（しきい値未設定なら失敗）", () => {
    const multipliers = [
      { minimumWinStreak: 1, multiplier: 2 },
      { minimumWinStreak: 3, multiplier: 2.5 },
      { minimumWinStreak: 5, multiplier: 3.5 },
    ];
    expect(getChohanStreakMultiplier(2, multipliers)).toBe(2);
    expect(getChohanStreakMultiplier(4, multipliers)).toBe(2.5);
    expect(getChohanStreakMultiplier(6, multipliers)).toBe(3.5);
    expect(() => getChohanStreakMultiplier(1, [])).toThrow();
    expect(calculatePayout(1_000, 2.5)).toBe(2_500);
    expect(calculatePayout(1_001, 2.5)).toBe(2_502);
    expect(() => calculatePayout(0, 2)).toThrow();
  });
});

describe("スリーカードポーカーのカード配布", () => {
  it("52枚の標準デッキを作成しシャッフルする", () => {
    const deck = createShuffledPokerDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck.map(({ suit, rank }) => `${suit}:${rank}`)).size).toBe(52);
    expect(new Set(deck.map(({ suit }) => suit))).toEqual(new Set(CARD_SUITS));
  });

  it("プレイヤー全員とディーラーに重複なしで3枚ずつ配る", () => {
    const { players, dealer } = dealThreeCardPoker(4);
    const dealt = [...players.flat(), ...dealer];
    expect(players).toHaveLength(4);
    expect(players.every((hand) => hand.length === 3)).toBe(true);
    expect(dealer).toHaveLength(3);
    expect(new Set(dealt.map(({ suit, rank }) => `${suit}:${rank}`)).size).toBe(15);
    expect(() => dealThreeCardPoker(0)).toThrow();
    expect(() => dealThreeCardPoker(17)).toThrow();
  });
});

describe("スリーカードポーカーの役判定", () => {
  it("仕様の役順をストレートフラッシュ > スリーカード > ストレート > フラッシュ > ペア > ハイカードにする", () => {
    const hands: Array<[PokerHandRank, PokerCard[]]> = [
      ["straight-flush", [card("spades", 2), card("spades", 3), card("spades", 4)]],
      ["three-of-a-kind", [card("spades", 9), card("hearts", 9), card("clubs", 9)]],
      ["straight", [card("spades", 5), card("hearts", 6), card("clubs", 7)]],
      ["flush", [card("spades", 2), card("spades", 8), card("spades", 12)]],
      ["pair", [card("spades", 10), card("hearts", 10), card("clubs", 14)]],
      ["high-card", [card("spades", 2), card("hearts", 8), card("clubs", 14)]],
    ];
    for (const [expectedRank, hand] of hands) {
      expect(evaluatePokerHand(hand, false).rank).toBe(expectedRank);
    }
    for (let index = 0; index < hands.length - 1; index += 1) {
      expect(comparePokerHands(hands[index]![1], hands[index + 1]![1], false)).toBe(1);
    }
  });

  it("A-2-3の扱いは必須設定で制御し、有効時は3をストレート高位とする", () => {
    const wheel = [card("spades", 14), card("hearts", 2), card("clubs", 3)];
    expect(evaluatePokerHand(wheel, true)).toEqual({ rank: "straight", tieBreakers: [3] });
    expect(evaluatePokerHand(wheel, false).rank).toBe("high-card");
    expect(() =>
      evaluatePokerHand(wheel, undefined as unknown as boolean),
    ).toThrow();
    const fourHigh = [card("spades", 2), card("hearts", 3), card("clubs", 4)];
    expect(comparePokerHands(fourHigh, wheel, true)).toBe(1);
  });

  it("役が同じ場合は役の構成数字とキッカー、高札順で完全比較する", () => {
    expect(
      comparePokerHands(
        [card("spades", 13), card("hearts", 13), card("clubs", 5)],
        [card("spades", 12), card("hearts", 12), card("clubs", 14)],
        false,
      ),
    ).toBe(1);
    expect(
      comparePokerHands(
        [card("spades", 8), card("hearts", 8), card("clubs", 14)],
        [card("spades", 8), card("hearts", 8), card("clubs", 13)],
        false,
      ),
    ).toBe(1);
    expect(
      comparePokerHands(
        [card("spades", 14), card("hearts", 10), card("clubs", 7)],
        [card("spades", 14), card("hearts", 9), card("clubs", 8)],
        false,
      ),
    ).toBe(1);
    expect(comparePokerHandValues(
      { rank: "pair", tieBreakers: [9, 4] },
      { rank: "pair", tieBreakers: [9, 4] },
    )).toBe(0);
  });

  it("同一手札は引き分け、重複カードや枚数不足は拒否する", () => {
    const hand = [card("spades", 2), card("hearts", 5), card("clubs", 9)];
    expect(comparePokerHands(hand, hand, false)).toBe(0);
    expect(() =>
      evaluatePokerHand([card("spades", 2), card("spades", 2), card("clubs", 9)], false),
    ).toThrow();
    expect(() => evaluatePokerHand(hand.slice(0, 2), false)).toThrow();
  });
});

describe("ディーラー成立条件とポーカー配当", () => {
  it("成立条件OFFなら常に成立し、ONなら設定された役・ハイカードしきい値を要求する", () => {
    const kingHigh = evaluatePokerHand(
      [card("spades", 13), card("hearts", 9), card("clubs", 4)],
      false,
    );
    const pair = evaluatePokerHand(
      [card("spades", 2), card("hearts", 2), card("clubs", 4)],
      false,
    );
    expect(isDealerQualified(kingHigh, { enabled: false })).toBe(true);
    expect(isDealerQualified(kingHigh, {
      enabled: true,
      minimumCategory: "high-card",
      minimumHighCard: 12,
    })).toBe(true);
    expect(isDealerQualified(
      evaluatePokerHand([card("spades", 11), card("hearts", 9), card("clubs", 4)], false),
      { enabled: true, minimumCategory: "high-card", minimumHighCard: 12 },
    )).toBe(false);
    expect(isDealerQualified(pair, {
      enabled: true,
      minimumCategory: "high-card",
      minimumHighCard: 12,
    })).toBe(true);
    expect(() => isDealerQualified(kingHigh, { enabled: true })).toThrow();
  });

  it("役ボーナスが無効なら通常倍率、有効なら各役の設定値を使い未設定値を拒否する", () => {
    expect(THREE_CARD_POKER_BASE_MULTIPLIER).toBe(2);
    expect(getPokerPayoutMultiplier("pair", {
      baseWinMultiplier: THREE_CARD_POKER_BASE_MULTIPLIER,
      roleBonusEnabled: false,
    })).toBe(2);
    expect(getPokerPayoutMultiplier("straight", {
      baseWinMultiplier: 2,
      roleBonusEnabled: true,
      roleBonusMultipliers: { straight: 3 },
    })).toBe(3);
    expect(() => getPokerPayoutMultiplier("pair", {
      baseWinMultiplier: 2,
      roleBonusEnabled: true,
      roleBonusMultipliers: { straight: 3 },
    })).toThrow();
  });
});