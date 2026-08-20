import { describe, expect, it, vi } from "vitest";
import { drawForGuess } from "../commands/highlow.js";

const currentValue = 7;
const deck = [
  { rank: "6", suit: "♠" },
  { rank: "8", suit: "♥" },
  { rank: "7", suit: "♦" },
] as const;

describe("ハイアンドローの当選確率", () => {
  it("100%ではHIGH予想に対して必ず高いカードを選ぶ", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const [card, remaining] = drawForGuess([...deck], currentValue, "high", 100);

    expect(card.rank).toBe("8");
    expect(remaining).toHaveLength(2);
    vi.restoreAllMocks();
  });

  it("0%ではHIGH予想に対して必ず低いカードを選ぶ", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const [card, remaining] = drawForGuess([...deck], currentValue, "high", 0);

    expect(card.rank).toBe("6");
    expect(remaining).toHaveLength(2);
    vi.restoreAllMocks();
  });
});