import { describe, expect, it, vi } from "vitest";
import { Collection, Routes } from "discord.js";
import { RPG_COMMAND_NAMES, LEGACY_RPG_COMMAND_NAMES } from "@workspace/db";
import { handleRetiredBankRpgInteraction, removeBankRpgCommands } from "../lib/rpgCommandMigration";

function manager() {
  const definitions = [
    ...[...RPG_COMMAND_NAMES, ...LEGACY_RPG_COMMAND_NAMES].map((name, i) => ({ id: String(i), name, type: 1 })),
    { id: "shop", name: "shop", type: 1 },
    { id: "casino", name: "casino", type: 1 },
    { id: "zombie", name: "zombie", type: 1 },
    { id: "context", name: "武器", type: 2 },
  ];
  return { fetch: vi.fn(async () => new Collection(definitions.map(c => [c.id, c]))), delete: vi.fn(async () => undefined) };
}
function setup() {
  const global = manager(), guild = manager();
  const bank = { application: { id: "bank", commands: global },
    guilds: { cache: new Collection([["guild", { id: "guild", commands: guild }]]) } };
  const api = { get: vi.fn(async (path: string): Promise<unknown> => {
    if (path === Routes.oauth2CurrentApplication()) return { id: "community" };
    if (path === Routes.applicationCommands("community")) return RPG_COMMAND_NAMES.map(name => ({ name, type: 1 }));
    if (path === Routes.guild("guild")) return { id: "guild" };
    throw new Error("Unexpected route");
  }) };
  return { bank, global, guild, api };
}
describe("bank to community RPG command migration", () => {
  it("deletes only retired chat commands from global and guild scopes", async () => {
    const s = setup();
    expect(await removeBankRpgCommands(s.bank as never, s.api, "community")).toBe(62);
    for (const m of [s.global, s.guild]) {
      expect(m.delete).toHaveBeenCalledTimes(31);
      for (const id of ["shop", "casino", "zombie", "context"]) expect(m.delete).not.toHaveBeenCalledWith(id);
    }
  });
  it("does not delete anything until all 19 destination commands exist", async () => {
    const s = setup();
    s.api.get.mockImplementation(async path => path === Routes.oauth2CurrentApplication() ? { id: "community" } : []);
    await expect(removeBankRpgCommands(s.bank as never, s.api)).rejects.toThrow("not ready");
    expect(s.global.delete).not.toHaveBeenCalled();
    expect(s.guild.delete).not.toHaveBeenCalled();
  });
  it.each(["bank", "wrong-account"])("rejects wrong destination identity %s", async id => {
    const s = setup();
    s.api.get.mockResolvedValue({ id });
    await expect(removeBankRpgCommands(s.bank as never, s.api, "community")).rejects.toThrow("identity");
    expect(s.global.fetch).not.toHaveBeenCalled();
  });
  it("removes retired definitions even if the destination has not joined another bank guild", async () => {
    const s = setup(), real = s.api.get.getMockImplementation()!;
    s.api.get.mockImplementation(async path => {
      if (path === Routes.guild("guild")) throw new Error("Missing access");
      return real(path);
    });
    expect(await removeBankRpgCommands(s.bank as never, s.api)).toBe(62);
    expect(s.api.get).not.toHaveBeenCalledWith(Routes.guild("guild"));
  });
  it("fails closed on Discord API errors without touching source definitions", async () => {
    const s = setup();
    s.api.get.mockRejectedValue(new Error("Offline"));
    await expect(removeBankRpgCommands(s.bank as never, s.api)).rejects.toThrow();
    expect(s.global.fetch).not.toHaveBeenCalled();
  });
  it.each(["forge:confirm:old", "boss:attack:old"])("redirects stale bank button %s without performing its action", async customId => {
    const i = { customId, isButton: () => true, isChatInputCommand: () => false, reply: vi.fn(async () => undefined) };
    expect(await handleRetiredBankRpgInteraction(i as never)).toBe(true);
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true, content: expect.stringContaining("課金しません") }));
  });
  it("redirects cached legacy commands but leaves shop and casino alone", async () => {
    for (const name of [...RPG_COMMAND_NAMES, ...LEGACY_RPG_COMMAND_NAMES, "shop", "casino"]) {
      const i = { commandName: name, isButton: () => false, isChatInputCommand: () => true, reply: vi.fn(async () => undefined) };
      expect(await handleRetiredBankRpgInteraction(i as never)).toBe(!["shop", "casino"].includes(name));
    }
  });
});
