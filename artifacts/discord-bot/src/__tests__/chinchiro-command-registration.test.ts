import { describe, expect, it, vi } from "vitest";
import { ApplicationCommandOptionType, ApplicationCommandType, Collection, type Client } from "discord.js";
import { chinchiroCommand } from "../commands/chinchiro.js";
import { syncChinchiroCommandRegistration } from "../lib/chinchiroCommandRegistration.js";

describe("/chinchiro のDiscord登録", () => {
  it("既存の他コマンドを残し、グローバルとサーバーのconfig.liveを更新する", async () => {
    const definition = chinchiroCommand.data.toJSON();
    const config = definition.options?.find((option) =>
      option.name === "config" && option.type === ApplicationCommandOptionType.Subcommand);
    if (!config || !("options" in config)) throw new Error("Missing config subcommand");
    expect(config?.options?.some((option) => option.name === "live")).toBe(true);
    const registered = {
      id: "chinchiro-id", name: "chinchiro",
      type: ApplicationCommandType.ChatInput, options: definition.options,
    };
    function manager() {
      const fetch = vi.fn(async (id?: unknown) => typeof id === "string"
        ? registered
        : new Collection([
          ["chinchiro-id", { ...registered, options: [] }],
          ["unrelated-id", { id: "unrelated-id", name: "casino", type: ApplicationCommandType.ChatInput }],
        ]));
      return {
        fetch,
        edit: vi.fn(async () => registered),
        create: vi.fn(),
        set: vi.fn(),
        delete: vi.fn(),
      };
    }
    const global = manager();
    const guild = manager();
    const client = {
      application: { commands: global },
      guilds: { cache: new Collection([["guild", { id: "guild", commands: guild }]]) },
    } as unknown as Client;
    await syncChinchiroCommandRegistration(client);
    for (const scope of [global, guild]) {
      expect(scope.edit).toHaveBeenCalledWith("chinchiro-id", definition);
      expect(scope.fetch).toHaveBeenCalledWith("chinchiro-id", { force: true });
      expect(scope.set).not.toHaveBeenCalled();
      expect(scope.delete).not.toHaveBeenCalled();
    }
  });
});