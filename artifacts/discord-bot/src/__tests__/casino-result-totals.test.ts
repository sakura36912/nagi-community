import { describe, expect, it } from "vitest";
import {
  addCasinoRound,
  buildCasinoResultFields,
  emptyCasinoResultTotals,
} from "../lib/casinoResult.js";

describe("カジノ結果の累計", () => {
  it("払い出しは実際に残高へ加算された金額だけを合計し、収支は純利益を保つ", () => {
    const won = addCasinoRound(emptyCasinoResultTotals(), 1_000, 2_000);
    const totals = addCasinoRound(won, 1_000, 0);

    expect(totals).toEqual({
      totalBet: 2_000,
      totalPayout: 2_000,
      totalNet: 0,
      games: 2,
    });
    expect(buildCasinoResultFields(totals, "＄")).toEqual([
      { name: "賭け金額", value: "+**2,000** ＄", inline: true },
      { name: "払い出し金額", value: "+**2,000** ＄", inline: true },
      { name: "収支", value: "±**0** ＄", inline: true },
    ]);
  });

  it("負けたゲームは払い出しを増やさず、賭け金だけを純損失にする", () => {
    const totals = addCasinoRound(emptyCasinoResultTotals(), 1_000, 0);

    expect(totals).toEqual({
      totalBet: 1_000,
      totalPayout: 0,
      totalNet: -1_000,
      games: 1,
    });
  });
});