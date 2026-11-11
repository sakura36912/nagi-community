import { describe, expect, it } from "vitest";
import { pvpCombat, PvpError, type BossFighter, FORGE_WEAPONS, type ForgeWeaponType } from "@workspace/db";
const types = Object.keys(FORGE_WEAPONS) as ForgeWeaponType[];
function players(type: ForgeWeaponType = "sword"): BossFighter[] {
  return [
    { userId: "a", displayName: "a", hp: 500, maxHp: 1000, damage: 0, attackCount: 0,
      weapon: { weaponType: type, weaponLevel: 1, attack: 100, defense: 5, roleMultiplier: 1 },
      effects: { bleedTicks: 0, vulnerableTicks: 0, shield: false } },
    { userId: "b", displayName: "b", hp: 1000, maxHp: 1000, damage: 0, attackCount: 0,
      weapon: { weaponType: "sword", weaponLevel: 1, attack: 100, defense: 5, roleMultiplier: 1 },
      effects: { bleedTicks: 0, vulnerableTicks: 0, shield: false } },
  ];
}
describe("PvP boss-style combat", () => {
  it.each(types)("supports %s with real damage, non-repeating openings and no boss names", type => {
    const first = pvpCombat(players(type), "a", "attack", new Date(0), () => 0.99);
    const next = pvpCombat(first.players, "a", "attack", new Date(5000), () => 0.99);
    expect(first.players[1]!.hp).toBeLessThan(1000);
    expect(first.lines[0]).not.toBe(next.lines[0]);
    expect(first.lines.join("\n")).not.toMatch(/クラーケン|メガロドン|リヴァイアサン|討伐/);
    expect(players(type)[1]!.hp).toBe(1000);
  });
  it("critical and dual combos apply actual damage and finish once", () => {
    const p = players("dual"); p[1]!.hp = 150;
    const result = pvpCombat(p, "a", "attack", new Date(), () => 0);
    expect(result.winnerId).toBe("a");
    expect(result.players[0]!.damage).toBe(150);
    expect(result.lines.join("\n")).toMatch(/クリティカル/);
    expect(result.players[1]!.hp).toBe(0);
  });
  it("spear shield halves the next attack, then expires", () => {
    const p = players("spear"); p[0]!.attackCount = 2;
    const spear = pvpCombat(p, "a", "attack", new Date(0), () => 0.99);
    expect(spear.players[0]!.effects.shield).toBe(true);
    const counter = pvpCombat(spear.players, "b", "attack", new Date(1), () => 0.99);
    const without = structuredClone(spear.players); without[0]!.effects.shield = false;
    const normal = pvpCombat(without, "b", "attack", new Date(1), () => 0.99);
    expect(counter.players[0]!.hp).toBeGreaterThan(normal.players[0]!.hp);
    expect(counter.players[0]!.effects.shield).toBe(false);
  });
  it("staff heals itself by 20% on the third attack, not its opponent", () => {
    const p = players("staff"); p[0]!.attackCount = 2;
    const result = pvpCombat(p, "a", "attack", new Date(), () => 0.99);
    expect(result.players[0]!.hp).toBe(700);
    expect(result.players[1]!.hp).toBeLessThan(1000);
  });
  it("paid healing is 10%, capped, with no resurrection or negative HP", () => {
    const p = players("staff"); p[0]!.hp = 999;
    const result = pvpCombat(p, "a", "heal", new Date(0));
    expect(result.players[0]!.hp).toBe(1000);
    expect(result.paidHeal).toBe(true);
    p[0]!.hp = 0;
    expect(() => pvpCombat(p, "a", "heal", new Date())).toThrow(PvpError);
  });
  it("cooldowns are action-specific and reject invalid randomness", () => {
    const p = players();
    p[0]!.effects.attackReadyAt = 5000;
    expect(() => pvpCombat(p, "a", "attack", new Date(0))).toThrow("待って");
    expect(pvpCombat(p, "a", "heal", new Date(0)).players[0]!.hp).toBe(600);
    p[0]!.effects.attackReadyAt = 0;
    expect(() => pvpCombat(p, "a", "attack", new Date(), () => 1)).toThrow("乱数");
  });
});
