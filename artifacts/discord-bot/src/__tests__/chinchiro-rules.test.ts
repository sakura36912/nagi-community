import { describe, expect, it } from "vitest";
import type { ChinchiroGame } from "@workspace/db";
import {
  buildActiveEmbed,
  buildChallengeEmbed,
  buildResultEmbed,
  compareChinchiroOutcomes,
  evaluateChinchiroRoll,
  getChinchiroDisplayName,
  rollChinchiroHand,
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
    const values = [
      0 / 6, 1 / 6, 3 / 6,
      1 / 6, 2 / 6, 4 / 6,
      3 / 6, 4 / 6, 5 / 6,
    ];
    let index = 0;
    const result = rollChinchiroHand(() => values[index++]!);
    expect(result.kind).toBe("shigoro");
    expect(result.attempts).toHaveLength(3);
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
  });
});