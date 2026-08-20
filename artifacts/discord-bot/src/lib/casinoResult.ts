export interface CasinoResultTotals {
  totalBet: number;
  totalPayout: number;
  totalNet: number;
  games: number;
}

export function emptyCasinoResultTotals(): CasinoResultTotals {
  return { totalBet: 0, totalPayout: 0, totalNet: 0, games: 0 };
}

/**
 * A round's payout is the amount actually credited after its bet has already
 * been deducted. A losing round therefore contributes zero payout.
 */
export function addCasinoRound(
  totals: CasinoResultTotals,
  bet: number,
  payout: number,
): CasinoResultTotals {
  return {
    totalBet: totals.totalBet + bet,
    totalPayout: totals.totalPayout + payout,
    totalNet: totals.totalNet + payout - bet,
    games: totals.games + 1,
  };
}

export function formatSignedAmount(amount: number, currencyName: string): string {
  const prefix = amount > 0 ? "+" : amount === 0 ? "±" : "";
  return `${prefix}**${amount.toLocaleString()}** ${currencyName}`;
}

export function buildCasinoResultFields(
  totals: CasinoResultTotals,
  currencyName: string,
) {
  return [
    {
      name: "賭け金額",
      value: `+**${totals.totalBet.toLocaleString()}** ${currencyName}`,
      inline: true,
    },
    {
      name: "払い出し金額",
      value: formatSignedAmount(totals.totalPayout, currencyName),
      inline: true,
    },
    {
      name: "収支",
      value: formatSignedAmount(totals.totalNet, currencyName),
      inline: true,
    },
  ];
}