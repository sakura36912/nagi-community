import { describe, expect, it } from "vitest";
import type { ChinchiroGame } from "@workspace/db";
import {
  buildActiveEmbed,
  buildChallengeEmbed,
  buildResultEmbed,
  calculateChinchiroPayout,
  compareChinchiroOutcomes,
  evaluateChinchiroRoll,
  getChinchiroDisplayName,
  isChinchiroHandComplete,
  rollChinchiroHand,
  rollChinchiroOnce,
  rollChinchiroThrow,
} from "../commands/chinchiro";

describe("対人チンチロの役判定", () => {
  it.each([
    [[[1, 1, 1]], "pinzoro", 9],
    [[[6, 6, 6]], "arashi", 8],
    [[[4, 5, 6]], "shigoro", 7],
    [[[2, 2, 6]], "point", 6],
    [[[1, 2, 3]], "hifumi", -1],
    [[[1, 2, 4], [2, 3, 5], [1, 4, 6]], "menashi", 0],
  ] as const)("投目 %j を正しく判定する", (attempts, kind, rank) => {
    const result = evaluateChinchiroRoll(attempts.map((dice) => [...dice]));
    expect(result.kind).toBe(kind);
    expect(result.rank).toBe(rank);
  });

  it("目なしなら最大3回振り、途中で役が出たら終了する", () => {
    const values = [100.5 / 200, 0.5, 100.5 / 200, 0.5, 6.5 / 200, 0.5, 0.5];
    let index = 0;
    const result = rollChinchiroHand(() => values[index++]!);
    expect(result.kind).toBe("shigoro");
    expect(result.attempts).toHaveLength(3);
  });

  it("手動ロールは1回のボタン操作につき1投だけ追加する", () => {
    const firstValues = [100.5 / 200, 0.5];
    const first = rollChinchiroOnce([], () => firstValues.shift()!);
    expect(first.attempts).toHaveLength(1);
    expect(first.kind).toBe("menashi");
    expect(isChinchiroHandComplete(first)).toBe(false);

    const secondValues = [100.5 / 200, 0.5];
    const second = rollChinchiroOnce(first.attempts, () => secondValues.shift()!);
    expect(second.attempts).toHaveLength(2);
    expect(second.kind).toBe("menashi");
    expect(isChinchiroHandComplete(second)).toBe(false);

    const thirdValues = [100.5 / 200, 0.5];
    const third = rollChinchiroOnce(second.attempts, () => thirdValues.shift()!);
    expect(third.attempts).toHaveLength(3);
    expect(third.kind).toBe("menashi");
    expect(isChinchiroHandComplete(third)).toBe(true);
  });

  it("提示された200区分の割合どおりに役を抽選する", () => {
    const counts = new Map<string, number>();
    const pointCounts = new Map<number, number>();
    for (let unit = 0; unit < 200; unit++) {
      let first = true;
      const outcome = rollChinchiroThrow(() => {
        if (first) {
          first = false;
          return (unit + 0.5) / 200;
        }
        return 0.5;
      });
      counts.set(outcome.kind, (counts.get(outcome.kind) ?? 0) + 1);
      if (outcome.kind === "point") {
        pointCounts.set(outcome.rank, (pointCounts.get(outcome.rank) ?? 0) + 1);
      }
    }
    expect(Object.fromEntries(counts)).toEqual({
      pinzoro: 1,
      arashi: 5,
      shigoro: 5,
      hifumi: 5,
      point: 84,
      menashi: 96,
      shonben: 4,
    });
    expect(Object.fromEntries(pointCounts)).toEqual({
      1: 14,
      2: 14,
      3: 14,
      4: 14,
      5: 14,
      6: 14,
    });
  });

  it("目・ゾロ目・特殊役の出目を確率カテゴリに合わせて生成する", () => {
    const rollAt = (unit: number) => {
      let first = true;
      return rollChinchiroThrow(() => {
        if (first) {
          first = false;
          return (unit + 0.5) / 200;
        }
        return 0.5;
      });
    };

    const point = rollAt(16);
    expect(point.kind).toBe("point");
    expect(point.dice.filter((die) => die === point.rank)).toHaveLength(1);
    const pair = point.dice.filter((die) => die !== point.rank);
    expect(pair).toHaveLength(2);
    expect(pair[0]).toBe(pair[1]);

    const menashi = rollAt(100);
    expect(menashi.kind).toBe("menashi");
    expect(new Set(menashi.dice).size).toBe(3);
    expect([...menashi.dice].sort().join("")).not.toBe("123");
    expect([...menashi.dice].sort().join("")).not.toBe("456");
    expect(rollAt(196).kind).toBe("shonben");
  });

  it("ションベンはその場で手番を終え、目なしは最大3投まで振り直せる", () => {
    const values = [100.5 / 200, 0.5, 196.5 / 200, 0.5, 0.5, 0.5];
    let index = 0;
    const result = rollChinchiroHand(() => values[index++]!);
    expect(result.kind).toBe("shonben");
    expect(result.attempts).toHaveLength(2);
    expect(isChinchiroHandComplete(result)).toBe(true);
  });

  it("勝者へは元の賭け金返却と役倍率分を加算し、ヒフミ敗北は最低2倍にする", () => {
    expect(calculateChinchiroPayout(
      1_000,
      { kind: "pinzoro" },
      { kind: "point" },
    )).toEqual({ multiplier: 5, winnerNet: 5_000 });
    expect(calculateChinchiroPayout(
      1_000,
      { kind: "point" },
      { kind: "hifumi" },
    )).toEqual({ multiplier: 2, winnerNet: 2_000 });
  });

  it("役の強さで勝敗を比較し、同じ強さは引き分けにする", () => {
    const pinzoro = evaluateChinchiroRoll([[1, 1, 1]]);
    const shigoro = evaluateChinchiroRoll([[4, 5, 6]]);
    const six = evaluateChinchiroRoll([[2, 2, 6]]);
    const anotherSix = evaluateChinchiroRoll([[3, 3, 6]]);

    expect(compareChinchiroOutcomes(pinzoro, shigoro)).toBe(1);
    expect(compareChinchiroOutcomes(shigoro, six)).toBe(1);
    expect(compareChinchiroOutcomes(six, anotherSix)).toBe(0);
  });

  it("ニックネーム、グローバル表示名、ユーザー名の順で表示名を選ぶ", () => {
    expect(getChinchiroDisplayName({
      displayName: "さくら",
      user: { globalName: "Sakura", username: "sakura123" },
    })).toBe("さくら");
    expect(getChinchiroDisplayName({
      user: { globalName: "Sakura", username: "sakura123" },
    })).toBe("Sakura");
    expect(getChinchiroDisplayName({
      user: { username: "sakura123" },
    })).toBe("sakura123");
    expect(getChinchiroDisplayName(null)).toBe("参加者");
  });

  it("挑戦状・対戦中・決着のEmbedに生のユーザーIDを表示しない", () => {
    const challengerId = "1467371766992080988";
    const opponentId = "784770889056911380";
    const game: ChinchiroGame = {
      id: 42,
      guildId: "guild",
      channelId: "channel",
      messageId: null,
      challengerId,
      opponentId,
      bet: 1_000,
      currencyName: "コイン",
      status: "active",
      challengerRoll: null,
      opponentRoll: null,
      expiresAt: new Date("2026-09-07T00:00:00.000Z"),
      createdAt: new Date("2026-09-07T00:00:00.000Z"),
      updatedAt: new Date("2026-09-07T00:00:00.000Z"),
    };
    const names = { challenger: "さくら", opponent: "resub" };
    const outcome = evaluateChinchiroRoll([[4, 5, 6]]);
    const resultGame = {
      ...game,
      challengerRoll: JSON.stringify(outcome),
      opponentRoll: JSON.stringify(outcome),
      status: "settled",
    } as ChinchiroGame;
    const serialized = [
      buildChallengeEmbed(game, names),
      buildActiveEmbed(game, names),
      buildResultEmbed({
        game: resultGame,
        challengerOutcome: outcome,
        opponentOutcome: outcome,
        winnerId: null,
      }, names),
    ].map((embed) => JSON.stringify(embed.toJSON())).join("\n");

    expect(serialized).toContain("さくら");
    expect(serialized).toContain("resub");
    expect(serialized).not.toContain(challengerId);
    expect(serialized).not.toContain(opponentId);
    expect(serialized).not.toContain("強さ:");
    expect(serialized).not.toContain("最大3回");
  });
});