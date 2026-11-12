export const PET_RARITIES = ["normal", "rare", "epic", "legend", "mythic"] as const;
export type PetRarity = typeof PET_RARITIES[number];
export const PET_RARITY_NAMES: Record<PetRarity, string> = {
  normal: "ノーマル", rare: "レア", epic: "エピック", legend: "レジェンド", mythic: "ミシック",
};
export const PET_SPECIES: Record<PetRarity, string[]> = {
  normal: [],
  rare: ["オオカミ", "キツネ", "フクロウ", "サメ", "イルカ", "タコ", "アザラシ", "シャチ", "ホワイトタイガー", "ゴースト"],
  epic: ["フェンリル", "ユニコーン", "グリフォン", "ワイバーン", "クラーケン幼体", "ゴーレム", "セイレーン", "ケルピー", "深海蛇", "クリスタルウルフ"],
  legend: ["フェニックス", "リヴァイアサン", "バハムート", "麒麟", "九尾の狐", "ケルベロス", "深海龍", "海神の使い", "ベヒーモス", "天空竜"],
  mythic: ["古代クラーケン", "神狼オーディン", "世界樹の精霊", "星竜", "時空竜", "深淵の王", "海賊王の守護獣", "海神ポセイドンの眷属", "不死鳥王", "終焉龍"],
};
/** Prices and growth amounts deliberately have no economic defaults. */
export const PET_SETTING_LABELS = {
  normal_price: "ノーマル卵の価格", rare_price: "レア卵の価格", food_price: "エサの価格", toy_price: "おもちゃの価格",
  xp_base: "必要経験値の基準（次レベル＝基準×現在Lv）", xp_multiplier: "経験値倍率",
  level_cap: "レベル上限（1～100）", message_xp: "メッセージ経験値",
  message_interval: "メッセージ経験値の獲得間隔（秒）",
  vc_xp: "VC経験値", vc_interval: "VC経験値の獲得間隔（秒）",
  hunger_interval: "満腹度が減る間隔（秒）", hunger_loss: "1間隔あたり満腹度減少",
  feed_hunger: "エサの満腹度回復", feed_xp: "エサの経験値", feed_bond: "エサの親密度",
  pet_bond: "撫でる親密度", play_xp: "遊ぶ経験値", play_bond: "遊ぶ親密度",
  feed_neglect_interval: "エサ不足で弱るまで（秒）",
  play_neglect_interval: "遊び不足で弱るまで（秒）",
  vet_price: "獣医の治療費", vet_hunger: "治療による満腹度回復",
} as const;
export type PetSettingKey = keyof typeof PET_SETTING_LABELS;
export type PetSettings = Partial<Record<PetSettingKey, number>> & { species?: Partial<Record<PetRarity, string[]>> };
export class PetError extends Error {}
export function petInteger(n: number, min = 0, max = 1_000_000_000) {
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new PetError(`数値は${min}～${max}の整数で指定してください。`);
  return n;
}
export function petSetting(settings: PetSettings, key: PetSettingKey) {
  const n = settings[key];
  if (n === undefined) throw new PetError(`「${PET_SETTING_LABELS[key]}」が未設定です。管理者に設定を依頼してください。`);
  return n;
}
export function validatePetSetting(key: PetSettingKey, n: number) {
  if (!(key in PET_SETTING_LABELS)) throw new PetError("未対応の設定です。");
  if (key === "xp_multiplier") {
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new PetError("倍率は0～100で指定してください。");
    return n;
  }
  return petInteger(n, key === "level_cap" || key === "xp_base" || key.endsWith("_interval") ? 1 : 0,
    key === "level_cap" ? 100 : key.endsWith("_hunger") || key.endsWith("_bond") || key === "hunger_loss" ? 100 : 1_000_000_000);
}
export function petDay(now: number) { return new Date(now + 9 * 3_600_000).toISOString().slice(0, 10); }
export function petSpecies(settings: PetSettings, rarity: PetRarity) {
  return settings.species?.[rarity] ?? PET_SPECIES[rarity];
}
export type PetIndividual = {
  id: string; name: string; species: string; rarity: PetRarity; level: number; xp: number;
  hunger: number; bond: number; bornAt: number; hungerAt: number;
  lastFeedAt?: number; lastPlayAt?: number; treatedAt?: number;
  weak?: { since: number; reason: "feed" | "play" | "both" };
};
export type PetAccount = {
  pet: PetIndividual | null;
  eggs: Partial<Record<PetRarity, number>>; food: number; toys?: number;
  day: string; petsToday: number; playsToday: number;
  messageAt?: number; vc?: { epoch: string; channel: string; at: number; seconds: number };
};
export function newPetAccount(): PetAccount {
  return { pet: null, eggs: {}, food: 0, toys: 0, day: "", petsToday: 0, playsToday: 0 };
}
/** Lazy decay also covers bot downtime; no timer is needed for hunger. */
export function refreshPet(a: PetAccount, s: PetSettings, now: number) {
  a.toys ??= 0;
  if (a.day !== petDay(now)) { a.day = petDay(now); a.petsToday = 0; a.playsToday = 0; }
  const p = a.pet;
  if (!p) return;
  // Weakness is latched: normal care remains possible, but only a vet clears it.
  if (!p.weak) {
    const feedDeadline = s.feed_neglect_interval === undefined ? Infinity
      : Math.max(p.lastFeedAt ?? p.bornAt, p.treatedAt ?? p.bornAt) + s.feed_neglect_interval * 1000;
    const playDeadline = s.play_neglect_interval === undefined ? Infinity
      : Math.max(p.lastPlayAt ?? p.bornAt, p.treatedAt ?? p.bornAt) + s.play_neglect_interval * 1000;
    const feed = now >= feedDeadline, play = now >= playDeadline;
    if (feed || play) p.weak = { since: Math.min(feedDeadline, playDeadline), reason: feed && play ? "both" : feed ? "feed" : "play" };
  }
  if (s.hunger_interval === undefined || s.hunger_loss === undefined) {
    p.hungerAt = now; // Do not retroactively decay an unconfigured period.
    return;
  }
  const steps = Math.floor(Math.max(0, now - p.hungerAt) / (s.hunger_interval * 1000));
  p.hunger = Math.max(0, p.hunger - steps * s.hunger_loss);
  p.hungerAt += steps * s.hunger_interval * 1000;
}
export function addPetXp(p: PetIndividual, s: PetSettings, amount: number) {
  petInteger(amount);
  const base = petSetting(s, "xp_base");
  const multiplier = petSetting(s, "xp_multiplier");
  const cap = s.level_cap ?? 100;
  if (p.level >= cap) return; // Lowering the cap never demotes existing pets.
  p.xp = Math.min(Number.MAX_SAFE_INTEGER, p.xp + Math.floor(amount * multiplier));
  while (p.level < cap && p.xp >= base * p.level) {
    p.xp -= base * p.level;
    p.level++;
  }
  if (p.level >= cap) p.xp = 0;
}
