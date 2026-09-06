import { describe, expect, it } from "vitest";
import {
  compareChinchiroOutcomes,
  evaluateChinchiroRoll,
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
});