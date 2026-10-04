import { describe, expect, it, vi } from "vitest";
import { ApplicationCommandType, Collection, Routes, type Client, type REST } from "discord.js";
import {
  deleteDuplicateGuildCommands, GLOBAL_PREFERRED_GUILD_ID, prefersGlobalCommands,
} from "../lib/guildCommandScope";
import { syncCasinoCommandRegistration } from "../lib/casinoCommandRegistration";
import { syncChinchiroCommandRegistration } from "../lib/chinchiroCommandRegistration";
import {
  syncDailyRoleDebitCommandRegistration, syncMonthlyRoleDebitCommandRegistration,
} from "../lib/dailyRoleDebitRegistration";
import { syncUraCommandRegistration } from "../commands/uraRecruitment";

const command = (id: string, name: string, type = ApplicationCommandType.ChatInput) => ({ id, name, type });
function restFixture() {
  const globals = [command("global-casino", "casino"), command("global-ura", "裏航海")];
  const guild = [
    command("guild-casino", "casino"), command("guild-ura", "裏航海"),
    command("guild-bounty", "bounty"), command("guild-returnlog", "returnlog"),
    command("guild-user-menu", "casino", ApplicationCommandType.User),
  ];
  const get = vi.fn(async (route: string) =>
    route === Routes.applicationCommands("app") ? globals : [...guild]);
  const remove = vi.fn(async (route: string) => {
    const id = route.split("/").at(-1);
    const index = guild.findIndex((entry) => entry.id === id);
    if (index >= 0) guild.splice(index, 1);
  });
  const rest = { get, delete: remove } as unknown as Pick<REST, "get" | "delete">;
  return { rest, globals, guild, get, remove };
}

describe("guild command duplicate cleanup", () => {
  it("only changes registration policy for the requested guild", () => {
    expect(prefersGlobalCommands(GLOBAL_PREFERRED_GUILD_ID)).toBe(true);
    expect(prefersGlobalCommands("other-guild")).toBe(false);
  });

  it("deletes exact name/type duplicates individually and preserves guild-only commands and globals", async () => {
    const { rest, guild, globals, get, remove } = restFixture();
    expect(await deleteDuplicateGuildCommands(rest, "app", GLOBAL_PREFERRED_GUILD_ID))
      .toEqual(["casino", "裏航海"]);
    expect(remove.mock.calls.map(([route]) => route)).toEqual([
      Routes.applicationGuildCommand("app", GLOBAL_PREFERRED_GUILD_ID, "guild-casino"),
      Routes.applicationGuildCommand("app", GLOBAL_PREFERRED_GUILD_ID, "guild-ura"),
    ]);
    expect(guild.map((entry) => entry.id)).toEqual(["guild-bounty", "guild-returnlog", "guild-user-menu"]);
    expect(globals.map((entry) => entry.id)).toEqual(["global-casino", "global-ura"]);
    expect(get.mock.calls.filter(([route]) => route === Routes.applicationGuildCommands("app", GLOBAL_PREFERRED_GUILD_ID)))
      .toHaveLength(2);
    remove.mockClear();
    expect(await deleteDuplicateGuildCommands(rest, "app", GLOBAL_PREFERRED_GUILD_ID)).toEqual([]);
    expect(remove).not.toHaveBeenCalled();
  });

  it("does not delete anything if the global read fails or there are no global commands", async () => {
    const { rest, get, remove } = restFixture();
    get.mockRejectedValueOnce(new Error("Discord unavailable"));
    await expect(deleteDuplicateGuildCommands(rest, "app", GLOBAL_PREFERRED_GUILD_ID)).rejects.toThrow("Discord unavailable");
    expect(remove).not.toHaveBeenCalled();
    get.mockImplementation(async (route) => route === Routes.applicationCommands("app")
      ? [] : [command("bounty", "bounty")]);
    expect(await deleteDuplicateGuildCommands(rest, "app", GLOBAL_PREFERRED_GUILD_ID)).toEqual([]);
    expect(remove).not.toHaveBeenCalled();
  });

  it("fails explicitly on deletion failure or unsuccessful post-delete verification", async () => {
    const rejected = restFixture();
    rejected.remove.mockRejectedValueOnce(new Error("Missing access"));
    await expect(deleteDuplicateGuildCommands(rejected.rest, "app", GLOBAL_PREFERRED_GUILD_ID)).rejects.toThrow("Missing access");
    const unchanged = restFixture();
    unchanged.remove.mockImplementation(async () => {});
    await expect(deleteDuplicateGuildCommands(unchanged.rest, "app", GLOBAL_PREFERRED_GUILD_ID)).rejects.toThrow("Duplicate guild commands remain");
    const missingExclusive = restFixture();
    const originalDelete = missingExclusive.remove.getMockImplementation()!;
    missingExclusive.remove.mockImplementation(async (route) => {
      await originalDelete(route);
      const index = missingExclusive.guild.findIndex((entry) => entry.name === "bounty");
      if (index >= 0) missingExclusive.guild.splice(index, 1);
    });
    await expect(deleteDuplicateGuildCommands(missingExclusive.rest, "app", GLOBAL_PREFERRED_GUILD_ID))
      .rejects.toThrow("guild-only");
  });
});

describe("startup registration respects global preference", () => {
  function manager(debit = false) {
    const saved = {
      id: "saved", equals: () => true,
      options: debit ? ["set", "remove", "list"].map((name) => ({ name })) : [
        { name: "set" }, { name: "remove" }, { name: "list" },
        { name: "config", type: 1, options: [{ name: "live", type: 5 }] },
      ],
    };
    const fetch = vi.fn(async (id?: unknown) => typeof id === "string" ? saved : new Collection());
    return { fetch, create: vi.fn(async () => saved), edit: vi.fn(async () => saved), delete: vi.fn() };
  }

  it.each([
    { name: "casino", run: syncCasinoCommandRegistration },
    { name: "chinchiro", run: syncChinchiroCommandRegistration },
    { name: "裏航海", run: syncUraCommandRegistration },
  ])("$name is registered globally and in other guilds, not recreated in the target guild", async ({ run }) => {
    const global = manager();
    const target = manager();
    const other = manager();
    const client = {
      application: { commands: global },
      guilds: { cache: new Collection([
        [GLOBAL_PREFERRED_GUILD_ID, { id: GLOBAL_PREFERRED_GUILD_ID, commands: target }],
        ["other-guild", { id: "other-guild", commands: other }],
      ]) },
    } as unknown as Client;
    await run(client);
    expect(global.create).toHaveBeenCalledOnce();
    expect(other.create).toHaveBeenCalledOnce();
    expect(target.fetch).not.toHaveBeenCalled();
    expect(target.create).not.toHaveBeenCalled();
    expect(target.edit).not.toHaveBeenCalled();
  });

  it.each([syncDailyRoleDebitCommandRegistration, syncMonthlyRoleDebitCommandRegistration])(
    "debit commands are not recreated in the target guild", async (run) => {
      const global = manager(true);
      const target = manager();
      const client = {
        application: { commands: global },
        guilds: { cache: new Collection([[GLOBAL_PREFERRED_GUILD_ID, { id: GLOBAL_PREFERRED_GUILD_ID, commands: target }]]) },
      } as unknown as Client;
      await run(client);
      expect(global.create).toHaveBeenCalledOnce();
      expect(target.create).not.toHaveBeenCalled();
      expect(target.fetch).not.toHaveBeenCalled();
    },
  );
});