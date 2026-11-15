import { describe, expect, it } from "vitest";
import {
  CHINCHIRO_MAX_BET,
  CHOHAN_MAX_BET,
  clampChinchiroMaxBet,
  dealerCasinoMaximumBet,
} from "../../../../lib/db/src/gameBetLimits";

describe("requested game bet ceilings", () => {
  it("caps ChinChiro at 50,000 while preserving a lower configured limit", () => {
    expect(CHINCHIRO_MAX_BET).toBe(50_000);
    expect(clampChinchiroMaxBet(100_000)).toBe(50_000);
    expect(clampChinchiroMaxBet(25_000)).toBe(25_000);
  });

  it("sets Cho-Han to 50,000 without changing the configured Poker maximum", () => {
    expect(CHOHAN_MAX_BET).toBe(50_000);
    expect(dealerCasinoMaximumBet("chohan", 10_000)).toBe(50_000);
    expect(dealerCasinoMaximumBet("poker", 10_000)).toBe(10_000);
  });
});
