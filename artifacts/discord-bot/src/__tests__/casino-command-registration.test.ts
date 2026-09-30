import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplicationCommandType, Collection, type Client } from "discord.js";

const loggerMocks = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }));
vi.mock("../lib/logger", () => ({ logger: loggerMocks }));
vi.mock("../commands/casino", () => ({
  casinoCommand: {
    data: {
      toJSON: () => ({
        name: "casino", description: "カジノコマンド", type: ApplicationCommandType.ChatInput,
        options: [{ name: "chohan", type: 2 }, { name: "poker", type: 2 }],
      }),
    },
  },
}));

import { syncCasinoCommandRegistration } from "../lib/casinoCommandRegistration";

function manager(initial: "stale" | "current" | "missing", fail = false) {
  const existing = {
    id: "command-id", name: "casino", type: ApplicationCommandType.ChatInput,
    equals: vi.fn(() => initial === "current"),
  };
  const verified = { ...existing, equals: vi.fn(() => true) };
  const unrelated = { id: "other-id", name: "裏航海", type: ApplicationCommandType.ChatInput };
  const fetch = vi.fn(async (arg: unknown) => typeof arg === "string"
    ? verified
    : new Collection([["other-id", unrelated], ...(initial === "missing" ? [] : [["command-id", existing]] as const)]));
  const edit = vi.fn(async () => {
    if (fail) throw new Error("Discord registration rejected");
    return verified;
  });
  const create = vi.fn(async () => {
    if (fail) throw new Error("Discord registration rejected");
    return verified;
  });
  return { fetch, edit, create, delete: vi.fn(), set: vi.fn() };
}

afterEach(() => vi.clearAllMocks());

describe("casino command registration", () => {
  it("updates stale global and guild definitions individually without deleting another command", async () => {
    const global = manager("stale");
    const guild = manager("missing");
    const client = {
      application: { commands: global },
      guilds: { cache: new Collection([["guild-id", { id: "guild-id", commands: guild }]]) },
    } as unknown as Client;
    await syncCasinoCommandRegistration(client);
    expect(global.edit).toHaveBeenCalledOnce();
    expect(guild.create).toHaveBeenCalledOnce();
    expect(global.fetch).toHaveBeenCalledWith("command-id", { force: true });
    expect(guild.fetch).toHaveBeenCalledWith("command-id", { force: true });
    expect(global.delete).not.toHaveBeenCalled();
    expect(guild.delete).not.toHaveBeenCalled();
    expect(global.set).not.toHaveBeenCalled();
    expect(guild.set).not.toHaveBeenCalled();
  });

  it("logs scope-specific failures but still updates other guilds", async () => {
    const global = manager("stale", true);
    const guild = manager("missing");
    const client = {
      application: { commands: global },
      guilds: { cache: new Collection([["guild-id", { id: "guild-id", commands: guild }]]) },
    } as unknown as Client;
    await expect(syncCasinoCommandRegistration(client)).rejects.toThrow(/1 command scope/);
    expect(guild.create).toHaveBeenCalledOnce();
    expect(loggerMocks.error).toHaveBeenCalledWith(
      "[casino] Command registration failed (global)", expect.any(Error),
    );
  });

  it("skips writes when Discord already has the current casino definition", async () => {
    const global = manager("current");
    const client = {
      application: { commands: global },
      guilds: { cache: new Collection() },
    } as unknown as Client;
    await syncCasinoCommandRegistration(client);
    expect(global.edit).not.toHaveBeenCalled();
    expect(global.create).not.toHaveBeenCalled();
  });
});