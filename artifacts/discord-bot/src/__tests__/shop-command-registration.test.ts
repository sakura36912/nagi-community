import { ApplicationCommandType, Collection, PermissionsBitField, PermissionFlagsBits, SlashCommandBuilder, type Client } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { syncShopCommandRegistration } from "../lib/shopCommandRegistration";
import { GLOBAL_PREFERRED_GUILD_ID } from "../lib/guildCommandScope";

const definition = new SlashCommandBuilder().setName("shop").setDescription("ショップ").setDefaultMemberPermissions(null)
  .addSubcommand((sub) => sub.setName("forum-panel").setDescription("パネル")
    .addRoleOption((option) => option.setName("cast_role").setDescription("対象ロール")))
  .addSubcommand((sub) => sub.setName("cast-roles").setDescription("複数ロールを設定")).toJSON();
function manager(existing = true, valid = true, restricted = false) {
  const command = { id: "shop-id", name: "shop", type: ApplicationCommandType.ChatInput,
    defaultMemberPermissions: restricted ? new PermissionsBitField(PermissionFlagsBits.Administrator) : null,
    options: valid ? definition.options : [] };
  return {
    fetch: vi.fn(async (id?: unknown) => typeof id === "string" ? command
      : new Collection(existing ? [["shop-id", command]] : [])),
    edit: vi.fn(async () => command), create: vi.fn(async () => command), set: vi.fn(), delete: vi.fn(),
  };
}
describe("/shop cast role command registration", () => {
  it("reports an unchanged Discord administrator-only permission restriction", async () => {
    const client = { application: { commands: manager(true, true, true) }, guilds: { cache: new Collection() } } as unknown as Client;
    await expect(syncShopCommandRegistration(client, definition)).rejects.toThrow("registration failed");
  });
  it("updates global and non-global-preferred guild definitions without deleting any other commands", async () => {
    const global = manager(), guild = manager(false), protectedGuild = manager();
    const client = { application: { commands: global }, guilds: { cache: new Collection([
      ["guild", { id: "guild", commands: guild }],
      [GLOBAL_PREFERRED_GUILD_ID, { id: GLOBAL_PREFERRED_GUILD_ID, commands: protectedGuild }],
    ]) } } as unknown as Client;
    await syncShopCommandRegistration(client, definition);
    expect(global.edit).toHaveBeenCalledWith("shop-id", definition);
    expect(guild.create).toHaveBeenCalledWith(definition);
    expect(protectedGuild.fetch).not.toHaveBeenCalled();
    expect(global.set).not.toHaveBeenCalled();
    expect(global.delete).not.toHaveBeenCalled();
    expect(guild.delete).not.toHaveBeenCalled();
  });
  it("reports failed verification instead of claiming cast_role was registered", async () => {
    const client = { application: { commands: manager(true, false) }, guilds: { cache: new Collection() } } as unknown as Client;
    await expect(syncShopCommandRegistration(client, definition)).rejects.toThrow("registration failed");
  });
});
