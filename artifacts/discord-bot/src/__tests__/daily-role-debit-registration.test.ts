import { describe, expect, it, vi } from "vitest";
import { ApplicationCommandType, Collection, type Client } from "discord.js";
import { syncDailyRoleDebitCommandRegistration } from "../lib/dailyRoleDebitRegistration.js";

function manager(initial: "existing" | "missing") {
  const verified = { id: "daily-id", options: ["set", "remove", "list"].map((name) => ({ name })) };
  const existing = { id: "daily-id", name: "日額引き落とし", type: ApplicationCommandType.ChatInput };
  const other = { id: "other-id", name: "月額引き落とし", type: ApplicationCommandType.ChatInput };
  const fetch = vi.fn(async (id?: unknown) => typeof id === "string"
    ? verified
    : new Collection([
      ["other-id", other],
      ...(initial === "existing" ? [["daily-id", existing]] as const : []),
    ]));
  return { fetch, edit: vi.fn(async () => verified), create: vi.fn(async () => verified), set: vi.fn(), delete: vi.fn() };
}

describe("日額引き落としのDiscord登録", () => {
  it("対象コマンドだけをグローバルとサーバーで更新し、他のコマンドを残す", async () => {
    const global = manager("existing");
    const guild = manager("missing");
    const client = {
      application: { commands: global },
      guilds: { cache: new Collection([["guild", { id: "guild", commands: guild }]]) },
    } as unknown as Client;
    await syncDailyRoleDebitCommandRegistration(client);
    expect(global.edit).toHaveBeenCalledOnce();
    expect(guild.create).toHaveBeenCalledOnce();
    expect(global.fetch).toHaveBeenCalledWith("daily-id", { force: true });
    expect(guild.fetch).toHaveBeenCalledWith("daily-id", { force: true });
    expect(global.set).not.toHaveBeenCalled();
    expect(guild.set).not.toHaveBeenCalled();
    expect(global.delete).not.toHaveBeenCalled();
    expect(guild.delete).not.toHaveBeenCalled();
  });
});