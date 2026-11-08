import { describe, expect, it } from "vitest";
import {
  BOSS_ATTACK_OPENINGS, BOSS_REACTIONS, BOSS_COMBO_PROFILES, bossCombo, bossAttackPresentation,
  type BossType, type BossEffects, type ForgeWeaponType, type BossActionResult,
} from "@workspace/db";
import { bossActionText } from "../lib/bossUi";

const effects: BossEffects = { bleedTicks: 0, vulnerableTicks: 0, shield: false };
const types = Object.keys(BOSS_ATTACK_OPENINGS) as ForgeWeaponType[];
const bosses = Object.keys(BOSS_REACTIONS) as BossType[];
function narration(type: ForgeWeaponType = "greatsword", boss: BossType = "kraken",
  overrides: Partial<Parameters<typeof bossAttackPresentation>[3]> = {}, roll = () => 0.5) {
  return bossAttackPresentation(type, boss, bossCombo(type, 100, 10000, () => 0.99),
    { critical: false, finished: false, maxHp: 10000, effects, ...overrides }, roll);
}
describe("weapon attack presentation and actual combos", () => {
  it.each(types)("%s has at least 20 unique openings and never repeats the immediately previous opening", type => {
    expect(BOSS_ATTACK_OPENINGS[type].length).toBeGreaterThanOrEqual(20);
    expect(new Set(BOSS_ATTACK_OPENINGS[type]).size).toBe(BOSS_ATTACK_OPENINGS[type].length);
    let previous = effects;
    for (let i = 0; i < 40; i++) {
      const current = narration(type, "kraken", { effects: previous }, () => 0);
      expect(current.effects.lastAttackOpening).not.toBe(previous.lastAttackOpening);
      previous = current.effects;
    }
  });
  it.each(bosses)("%s has at least 10 unique, boss-specific reactions with variation within each tier", boss => {
    expect(new Set(BOSS_REACTIONS[boss]).size).toBeGreaterThanOrEqual(10);
    for (const [damage, critical, offset] of [[10, false, 0], [600, false, 3], [2000, false, 6], [10, true, 9]] as const) {
      const combo = bossCombo("greatsword", damage, 10000, () => 0.99);
      const input = { critical, finished: false, maxHp: 10000, effects };
      const first = bossAttackPresentation("greatsword", boss, combo, input, () => 0);
      expect(first.effects.lastAttackReaction).toBe(offset);
      const next = bossAttackPresentation("greatsword", boss, combo, { ...input, effects: first.effects }, () => 0);
      expect(next.effects.lastAttackReaction).not.toBe(first.effects.lastAttackReaction);
      expect(first.presentation.lines).toContain(BOSS_REACTIONS[boss][offset]);
    }
  });
  it.each(types)("%s combo respects weapon-specific hit limits and sums actual HP loss", type => {
    const combo = bossCombo(type, 100, 10000, () => 0);
    expect(combo.hits).toHaveLength(BOSS_COMBO_PROFILES[type].maxHits);
    expect(combo.hits.every(hit => Number.isInteger(hit) && hit > 0)).toBe(true);
    expect(combo.hits.slice(1).every(hit => hit < combo.hits[0]!)).toBe(true);
    expect(combo.damage).toBe(combo.hits.reduce((a, b) => a + b, 0));
  });
  it("dual blades have the highest combo chance and maximum hit count", () => {
    expect(bossCombo("dual", 100, 10000, () => 0.5).hits).toHaveLength(5);
    for (const type of types.filter(t => t !== "dual")) {
      expect(BOSS_COMBO_PROFILES.dual.chance).toBeGreaterThan(BOSS_COMBO_PROFILES[type].chance);
      expect(bossCombo(type, 100, 10000, () => 0.5).hits).toEqual([100]);
    }
  });
  it("can stop a combo early, and does not roll or hit again after defeating the boss", () => {
    const rolls = [0, 0, 0.99]; // Trigger, follow-up strength, continuation stop.
    expect(bossCombo("dual", 100, 10000, () => rolls.shift()!).hits).toEqual([100, 36]);
    const noRoll = () => { throw new Error("no extra rolls after defeat"); };
    expect(bossCombo("dual", 100, 1, noRoll).hits).toEqual([1]);
    expect(bossCombo("dual", 100, 105, () => 0).hits).toEqual([100, 5]);
  });
  it("keeps minimum positive damage and large integer totals within remaining HP", () => {
    expect(bossCombo("dual", 1, 100, () => 0).hits).toEqual([1, 1, 1, 1, 1]);
    const max = 2_147_483_647;
    expect(bossCombo("dual", max, max, () => 0).damage).toBe(max);
  });
  it("has distinct critical, combo, overkill and boss-specific finish output without counting excess damage", () => {
    const combo = bossCombo("dual", 100, 110, () => 0);
    expect(combo.damage).toBe(110);
    const result = bossAttackPresentation("dual", "megalodon", combo,
      { critical: true, finished: true, maxHp: 110, effects }, () => 0);
    const text = result.presentation.lines.join("\n");
    expect(text).toContain("クリティカル");
    expect(text).toContain("追撃");
    expect(text).toContain("合計 110ダメージ");
    expect(text).toContain("メガロドンを討伐");
    // A separate large blow demonstrates the actual/attempted distinction.
    const overkill = bossAttackPresentation("staff", "leviathan", bossCombo("staff", 1000, 100),
      { critical: false, finished: true, maxHp: 100, effects }, () => 0);
    expect(overkill.presentation.overkill).toBe(true);
    expect(overkill.presentation.lines.join("\n")).toContain("100ダメージ");
    expect(overkill.presentation.lines.join("\n")).toContain("威力 1,000");
    expect(overkill.presentation.lines.join("\n")).toContain("オーバーキル");
    expect(overkill.presentation.lines.join("\n")).toContain("リヴァイアサンを討伐");
  });
  it("does not mark a nonlethal strike or slight HP excess as overkill", () => {
    expect(bossCombo("bow", 101, 100).overkill).toBe(false);
    expect(narration().presentation.finish).toBe(false);
    expect(narration().presentation.lines.join("\n")).not.toMatch(/最後の一撃|討伐成功|オーバーキル/);
  });
  it.each([NaN, -0.1, 1, Infinity])("rejects invalid RNG %s", value => {
    expect(() => bossCombo("dual", 10, 100, () => value)).toThrow("乱数");
    expect(() => narration("dual", "kraken", {}, () => value)).toThrow("乱数");
  });
  it("formats saved narration without rerolling, supports legacy receipts and keeps healing unchanged", () => {
    const result: BossActionResult = { battleId: "battle", mode: "solo", state: "active",
      damage: 100, bossHp: 9900, critical: false, paid: 0, balance: 100, messages: [],
      presentation: narration().presentation };
    const text = bossActionText(result);
    expect(bossActionText(JSON.parse(JSON.stringify(result)))).toBe(text);
    expect(text).toContain("クラーケンに **100ダメージ");
    expect(text).not.toMatch(/内部攻撃力|内部防御力|ロール倍率/);
    expect(text.length).toBeLessThan(2000);
    expect(bossActionText({ ...result, presentation: undefined })).toContain("100ダメージ");
    expect(bossActionText({ ...result, damage: undefined, presentation: undefined, healed: 10 })).toContain("HPが10回復");
    expect(bossActionText({ ...result, repeated: true })).toContain("再抽選はしていません");
  });
});
