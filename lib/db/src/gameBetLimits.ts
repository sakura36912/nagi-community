export const CHINCHIRO_MAX_BET = 50_000;
export const CHOHAN_MAX_BET = 50_000;

export function clampChinchiroMaxBet(configuredMax: number): number {
  return Math.min(configuredMax, CHINCHIRO_MAX_BET);
}

export function dealerCasinoMaximumBet(
  gameType: string,
  configuredMax: number,
): number {
  return gameType === "chohan" ? CHOHAN_MAX_BET : configuredMax;
}
