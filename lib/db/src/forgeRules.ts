import { randomInt } from "node:crypto";

export class ForgeError extends Error {}
export const FORGE_MAX_INT = 2_147_483_647;

/** 内部数値は公開用の表示データに含めない。バランス調整はこの定義で一元管理する。 */
export const FORGE_WEAPONS = {
  greatsword: { name: "大剣", skill: "渾身斬り", attack: 16, defense: 10, attackGrowth: 4, defenseGrowth: 2 },
  sword: { name: "片手剣", skill: "連撃", attack: 12, defense: 12, attackGrowth: 3, defenseGrowth: 3 },
  spear: { name: "槍", skill: "鉄壁", attack: 12, defense: 16, attackGrowth: 3, defenseGrowth: 4 },
  bow: { name: "弓", skill: "貫通矢", attack: 14, defense: 6, attackGrowth: 4, defenseGrowth: 1 },
  dual: { name: "双剣", skill: "乱舞", attack: 14, defense: 8, attackGrowth: 4, defenseGrowth: 2 },
  staff: { name: "杖", skill: "ヒール", attack: 8, defense: 10, attackGrowth: 2, defenseGrowth: 2 },
} as const;
export type ForgeWeaponType = keyof typeof FORGE_WEAPONS;
export function isForgeWeaponType(value: string): value is ForgeWeaponType {
  return Object.hasOwn(FORGE_WEAPONS, value);
}
export function forgeInteger(value: number, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum || value > FORGE_MAX_INT) {
    throw new ForgeError(`${minimum.toLocaleString()}〜${FORGE_MAX_INT.toLocaleString()}の整数で指定してください。`);
  }
  return value;
}
export function forgeStats(type: ForgeWeaponType, level: number) {
  forgeInteger(level, 1);
  const profile = FORGE_WEAPONS[type];
  return {
    attack: forgeInteger(profile.attack + (level - 1) * profile.attackGrowth),
    defense: forgeInteger(profile.defense + (level - 1) * profile.defenseGrowth),
    skill: profile.skill,
  };
}
/** 料金の例がないレベルは、管理者が設定するまで課金しない。 */
export function defaultForgeCost(level: number): number | null {
  return ({ 1: 1000, 2: 3000, 3: 5000 } as Record<number, number>)[level] ?? null;
}
export function defaultForgeRate(level: number) {
  forgeInteger(level, 1);
  return Math.max(30, 100 - (level - 1) * 5);
}
export function resolveForgeSetting(level: number, override?: { cost: number | null; successRate: number | null }) {
  return { level, cost: override?.cost ?? defaultForgeCost(level), successRate: override?.successRate ?? defaultForgeRate(level) };
}
/** 一般ユーザーに渡してよい情報だけを明示的に選ぶ。 */
export function publicForgeWeapon(weapon: { weaponType: string; weaponLevel: number },
  setting: { cost: number | null; successRate: number }) {
  if (!isForgeWeaponType(weapon.weaponType)) throw new ForgeError("武器設定に不整合があります。管理者にお問い合わせください。");
  const profile = FORGE_WEAPONS[weapon.weaponType];
  return { name: profile.name, level: weapon.weaponLevel, skill: profile.skill, nextCost: setting.cost, successRate: setting.successRate };
}
export function forgeRoll() {
  return randomInt(0, 1_000_000) / 1_000_000;
}
/** ボス側でロール資格・戦闘参加資格を検証した後に呼ぶ。数値は公開しない。 */
export function calculateForgeDamage(
  weapon: { weaponType: string; weaponLevel: number; attack: number },
  options: { roleMultiplier?: number; criticalChance?: number; criticalMultiplier?: number } = {},
  roll: () => number = forgeRoll,
) {
  if (!isForgeWeaponType(weapon.weaponType)) throw new ForgeError("未対応の武器です。");
  forgeInteger(weapon.weaponLevel, 1);
  forgeInteger(weapon.attack);
  const role = options.roleMultiplier ?? 1;
  const chance = options.criticalChance ?? 0.1;
  const criticalMultiplier = options.criticalMultiplier ?? 1.5;
  if (!Number.isFinite(role) || role < 0 || !Number.isFinite(chance) || chance < 0 || chance > 1
    || !Number.isFinite(criticalMultiplier) || criticalMultiplier < 1) throw new ForgeError("戦闘補正が不正です。");
  const variance = roll(), criticalRoll = roll();
  if (![variance, criticalRoll].every(n => Number.isFinite(n) && n >= 0 && n < 1)) throw new ForgeError("乱数が不正です。");
  const critical = criticalRoll < chance;
  const damage = Math.floor(weapon.attack * role * (0.9 + variance * 0.2) * (critical ? criticalMultiplier : 1));
  forgeInteger(damage);
  return { damage, critical, skill: FORGE_WEAPONS[weapon.weaponType].skill };
}
