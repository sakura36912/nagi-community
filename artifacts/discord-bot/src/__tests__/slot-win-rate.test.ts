import { describe, expect, it, vi } from "vitest";
import { evaluatePaylines, spinGridWithWinRate } from "../commands/slot.js";

const pool = ["🍒", "🍋"];

describe("スロットの当選確率設定", () => {
  it("100%では少なくとも1ラインが当選する", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);

    const grid = spinGridWithWinRate(pool, 100);

    expect(evaluatePaylines(grid).some((line) => line.won)).toBe(true);
    vi.restoreAllMocks();
  });

  it("0%では当選ラインを作らない", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);

    const grid = spinGridWithWinRate(pool, 0);

    expect(evaluatePaylines(grid).some((line) => line.won)).toBe(false);
    vi.restoreAllMocks();
  });

  it("確率未設定時は従来どおり重みに基づく通常抽選を使う", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);

    const grid = spinGridWithWinRate(pool, null);

    expect(evaluatePaylines(grid).some((line) => line.won)).toBe(true);
    vi.restoreAllMocks();
  });

  it("中間の確率設定は指定値に近い当選率になる", () => {
    const trials = 1_000;
    let wins = 0;
    for (let i = 0; i < trials; i++) {
      if (evaluatePaylines(spinGridWithWinRate(pool, 40)).some((line) => line.won)) {
        wins++;
      }
    }

    expect(wins / trials).toBeGreaterThan(0.32);
    expect(wins / trials).toBeLessThan(0.48);
  });
});