export interface CasinoResultTotals {
  totalBet: number;
  totalPayout: number;
  totalNet: number;
  games: number;
}

const SESSION_TTL_MS = 5 * 60 * 1000;
const casinoSessions = new Map<string, { totals: CasinoResultTotals; updatedAt: number }>();
export const CASINO_NET_LEDGER_MARKER = "[net-v2]";

export function emptyCasinoResultTotals(): CasinoResultTotals {
  return { totalBet: 0, totalPayout: 0, totalNet: 0, games: 0 };
}

/**
 * creditedAmount is the amount actually added back to the wallet after the bet
 * was deducted. The payout display is signed: a losing round contributes the
 * negative bet, while wins and pushes contribute the actual credited amount.
 */
export function addCasinoRound(
  totals: CasinoResultTotals,
  bet: number,
  creditedAmount: number,
  netDelta: number,
): CasinoResultTotals {
  return {
    totalBet: totals.totalBet + bet,
    totalPayout: totals.totalPayout + (creditedAmount > 0 ? creditedAmount : netDelta),
    totalNet: totals.totalNet + netDelta,
    games: totals.games + 1,
  };
}

/**
 * Consecutive command executions for the same game/user are treated as one
 * replay session. An inactive session expires after five minutes.
 */
export function addCasinoSessionRound(
  game: string,
  guildId: string,
  userId: string,
  bet: number,
  creditedAmount: number,
  netDelta: number,
  now = Date.now(),
): CasinoResultTotals {
  const key = `${game}:${guildId}:${userId}`;
  const current = casinoSessions.get(key);
  const base = current && now - current.updatedAt <= SESSION_TTL_MS
    ? current.totals
    : emptyCasinoResultTotals();
  const totals = addCasinoRound(base, bet, creditedAmount, netDelta);
  casinoSessions.set(key, { totals, updatedAt: now });
  return totals;
}

export function clearCasinoResultSessions(): void {
  casinoSessions.clear();
}

/**
 * Convert a transaction row into the same signed payout/net meanings used by
 * result embeds. Legacy slot wins stored gross credit rather than net profit;
 * rows with the v2 marker and every other game store net profit directly.
 */
export function resolveCasinoLedgerAmounts(
  game: string,
  amount: number,
  bet: number,
  reason: string,
): { payout: number; net: number } {
  if (game === "slot" && !reason.includes(CASINO_NET_LEDGER_MARKER)) {
    return {
      payout: amount > 0 ? amount : amount,
      net: amount > 0 ? amount - bet : amount,
    };
  }
  return {
    payout: amount > 0 ? bet + amount : amount === 0 ? bet : amount,
    net: amount,
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
      value: `**${totals.totalBet.toLocaleString()}** ${currencyName}`,
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