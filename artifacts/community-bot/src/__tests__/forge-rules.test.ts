import { describe, expect, it } from "vitest";
import {
  FORGE_WEAPONS, calculateForgeDamage, defaultForgeCost, defaultForgeRate,
  forgeStats, isForgeWeaponType, publicForgeWeapon, resolveForgeSetting,
} from "../../../../lib/db/src/forgeRules";

describe("forge rules", () => {
  it("offers exactly six permanent weapon choices with skills", () => {
    expect(Object.keys(FORGE_WEAPONS)).toHaveLength(6);
    for (const [type, profile] of Object.entries(FORGE_WEAPONS)) {
      expect(isForgeWeaponType(type)).toBe(true);
      expect(profile.skill.length).toBeGreaterThan(0);
    }
    expect(isForgeWeaponType("__proto__")).toBe(false);
  });
  it("increases internal attack and defense for every weapon", () => {
    for (const type of Object.keys(FORGE_WEAPONS) as (keyof typeof FORGE_WEAPONS)[]) {
      expect(forgeStats(type, 2).attack).toBeGreaterThan(forgeStats(type, 1).attack);
      expect(forgeStats(type, 2).defense).toBeGreaterThan(forgeStats(type, 1).defense);
    }
  });
  it("uses the initial examples and never invents fees for higher levels", () => {
    expect([1, 2, 3, 4].map(defaultForgeCost)).toEqual([1000, 3000, 5000, null]);
    expect(resolveForgeSetting(4, { cost: 0, successRate: 30 })).toEqual({ level: 4, cost: 0, successRate: 30 });
    expect(resolveForgeSetting(4, { cost: null, successRate: null }).cost).toBeNull();
  });
  it("decreases rates by five points with a floor of thirty", () => {
    expect([1, 2, 3, 4, 5, 15, 100].map(defaultForgeRate)).toEqual([100, 95, 90, 85, 80, 30, 30]);
  });
  it("whitelists public weapon fields; internal stats cannot leak", () => {
    const weapon = { weaponType: "bow", weaponLevel: 7, attack: 999, defense: 888, version: 20 };
    const view = publicForgeWeapon(weapon, { cost: 5000, successRate: 70 });
    expect(view).toEqual({ name: "弓", level: 7, skill: "貫通矢", nextCost: 5000, successRate: 70 });
    expect(JSON.stringify(view)).not.toMatch(/attack|defense|version/);
  });
  it("uses internal attack, role, random variance and critical multiplier", () => {
    const weapon = { weaponType: "greatsword", weaponLevel: 2, attack: forgeStats("greatsword", 2).attack };
    expect(calculateForgeDamage(weapon, { roleMultiplier: 2, criticalChance: 1 }, () => 0.5))
      .toEqual({ damage: 60, critical: true, skill: "渾身斬り" });
    expect(calculateForgeDamage(weapon, { criticalChance: 0 }, () => 0))
      .toEqual({ damage: 18, critical: false, skill: "渾身斬り" });
  });
  it("rejects invalid levels, overflow, weapon types and combat modifiers", () => {
    expect(() => forgeStats("bow", 0)).toThrow();
    expect(() => forgeStats("bow", 2147483647)).toThrow();
    expect(() => publicForgeWeapon({ weaponType: "unknown", weaponLevel: 1 }, { cost: 1, successRate: 100 })).toThrow();
    expect(() => calculateForgeDamage({ weaponType: "bow", weaponLevel: 1, attack: 14 }, { roleMultiplier: NaN })).toThrow();
    expect(() => calculateForgeDamage({ weaponType: "bow", weaponLevel: 1, attack: 14 }, {}, () => 1)).toThrow();
  });
});
