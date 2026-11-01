import { forgeRoll, isForgeWeaponType, FORGE_WEAPONS, FORGE_MAX_INT } from "./forgeRules";

export class BossError extends Error {}
export type BossType = "kraken" | "megalodon" | "leviathan";
export type BossSpecial = "none" | "double_attack" | "double_reward" | "damage_boost" | "double_heal";
export type BossMode = "solo" | "party";
export type BattleStatus = "waiting" | "active" | "won" | "failed" | "cancelled";
export const BOSS_NAMES: Record<BossType, string> = {
  kraken: "クラーケン", megalodon: "メガロドン", leviathan: "リヴァイアサン",
};
export interface BossConfig {
  soloHp: number; partyHp: number; attack: number; defense: number; reward: number;
  durationSeconds: number; lobbySeconds: number; playerHp: number; healAmount: number;
  counterEvery: number; cooldownSeconds: number; criticalPercent: number;
  criticalMultiplier: number; levelBonusPercent: number;
  special: BossSpecial; bonusRoleId: string | null; roleMultiplier: number;
  attackCooldownSeconds?: number; healCooldownSeconds?: number;
  playerHpSource?: "wallet";
  healingMode?: "max_hp_10_percent";
}
export interface BossWeaponSnapshot {
  weaponType: string; weaponLevel: number; attack: number; defense: number; roleMultiplier: number;
}
export interface BossEffects {
  bleedTicks: number; vulnerableTicks: number; shield: boolean;
  attackReadyAt?: number; healReadyAt?: number;
}
/** Legacy events have no separate settings; never reuse their shared action timer. */
export function bossCooldownSeconds(config: BossConfig, action: "attack" | "heal") {
  return action === "attack" ? config.attackCooldownSeconds ?? 5 : config.healCooldownSeconds ?? 30;
}
export interface BossFighter {
  userId: string; displayName: string; hp: number; maxHp: number; damage: number;
  attackCount: number; weapon: BossWeaponSnapshot; effects: BossEffects;
}
export interface BossActionResult {
  battleId: string; mode: BossMode; state: BattleStatus; bossHp: number;
  damage?: number; healed?: number; critical?: boolean; skill?: string;
  paid?: number; balance?: number; userHp?: number; messages: string[]; repeated?: boolean;
}
export function bossInteger(n: number, min = 0, max = FORGE_MAX_INT) {
  if (!Number.isInteger(n) || n < min || n > max) throw new BossError(`${min}〜${max}の整数で指定してください。`);
  return n;
}
export function validateBossConfig(type: string, config: BossConfig) {
  if (!Object.hasOwn(BOSS_NAMES, type)) throw new BossError("未対応のボスです。");
  if (config.playerHpSource !== undefined && config.playerHpSource !== "wallet") throw new BossError("HPの設定が不正です。");
  if (config.healingMode !== undefined && config.healingMode !== "max_hp_10_percent") throw new BossError("回復の設定が不正です。");
  for (const key of ["soloHp", "partyHp", "attack", "playerHp", "healAmount"] as const) bossInteger(config[key], 1);
  for (const key of ["defense", "reward"] as const) bossInteger(config[key]);
  bossInteger(config.durationSeconds, 1, 604800);
  bossInteger(config.lobbySeconds, 1, config.durationSeconds);
  bossInteger(config.counterEvery, 1, 100);
  bossInteger(config.cooldownSeconds, 1, 3600);
  bossInteger(bossCooldownSeconds(config, "attack"), 0, 3600);
  bossInteger(bossCooldownSeconds(config, "heal"), 1, 3600);
  bossInteger(config.criticalPercent, 0, 100);
  bossInteger(config.levelBonusPercent, 0, 100);
  for (const multiplier of [config.criticalMultiplier, config.roleMultiplier]) {
    if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 10) throw new BossError("倍率は1〜10で指定してください。");
  }
  if (!["none", "double_attack", "double_reward", "damage_boost", "double_heal"].includes(config.special)) throw new BossError("特殊イベントが不正です。");
  bossInteger(config.reward * (config.special === "double_reward" ? 2 : 1));
}
function random(roll: () => number) {
  const value = roll();
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw new BossError("乱数の値が不正です。");
  return value;
}
/** Generated once at hosting, then persisted in the event's existing config snapshot. */
export function generateBossCombatStats(type: BossType, roll: () => number = forgeRoll) {
  if (!Object.hasOwn(BOSS_NAMES, type)) throw new BossError("未対応のボスです。");
  // Balanced around level-one weapon attacks (8–16), with stronger bosses for upgraded weapons.
  const profiles = {
    kraken: { hp: [300, 450], attack: [25, 35] },
    megalodon: { hp: [450, 650], attack: [35, 45] },
    leviathan: { hp: [650, 900], attack: [45, 60] },
  } as const;
  const integer = (min: number, max: number) => min + Math.floor(random(roll) * (max - min + 1));
  const profile = profiles[type];
  const soloHp = integer(profile.hp[0], profile.hp[1]);
  return {
    soloHp, partyHp: Math.round(soloHp * integer(250, 300) / 100),
    attack: integer(profile.attack[0], profile.attack[1]),
    // Required legacy fields remain valid; new events use wallet HP and percentage healing instead.
    healAmount: 1, playerHp: 1, playerHpSource: "wallet" as const, healingMode: "max_hp_10_percent" as const,
    counterEvery: 3, criticalPercent: 10, criticalMultiplier: 1.5, levelBonusPercent: 5,
  };
}
const clampDamage = (value: number) => Math.min(FORGE_MAX_INT, Math.max(1, Math.floor(value)));
export function splitBossReward(reward: number, userIds: string[]) {
  bossInteger(reward);
  if (!userIds.length || new Set(userIds).size !== userIds.length) throw new BossError("報酬の対象者が不正です。");
  // 端数はユーザーID昇順で1ずつ配り、総額を変えない。
  const sorted = [...userIds].sort();
  return sorted.map((userId, index) => ({ userId, amount: Math.floor(reward / sorted.length) + (index < reward % sorted.length ? 1 : 0) }));
}
export function bossPlayerAttack(
  player: BossFighter, config: BossConfig, roll: () => number = forgeRoll,
) {
  if (!isForgeWeaponType(player.weapon.weaponType)) throw new BossError("未対応の武器です。");
  const critical = random(roll) < config.criticalPercent / 100;
  const multiplier = 0.9 + random(roll) * 0.2;
  const type = player.weapon.weaponType;
  const trigger = (player.attackCount + 1) % 3 === 0;
  const skill = trigger ? FORGE_WEAPONS[type].skill : undefined;
  const skillMultiplier = trigger ? ({ greatsword: 1.6, sword: 1.4, dual: 1.6 } as Record<string, number>)[type] ?? 1 : 1;
  const raw = player.weapon.attack * (1 + (player.weapon.weaponLevel - 1) * config.levelBonusPercent / 100)
    * player.weapon.roleMultiplier * multiplier * (critical ? config.criticalMultiplier : 1)
    * (config.special === "damage_boost" ? 1.5 : 1) * skillMultiplier;
  return { damage: clampDamage(raw - (trigger && type === "bow" ? 0 : config.defense)), critical, skill,
    shield: trigger && type === "spear", supportHeal: trigger && type === "staff" };
}
export function bossHealing(player: BossFighter, config: BossConfig) {
  if (config.healingMode === "max_hp_10_percent") {
    return Math.max(0, Math.min(player.maxHp - player.hp, Math.max(1, Math.floor(player.maxHp / 10))));
  }
  const amount = config.healAmount * (config.special === "double_heal" ? 2 : 1)
    * (player.weapon.weaponType === "staff" ? 1.5 : 1);
  return Math.min(player.maxHp - player.hp, Math.floor(amount));
}
/** ボス別の行動順と閾値を定義。乱数はテスト時に差し替えられる。 */
export function bossCounter(
  type: BossType, hp: number, maxHp: number, turn: number, fighters: BossFighter[],
  config: BossConfig, roll: () => number = forgeRoll,
) {
  const players = fighters.map(p => ({ ...p, effects: { ...p.effects } }));
  const messages: string[] = [];
  let currentHp = hp;
  for (const p of players.filter(p => p.hp > 0)) {
    if (p.effects.bleedTicks > 0) {
      const amount = Math.min(p.hp, Math.max(1, Math.floor(p.maxHp * 0.05)));
      p.hp -= amount; p.effects.bleedTicks--;
      messages.push(`${p.displayName}に出血ダメージ ${amount}`);
    }
  }
  const living = players.filter(p => p.hp > 0);
  if (!living.length) return { hp: currentHp, fighters: players, messages };
  const phase = (turn - 1) % (type === "leviathan" ? 4 : 3);
  const enraged = hp / maxHp <= (type === "kraken" ? 0.3 : type === "megalodon" ? 0.5 : 0.2);
  const rage = enraged ? (type === "leviathan" ? 2 : 1.5) : 1;
  if (enraged) messages.push(type === "kraken" ? "クラーケンが暴走！" : type === "megalodon" ? "メガロドンが狂暴化！" : "リヴァイアサンが覚醒！");
  if (type === "leviathan" && phase === 2) {
    const healing = Math.min(maxHp - hp, Math.max(1, Math.floor(maxHp * 0.1)));
    currentHp += healing;
    messages.push(`海神の加護：ボスHPが${healing}回復`);
  } else {
    let targets: BossFighter[];
    let factor: number, label: string;
    if (type === "kraken") {
      label = phase === 0 ? "触手攻撃" : phase === 1 ? "海流攻撃" : "触手攻撃";
      factor = phase === 1 ? 0.8 : 1.2;
      targets = phase === 1 ? living : [living[Math.floor(random(roll) * living.length)]!];
    } else if (type === "megalodon") {
      label = ["噛み砕き", "狩猟本能", "出血攻撃"][phase]!;
      factor = phase === 0 ? 1.4 : phase === 1 ? 1.2 : 1;
      targets = phase === 1 ? [[...living].sort((a, b) => a.hp - b.hp)[0]!] : [living[Math.floor(random(roll) * living.length)]!];
    } else {
      label = phase === 0 ? "大津波" : phase === 1 ? "深海の咆哮" : "絶望の渦";
      factor = phase === 0 ? 1.2 : phase === 1 ? 0.8 : 1.5;
      targets = living;
    }
    for (const p of targets) {
      const raw = config.attack * factor * rage * (config.special === "double_attack" ? 2 : 1)
        * (0.9 + random(roll) * 0.2);
      const damage = Math.min(p.hp, clampDamage((raw - p.weapon.defense * 0.5)
        * (p.effects.shield ? 0.5 : 1) * (p.effects.vulnerableTicks > 0 ? 1.2 : 1)));
      p.hp -= damage; p.effects.shield = false;
      if (type === "megalodon" && phase === 2) p.effects.bleedTicks = 2;
      messages.push(`${label}：${p.displayName}に${damage}ダメージ${p.hp === 0 ? "（戦闘不能）" : ""}`);
    }
  }
  for (const p of players) {
    p.effects.vulnerableTicks = Math.max(0, p.effects.vulnerableTicks - 1);
    if (type === "leviathan" && phase === 1 && p.hp > 0) p.effects.vulnerableTicks = 2;
  }
  return { hp: currentHp, fighters: players, messages };
}
