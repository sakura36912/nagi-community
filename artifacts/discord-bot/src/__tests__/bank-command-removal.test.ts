import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REMOVED_BANK_COMMAND_NAMES } from "../lib/rpgCommandMigration";

describe("Bank Bot command list", () => {
  it("omits guide, leavelog, roulette, boss, and weapon commands", () => {
    const source = readFileSync(new URL("../commands/index.ts", import.meta.url), "utf8");
    const list = source.split("export const commands: Command[] = [")[1]!.split("];")[0]!;

    for (const name of ["guide", "leavelog", "roulette"]) expect(list).not.toContain(`${name}Command`);
    expect(REMOVED_BANK_COMMAND_NAMES).toContain("boss_attack");
    expect(REMOVED_BANK_COMMAND_NAMES).toContain("weapon_select");
    expect(REMOVED_BANK_COMMAND_NAMES).toContain("upgrade");
  });

  it("keeps transfer, balance, casino, and PvP commands", () => {
    const source = readFileSync(new URL("../commands/index.ts", import.meta.url), "utf8");
    const list = source.split("export const commands: Command[] = [")[1]!.split("];")[0]!;

    for (const name of ["pay", "balance", "casino", "give", "bounty"]) {
      expect(list).toContain(`${name}Command`);
    }
    expect(REMOVED_BANK_COMMAND_NAMES).not.toContain("pvp");
  });
});
