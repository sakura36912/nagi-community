import { describe, expect, it } from "vitest";
import {
  PET_SPECIES, PET_RARITIES, addPetXp, newPetAccount, petDay, petSetting, refreshPet, validatePetSetting,
  type PetIndividual,
} from "@workspace/db";

const individual = (): PetIndividual => ({
  id: "pet", name: "キツネ", species: "キツネ", rarity: "rare", level: 1, xp: 0,
  hunger: 100, bond: 0, bornAt: 0, hungerAt: 0,
});
describe("pet growth rules", () => {
  it("contains exactly the 40 requested species, no invented normal pets", () => {
    expect(PET_SPECIES.normal).toEqual([]);
    expect(PET_RARITIES.flatMap(r => PET_SPECIES[r])).toHaveLength(40);
    expect(new Set(PET_RARITIES.flatMap(r => PET_SPECIES[r])).size).toBe(40);
  });
  it("keeps each requested rarity separate", () => {
    expect(PET_SPECIES.rare).toContain("シャチ");
    expect(PET_SPECIES.epic).toContain("クラーケン幼体");
    expect(PET_SPECIES.legend).toContain("リヴァイアサン");
    expect(PET_SPECIES.mythic).toContain("古代クラーケン");
  });
  it("uses JST midnight", () => {
    expect(petDay(Date.parse("2026-11-12T14:59:59Z"))).toBe("2026-11-12");
    expect(petDay(Date.parse("2026-11-12T15:00:00Z"))).toBe("2026-11-13");
  });
  it("does not invent missing prices or growth values", () => {
    expect(() => petSetting({}, "rare_price")).toThrow("未設定");
    expect(() => petSetting({}, "feed_xp")).toThrow("未設定");
  });
  it.each(["xp_base", "message_interval", "vc_interval", "hunger_interval"] as const)("rejects zero %s", key => {
    expect(() => validatePetSetting(key, 0)).toThrow();
  });
  it("validates level cap and multiplier separately", () => {
    expect(() => validatePetSetting("level_cap", 101)).toThrow();
    expect(() => validatePetSetting("level_cap", 2.5)).toThrow();
    expect(validatePetSetting("xp_multiplier", 1.5)).toBe(1.5);
    expect(() => validatePetSetting("xp_multiplier", Infinity)).toThrow();
  });
  it("supports multiple level-ups with remaining XP", () => {
    const p = individual();
    addPetXp(p, { xp_base: 10, xp_multiplier: 2 }, 16);
    expect([p.level, p.xp]).toEqual([3, 2]);
  });
  it("caps at 100 without extra XP or demoting pets when cap lowered", () => {
    const p = individual();
    addPetXp(p, { xp_base: 1, xp_multiplier: 1 }, 10000);
    expect([p.level, p.xp]).toEqual([100, 0]);
    addPetXp(p, { xp_base: 1, xp_multiplier: 1, level_cap: 20 }, 10);
    expect(p.level).toBe(100);
  });
  it("reduces hunger by whole intervals and preserves partial intervals", () => {
    const a = newPetAccount(); a.pet = individual();
    refreshPet(a, { hunger_interval: 60, hunger_loss: 4 }, 150000);
    expect(a.pet.hunger).toBe(92);
    expect(a.pet.hungerAt).toBe(120000);
    refreshPet(a, { hunger_interval: 60, hunger_loss: 4 }, 180000);
    expect(a.pet.hunger).toBe(88);
  });
  it("never falls below zero, and resets daily counts", () => {
    const a = newPetAccount(); a.pet = individual(); a.petsToday = 1; a.playsToday = 3;
    refreshPet(a, { hunger_interval: 1, hunger_loss: 10 }, 1000000);
    expect(a.pet.hunger).toBe(0);
    expect([a.petsToday, a.playsToday]).toEqual([0, 0]);
  });
  it("does not decay an unconfigured period retroactively", () => {
    const a = newPetAccount(); a.pet = individual();
    refreshPet(a, {}, 1000000);
    refreshPet(a, { hunger_interval: 60, hunger_loss: 1 }, 1060000);
    expect(a.pet.hunger).toBe(99);
  });
});
