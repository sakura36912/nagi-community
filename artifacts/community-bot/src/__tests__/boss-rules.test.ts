import { describe, expect, it } from "vitest";
import { bossCounter, bossHealing, bossPlayerAttack, bossCooldownSeconds, splitBossReward, validateBossConfig, generateBossCombatStats,
  type BossConfig, type BossFighter } from "../../../../lib/db/src/bossRules";

const config: BossConfig = {
  soloHp: 1000, partyHp: 4000, attack: 100, defense: 0, reward: 101,
  durationSeconds: 600, lobbySeconds: 30, playerHp: 1000, healAmount: 100,
  counterEvery: 2, cooldownSeconds: 1, criticalPercent: 0, criticalMultiplier: 2,
  levelBonusPercent: 5, special: "none", bonusRoleId: null, roleMultiplier: 1,
};
function fighter(userId = "user", weaponType = "greatsword"): BossFighter {
  return { userId, displayName: userId, hp: 1000, maxHp: 1000, damage: 0, attackCount: 0,
    weapon: { weaponType, weaponLevel: 1, attack: 100, defense: 0, roleMultiplier: 1 },
    effects: { bleedTicks: 0, vulnerableTicks: 0, shield: false } };
}
describe("boss combat rules", () => {
  it.each([
    ["kraken", 300, 450, 25, 35], ["megalodon", 450, 650, 35, 45], ["leviathan", 650, 900, 45, 60],
  ] as const)("generates inclusive, valid %s combat settings", (type, minHp, maxHp, minAttack, maxAttack) => {
    const low = generateBossCombatStats(type, () => 0);
    const high = generateBossCombatStats(type, () => 0.999999);
    expect(low).toMatchObject({ soloHp: minHp, partyHp: Math.round(minHp * 2.5), attack: minAttack, healAmount: 100 });
    expect(high).toMatchObject({ soloHp: maxHp, partyHp: maxHp * 3, attack: maxAttack, healAmount: 150 });
    for (const generated of [low, high]) expect(() => validateBossConfig(type, { ...config, ...generated })).not.toThrow();
  });
  it.each([NaN, Infinity, -0.1, 1])("rejects an invalid generation roll: %s", roll => {
    expect(() => generateBossCombatStats("kraken", () => roll)).toThrow("乱数");
  });
  it("uses separate cooldown defaults and validates configurable bounds", () => {
    expect(bossCooldownSeconds(config, "attack")).toBe(5);
    expect(bossCooldownSeconds(config, "heal")).toBe(30);
    expect(bossCooldownSeconds({ ...config, attackCooldownSeconds: 0 }, "attack")).toBe(0);
    expect(() => validateBossConfig("kraken", { ...config, attackCooldownSeconds: 10, healCooldownSeconds: 60 })).not.toThrow();
    for (const patch of [{ attackCooldownSeconds: -1 }, { attackCooldownSeconds: 3601 },
      { healCooldownSeconds: 0 }, { healCooldownSeconds: NaN }, { healCooldownSeconds: 1.5 }]) {
      expect(() => validateBossConfig("kraken", { ...config, ...patch })).toThrow();
    }
  });
  it("splits every dollar including remainder, independent of join order", () => {
    const result = splitBossReward(101, ["b", "a", "c"]);
    expect(result).toEqual([{ userId: "a", amount: 34 }, { userId: "b", amount: 34 }, { userId: "c", amount: 33 }]);
    expect(result.reduce((sum, r) => sum + r.amount, 0)).toBe(101);
    expect(splitBossReward(1, ["b", "a"])).toEqual([{ userId: "a", amount: 1 }, { userId: "b", amount: 0 }]);
    expect(() => splitBossReward(1, ["a", "a"])).toThrow();
  });
  it("validates administrative values and doubled reward overflow", () => {
    expect(() => validateBossConfig("kraken", config)).not.toThrow();
    for (const patch of [{ lobbySeconds: 601 }, { playerHp: 0 }, { criticalPercent: 101 }, { cooldownSeconds: 0 },
      { criticalMultiplier: NaN }, { special: "double_reward", reward: 2147483647 }]) {
      expect(() => validateBossConfig("kraken", { ...config, ...patch } as BossConfig)).toThrow();
    }
  });
  it("uses weapon attack, level, role, random and critical multipliers", () => {
    const player = fighter();
    player.weapon.weaponLevel = 3; player.weapon.roleMultiplier = 2;
    expect(bossPlayerAttack(player, { ...config, criticalPercent: 100 }, () => 0.5).damage).toBe(440);
  });
  it("gives every weapon its named skill on every third attack", () => {
    for (const type of ["greatsword", "sword", "spear", "bow", "dual", "staff"]) {
      const player = fighter("user", type);
      expect(bossPlayerAttack(player, config, () => 0.5).skill).toBeUndefined();
      player.attackCount = 2;
      expect(bossPlayerAttack(player, config, () => 0.5).skill).toBeTruthy();
    }
    const spear = fighter("spear", "spear"); spear.attackCount = 2;
    expect(bossPlayerAttack(spear, config, () => 0.5).shield).toBe(true);
    const staff = fighter("staff", "staff"); staff.attackCount = 2;
    expect(bossPlayerAttack(staff, config, () => 0.5).supportHeal).toBe(true);
  });
  it("bow skill ignores defense and damage event multiplies attacks", () => {
    const bow = fighter("bow", "bow");
    const strong = { ...config, defense: 1000 };
    expect(bossPlayerAttack(bow, strong, () => 0.5).damage).toBe(1);
    bow.attackCount = 2;
    expect(bossPlayerAttack(bow, strong, () => 0.5).damage).toBe(100);
    expect(bossPlayerAttack(fighter(), { ...config, special: "damage_boost" }, () => 0.5).damage).toBe(150);
  });
  it("caps healing at max HP and supports staff and healing event", () => {
    const player = fighter("staff", "staff"); player.hp = 500;
    expect(bossHealing(player, config)).toBe(150);
    expect(bossHealing(player, { ...config, special: "double_heal" })).toBe(300);
    player.hp = 999;
    expect(bossHealing(player, config)).toBe(1);
  });
  it("kraken alternates single target and all-target attacks; enrages at 30 percent", () => {
    const players = [fighter("a"), fighter("b")];
    const normal = bossCounter("kraken", 1000, 1000, 1, players, config, () => 0.5);
    expect(normal.fighters.filter(p => p.hp < 1000)).toHaveLength(1);
    expect(normal.messages.join()).toContain("触手攻撃");
    const all = bossCounter("kraken", 300, 1000, 2, players, config, () => 0.5);
    expect(all.fighters.every(p => p.hp === 880)).toBe(true);
    expect(all.messages.join()).toMatch(/暴走.*海流攻撃/);
  });
  it("megalodon selects lowest HP and applies two ticks of bleeding", () => {
    const players = [fighter("a"), fighter("b")]; players[0]!.hp = 800;
    const hunt = bossCounter("megalodon", 1000, 1000, 2, players, config, () => 0.5);
    expect(hunt.fighters[0]!.hp).toBe(680);
    expect(hunt.fighters[1]!.hp).toBe(1000);
    const bleed = bossCounter("megalodon", 500, 1000, 3, players, config, () => 0);
    expect(bleed.fighters[0]!.effects.bleedTicks).toBe(2);
    const tick = bossCounter("megalodon", 1000, 1000, 4, bleed.fighters, config, () => 0.5);
    expect(tick.messages.join()).toContain("出血ダメージ");
    expect(tick.fighters[0]!.effects.bleedTicks).toBe(1);
  });
  it("leviathan has tsunami, roar, blessing, vortex and awakening", () => {
    const players = [fighter("a"), fighter("b")];
    const tsunami = bossCounter("leviathan", 1000, 1000, 1, players, config, () => 0.5);
    expect(tsunami.messages.join()).toContain("大津波");
    const roar = bossCounter("leviathan", 1000, 1000, 2, players, config, () => 0.5);
    expect(roar.fighters.every(p => p.effects.vulnerableTicks === 2)).toBe(true);
    const blessing = bossCounter("leviathan", 900, 1000, 3, players, config, () => 0.5);
    expect(blessing.hp).toBe(1000);
    expect(blessing.messages.join()).toContain("海神の加護");
    const vortex = bossCounter("leviathan", 200, 1000, 4, players, config, () => 0.5);
    expect(vortex.messages.join()).toMatch(/覚醒.*絶望の渦/);
  });
  it("applies double boss attack, defense, one-use shield and never hits defeated players", () => {
    const player = fighter(); player.weapon.defense = 40; player.effects.shield = true;
    const dead = fighter("dead"); dead.hp = 0;
    const result = bossCounter("kraken", 1000, 1000, 1, [player, dead], { ...config, special: "double_attack" }, () => 0.5);
    expect(result.fighters[0]!.hp).toBe(890);
    expect(result.fighters[0]!.effects.shield).toBe(false);
    expect(result.fighters[1]!.hp).toBe(0);
  });
  it("does not mutate caller-owned status effects", () => {
    const player = fighter(); player.effects.bleedTicks = 2;
    bossCounter("kraken", 1000, 1000, 1, [player], config, () => 0.5);
    expect(player.hp).toBe(1000);
    expect(player.effects.bleedTicks).toBe(2);
  });
});
