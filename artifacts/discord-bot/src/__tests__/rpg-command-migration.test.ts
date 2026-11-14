import { describe, expect, it, vi } from "vitest";
import { ApplicationCommandType, Collection, Routes } from "discord.js";
import { REMOVED_BANK_COMMAND_NAMES, handleRetiredBankRpgInteraction, removeBankRpgCommands } from "../lib/rpgCommandMigration";

function setup() {
  const routes = [
    Routes.applicationCommands("bank"),
    Routes.applicationGuildCommands("bank", "guild"),
  ];
  const definitions = new Map<string, { id: string; name: string; type: number }[]>(
    routes.map((route) => [route, [
      ...REMOVED_BANK_COMMAND_NAMES.map((name, i) => ({ id: `removed-${i}`, name, type: ApplicationCommandType.ChatInput })),
      { id: "pvp", name: "pvp", type: ApplicationCommandType.ChatInput },
      { id: "shop", name: "shop", type: ApplicationCommandType.ChatInput },
      { id: "casino", name: "casino", type: ApplicationCommandType.ChatInput },
      { id: "transfer", name: "送金", type: ApplicationCommandType.ChatInput },
      { id: "balance", name: "残高確認", type: ApplicationCommandType.ChatInput },
      { id: "context", name: "weapon", type: ApplicationCommandType.User },
    ]]),
  );
  const rest = {
    get: vi.fn(async (route: string) => definitions.get(route)?.map((command) => ({ ...command })) ?? []),
    delete: vi.fn(async (route: string) => {
      const parent = route.slice(0, route.lastIndexOf("/"));
      const id = route.slice(route.lastIndexOf("/") + 1);
      definitions.set(parent, definitions.get(parent)!.filter((command) => command.id !== id));
    }),
  };
  const bank = {
    application: { id: "bank" },
    guilds: { cache: new Collection([["guild", { id: "guild" }]]) },
    rest,
  };
  return { bank, definitions, rest, routes };
}

describe("targeted Bank Bot command removal", () => {
  it("removes disabled commands from global and cached guild scopes", async () => {
    const state = setup();
    expect(await removeBankRpgCommands(state.bank as never)).toBe(REMOVED_BANK_COMMAND_NAMES.length * 2);
    expect(state.rest.delete).toHaveBeenCalledTimes(REMOVED_BANK_COMMAND_NAMES.length * 2);
    expect(state.rest.get).toHaveBeenCalledTimes(4);
    for (const route of state.routes) {
      const remaining = state.definitions.get(route)!;
      for (const name of REMOVED_BANK_COMMAND_NAMES) {
        expect(remaining.some((command) => command.name === name && command.type === ApplicationCommandType.ChatInput)).toBe(false);
      }
      expect(remaining.map((command) => command.name)).toEqual(
        expect.arrayContaining(["pvp", "shop", "casino", "送金", "残高確認", "weapon"]),
      );
    }
  });

  it("fails without an application identity and stops on API errors", async () => {
    const state = setup();
    await expect(removeBankRpgCommands({ ...state.bank, application: null } as never)).rejects.toThrow("Bank application unavailable");
    state.rest.get.mockRejectedValueOnce(new Error("Offline"));
    await expect(removeBankRpgCommands(state.bank as never)).rejects.toThrow("Offline");
    expect(state.rest.delete).not.toHaveBeenCalled();
  });

  it.each(["forge:confirm:old", "boss:attack:old"])("redirects stale Bank Bot buttons %s", async (customId) => {
    const interaction = {
      customId,
      isButton: () => true,
      isChatInputCommand: () => false,
      reply: vi.fn(async () => undefined),
    };
    expect(await handleRetiredBankRpgInteraction(interaction as never)).toBe(true);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });
});
