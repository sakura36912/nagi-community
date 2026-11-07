import { Collection, PermissionFlagsBits, type Client } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../commands/give", () => ({
  giveCommand: { data: { toJSON: () => ({ name: "give" }) } },
}));
vi.mock("../lib/guildCommandScope", () => ({ prefersGlobalCommands: (id: string) => id === "global-guild" }));
vi.mock("../lib/logger", () => ({ logger: { info: vi.fn() } }));
import { syncGiveCommandRegistration } from "../lib/giveCommandRegistration";

function manager(existing = false) {
  const valid = {
    id: "give-id", name: "give", type: 1,
    defaultMemberPermissions: { bitfield: PermissionFlagsBits.Administrator },
    options: [{ name: "user", required: true }, { name: "amount", required: true, min_value: 1, max_value: 2_147_483_647 }],
  };
  const definitions = new Collection<string, typeof valid>();
  if (existing) definitions.set(valid.id, valid);
  return {
    valid, definitions,
    fetch: vi.fn(async (id: unknown) => typeof id === "string" ? valid : definitions.clone()),
    create: vi.fn(async () => { definitions.set(valid.id, valid); return valid; }),
    edit: vi.fn(async () => valid),
    delete: vi.fn(async (id: string) => definitions.delete(id)),
  };
}
beforeEach(() => vi.clearAllMocks());
describe("/give startup registration", () => {
  it("creates globally and force-verifies; never replaces all commands", async () => {
    const global = manager();
    const client = { application: { commands: global }, guilds: { cache: new Collection() } };
    await syncGiveCommandRegistration(client as unknown as Client);
    expect(global.create).toHaveBeenCalledWith({ name: "give" });
    expect(global.fetch).toHaveBeenCalledWith("give-id", { force: true });
    const startup = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    expect(startup).toContain("syncGiveCommandRegistration(readyClient)");
  });
  it("updates the old guild definition but removes only duplicates in global-preferring guilds", async () => {
    const global = manager(true), guild = manager(true), duplicate = manager(true);
    const client = { application: { commands: global }, guilds: { cache: new Collection([
      ["guild", { id: "guild", commands: guild }],
      ["global-guild", { id: "global-guild", commands: duplicate }],
    ]) } };
    await syncGiveCommandRegistration(client as unknown as Client);
    expect(global.edit).toHaveBeenCalledWith("give-id", { name: "give" });
    expect(guild.edit).toHaveBeenCalledWith("give-id", { name: "give" });
    expect(duplicate.delete).toHaveBeenCalledExactlyOnceWith("give-id");
    expect(duplicate.create).not.toHaveBeenCalled();
  });
  it("rejects bad permission verification instead of reporting success", async () => {
    const global = manager();
    global.valid.defaultMemberPermissions.bitfield = 0n;
    const client = { application: { commands: global }, guilds: { cache: new Collection() } };
    await expect(syncGiveCommandRegistration(client as unknown as Client)).rejects.toThrow("verification");
  });
});
