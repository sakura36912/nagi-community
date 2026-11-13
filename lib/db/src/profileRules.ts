export const PROFILE_FIELD_LABELS = {
  joinDate: "加入日",
  bounty: "懸賞金",
  roles: "ロール",
  battle: "戦闘情報",
  pvp: "PvP戦績",
  casino: "カジノ情報",
  kpRank: "KP島ランク",
  inventory: "所持品",
  pet: "ペット",
} as const;

export type ProfileField = keyof typeof PROFILE_FIELD_LABELS;
export const PROFILE_FIELDS = Object.keys(PROFILE_FIELD_LABELS) as ProfileField[];
export const PROFILE_RANK_TIERS = ["regular", "vip", "vip_plus", "special"] as const;
export type ProfileRankTier = typeof PROFILE_RANK_TIERS[number];
export const PROFILE_RANK_LABELS: Record<ProfileRankTier, string> = {
  regular: "一般会員",
  vip: "VIP",
  vip_plus: "VIP+",
  special: "特別会員",
};
export const PROFILE_RANK_PRIORITY: Record<ProfileRankTier, number> = {
  regular: 0, vip: 1, vip_plus: 2, special: 3,
};
export const PROFILE_FRAME_STYLES = ["wanted", "gold", "royal"] as const;
export type ProfileFrameStyle = typeof PROFILE_FRAME_STYLES[number];

export interface ProfileSettings {
  displayRoleIds: string[];
  rankRoles: { roleId: string; tier: ProfileRankTier }[];
  visibleFields: Partial<Record<ProfileField, boolean>>;
  color: number | null;
  backgroundUrl: string | null;
  frameStyle: ProfileFrameStyle;
}

export const DEFAULT_PROFILE_SETTINGS: ProfileSettings = {
  displayRoleIds: [],
  rankRoles: [],
  visibleFields: Object.fromEntries(PROFILE_FIELDS.map(field => [field, true])) as Record<ProfileField, boolean>,
  color: null,
  backgroundUrl: null,
  frameStyle: "wanted",
};

export interface CasinoLedgerRow {
  amount: number;
  reason: string;
}
export interface DealerCasinoRow {
  bet: number;
  payout: number;
  result: string;
}
export interface ProfileCasinoStats {
  totalBet: number;
  net: number;
  wins: number;
  maxPayout: number;
  games: number;
}

const CASINO_PREFIXES = [
  "BJ", "ポーカー", "ルーレット", "スロット", "ハイアンドロー", "バカラ", "チンチロ",
];
const BET_REGEX = /（賭け: (\d+)）/;

/** Mirrors the saved-ledger accounting used by /casino stats; no session cache is used. */
export function getProfileCasinoStats(
  ledgerRows: CasinoLedgerRow[],
  dealerRows: DealerCasinoRow[] = [],
): ProfileCasinoStats {
  const stats: ProfileCasinoStats = { totalBet: 0, net: 0, wins: 0, maxPayout: 0, games: 0 };
  for (const row of ledgerRows) {
    if (!CASINO_PREFIXES.some(prefix => row.reason.startsWith(prefix))) continue;
    const bet = Number(BET_REGEX.exec(row.reason)?.[1] ?? 0);
    const slotLegacy = row.reason.startsWith("スロット") && !row.reason.includes("[net-v2]");
    const payout = slotLegacy
      ? row.amount
      : row.amount > 0 ? bet + row.amount : row.amount === 0 ? bet : row.amount;
    const net = slotLegacy && row.amount > 0 ? row.amount - bet : row.amount;
    stats.totalBet += bet;
    stats.net += net;
    if (row.amount > 0) stats.wins++;
    stats.maxPayout = Math.max(stats.maxPayout, payout);
    stats.games++;
  }
  for (const row of dealerRows) {
    stats.totalBet += row.bet;
    stats.net += row.payout - row.bet;
    if (row.result === "WON") stats.wins++;
    stats.maxPayout = Math.max(stats.maxPayout, row.payout);
    stats.games++;
  }
  return stats;
}

export function configuredProfileRank(
  userRoleIds: string[],
  rankRoles: ProfileSettings["rankRoles"],
): ProfileRankTier | null {
  return rankRoles
    .filter(entry => userRoleIds.includes(entry.roleId))
    .sort((a, b) => PROFILE_RANK_PRIORITY[b.tier] - PROFILE_RANK_PRIORITY[a.tier])[0]?.tier ?? null;
}
