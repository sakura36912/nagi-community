import { describe, expect, it } from "vitest";
import { RPG_COMMAND_NAMES } from "@workspace/db";
import { forgeCommands } from "../commands/forge";
import { bossCommands } from "../commands/boss";
import { commands } from "../commands/index";
const commandsByName = new Map(commands.map(c => [c.data.name, c]));
describe("community RPG command ownership", () => {
  it("owns all 11 weapon and 8 boss commands without renaming or omissions", () => {
    expect(forgeCommands).toHaveLength(11);
    expect(bossCommands).toHaveLength(8);
    const moved = [...forgeCommands, ...bossCommands];
    expect(moved.map(c => c.data.name).sort()).toEqual([...RPG_COMMAND_NAMES].sort());
    for (const c of moved) expect(commandsByName.get(c.data.name)?.execute).toBe(c.execute);
  });
  it("has unique, serializable definitions below Discord's global chat command limit", () => {
    expect(commandsByName.size).toBeLessThanOrEqual(100);
    expect(commandsByName.size).toBe(commands.length);
    for (const c of [...forgeCommands, ...bossCommands]) expect(c.data.toJSON().dm_permission).toBe(false);
  });
});
