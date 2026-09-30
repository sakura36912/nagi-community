import { describe, expect, it, vi } from "vitest";
import {
  ApplicationCommand,
  Client,
  Collection,
  type APIApplicationCommand,
} from "discord.js";
import { casinoCommand } from "../commands/casino";
import { syncCasinoCommandRegistration } from "../lib/casinoCommandRegistration";

const ApplicationCommandCtor = ApplicationCommand as unknown as
  new (client: Client, data: APIApplicationCommand) => ApplicationCommand;
const discordClient = new Client({ intents: [] });
const definition = JSON.parse(JSON.stringify(casinoCommand.data.toJSON())) as APIApplicationCommand;

function remoteCommand(overrides: Record<string, unknown> = {}) {
  return new ApplicationCommandCtor(discordClient, {
    ...definition,
    id: "123456789012345678",
    application_id: "123456789012345679",
    version: "123456789012345680",
    nsfw: false,
    contexts: [0, 1, 2],
    integration_types: [0],
    ...overrides,
  } as APIApplicationCommand);
}

function manager(initial: ApplicationCommand | null, afterUpdate = remoteCommand()) {
  return {
    fetch: vi.fn(async (arg: unknown) => typeof arg === "string"
      ? afterUpdate
      : new Collection(initial ? [[initial.id, initial]] : [])),
    edit: vi.fn(async () => afterUpdate),
    create: vi.fn(async () => afterUpdate),
    delete: vi.fn(),
    set: vi.fn(),
  };
}

describe("casino registration with Discord command objects", () => {
  it("does not rewrite the actual builder definition after Discord applies its defaults", async () => {
    const global = manager(remoteCommand());
    const guild = manager(remoteCommand({ contexts: [0], integration_types: [0] }));
    const client = {
      application: { commands: global },
      guilds: { cache: new Collection([["guild-id", { id: "guild-id", commands: guild }]]) },
    } as unknown as Client;
    await syncCasinoCommandRegistration(client);
    expect(global.edit).not.toHaveBeenCalled();
    expect(guild.edit).not.toHaveBeenCalled();
    expect(global.create).not.toHaveBeenCalled();
    expect(guild.create).not.toHaveBeenCalled();
  });

  it("reads back and accepts the actual definition after updating an outdated command", async () => {
    const global = manager(remoteCommand({ nsfw: true }));
    const client = {
      application: { commands: global },
      guilds: { cache: new Collection() },
    } as unknown as Client;
    await syncCasinoCommandRegistration(client);
    expect(global.edit).toHaveBeenCalledOnce();
    expect(global.fetch).toHaveBeenCalledWith("123456789012345678", { force: true });
    expect(global.delete).not.toHaveBeenCalled();
  });
});