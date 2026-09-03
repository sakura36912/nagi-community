import { describe, expect, it } from "vitest";
import {
  addCasinoRound,
  addCasinoSessionRound,
  buildCasinoResultFields,
  CASINO_NET_LEDGER_MARKER,
  clearCasinoResultSessions,
  emptyCasinoResultTotals,
  resolveCasinoLedgerAmounts,
} from "../lib/casinoResult.js";

describe("カジノ結果の累計", () => {
  it("払い出しは実際に残高へ加算された金額だけを合計し、収支は純利益を保つ", () => {
    const won = addCasinoRound(emptyCasinoResultTotals(), 1_000, 2_000, 1_000);
    const totals = addCasinoRound(won, 1_000, 0, -1_000);

    expect(totals).toEqual({
      totalBet: 2_000,
      totalPayout: 1_000,
      totalNet: 0,
      games: 2,
    });
    expect(buildCasinoResultFields(totals, "＄")).toEqual([
      { name: "賭け金額", value: "**2,000** ＄", inline: true },
      { name: "払い出し金額", value: "+**1,000** ＄", inline: true },
      { name: "収支", value: "±**0** ＄", inline: true },
    ]);
  });

  it("負けたゲームは払い出しと収支の両方へ賭け金をマイナス計上する", () => {
    const totals = addCasinoRound(emptyCasinoResultTotals(), 1_000, 0, -1_000);

    expect(totals).toEqual({
      totalBet: 1_000,
      totalPayout: -1_000,
      totalNet: -1_000,
      games: 1,
    });
  });

  it("引き分けは返却額を払い出しへ加え、収支はゼロのままにする", () => {
    const totals = addCasinoRound(emptyCasinoResultTotals(), 1_000, 1_000, 0);

    expect(totals).toEqual({
      totalBet: 1_000,
      totalPayout: 1_000,
      totalNet: 0,
      games: 1,
    });
  });

  it("同じゲームの連続プレイをセッション累計し、期限後は新規セッションにする", () => {
    clearCasinoResultSessions();
    const won = addCasinoSessionRound("slot", "g1", "u1", 1_000, 2_000, 1_000, 1_000);
    const replayed = addCasinoSessionRound("slot", "g1", "u1", 1_000, 0, -1_000, 2_000);
    const expired = addCasinoSessionRound(
      "slot", "g1", "u1", 2_000, 2_000, 0, 5 * 60 * 1000 + 2_001,
    );

    expect(won.games).toBe(1);
    expect(replayed).toEqual({
      totalBet: 2_000,
      totalPayout: 1_000,
      totalNet: 0,
      games: 2,
    });
    expect(expired).toEqual({
      totalBet: 2_000,
      totalPayout: 2_000,
      totalNet: 0,
      games: 1,
    });
  });

  it("旧スロット履歴と新しい純利益履歴をそれぞれ正しい意味で集計する", () => {
    expect(resolveCasinoLedgerAmounts("slot", 2_000, 1_000, "スロット当選（賭け: 1000）"))
      .toEqual({ payout: 2_000, net: 1_000 });
    expect(resolveCasinoLedgerAmounts(
      "slot",
      1_000,
      1_000,
      `スロット当選（賭け: 1000）${CASINO_NET_LEDGER_MARKER}`,
    )).toEqual({ payout: 2_000, net: 1_000 });
    expect(resolveCasinoLedgerAmounts(
      "slot",
      -1_000,
      1_000,
      `スロットハズレ（賭け: 1000）${CASINO_NET_LEDGER_MARKER}`,
    )).toEqual({ payout: -1_000, net: -1_000 });
  });
});