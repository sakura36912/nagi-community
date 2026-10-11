import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType, Collection, PermissionFlagsBits, type ChatInputCommandInteraction, type RoleSelectMenuInteraction } from "discord.js";
const mocks = vi.hoisted(() => ({ getPanel: vi.fn(), setRoles: vi.fn() }));
vi.mock("@workspace/db", () => ({
  getShopForumPanel: mocks.getPanel, setShopForumPanelCastRoles: mocks.setRoles,
}));
import { buildForumCastRoleConfig, handleForumCastRoleConfig, showForumCastRoleConfig } from "../commands/forumCastRoles";

function fixture() {
  const roles = new Collection([["first", { id: "first" }], ["second", { id: "second" }]]);
  return {
    guild: { id: "guild", roles: { fetch: vi.fn(async () => roles) } },
    channelId: "thread", channel: { isThread: () => true, parent: { type: ChannelType.GuildForum } },
    user: { id: "admin" }, memberPermissions: { has: vi.fn(() => true) },
    customId: "shop:forum-cast-roles:10:admin", values: ["first", "second"],
    reply: vi.fn().mockResolvedValue(undefined), editReply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined), deferUpdate: vi.fn().mockResolvedValue(undefined),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPanel.mockResolvedValue({ shopItemId: 10, castRoleId: "first", castRoleIds: ["first"] });
  mocks.setRoles.mockResolvedValue({ shopItemId: 10, castRoleId: "first", castRoleIds: ["first", "second"] });
});

describe("forum multi-role configuration", () => {
  it("uses Discord's native multi-role selector with the current roles preselected", () => {
    const menu = buildForumCastRoleConfig(10, "admin", ["first", "second"])[0].components[0].toJSON();
    expect(menu.type).toBe(6);
    expect(menu.min_values).toBe(1);
    expect(menu.max_values).toBe(25);
    expect(menu.default_values).toEqual([{ id: "first", type: "role" }, { id: "second", type: "role" }]);
  });
  it("shows an ephemeral setting UI only for administrators in the configured forum post", async () => {
    const interaction = fixture();
    await showForumCastRoleConfig(interaction as unknown as ChatInputCommandInteraction);
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.memberPermissions.has).toHaveBeenCalledWith(PermissionFlagsBits.ManageGuild);
    expect(mocks.getPanel).toHaveBeenCalledWith("guild", "thread");
    expect(interaction.editReply.mock.calls[0][0].content).toContain("置き換わります");
    expect(mocks.setRoles).not.toHaveBeenCalled();
  });
  it("does not preselect deleted roles, so administrators can repair a stale configuration", async () => {
    mocks.getPanel.mockResolvedValue({ shopItemId: 10, castRoleIds: ["first", "deleted"] });
    const interaction = fixture();
    await showForumCastRoleConfig(interaction as unknown as ChatInputCommandInteraction);
    expect(interaction.editReply.mock.calls[0][0].components[0].components[0].toJSON().default_values)
      .toEqual([{ id: "first", type: "role" }]);
  });
  it("atomically replaces the role selection in the same post and suppresses role notifications", async () => {
    const interaction = fixture();
    interaction.values = ["first", "second", "first"];
    await handleForumCastRoleConfig(interaction as unknown as RoleSelectMenuInteraction);
    expect(mocks.setRoles).toHaveBeenCalledWith("guild", "thread", 10, ["first", "second"]);
    expect(interaction.editReply.mock.calls[0][0]).toMatchObject({ components: [], allowedMentions: { parse: [] } });
    expect(interaction.editReply.mock.calls[0][0].content).toContain("2個");
  });
  it.each(["other-admin", "regular-member"])("rejects %s before modifying settings", async (kind) => {
    const interaction = fixture();
    if (kind === "other-admin") interaction.user.id = "other-admin";
    else interaction.memberPermissions.has.mockReturnValue(false);
    await handleForumCastRoleConfig(interaction as unknown as RoleSelectMenuInteraction);
    expect(mocks.setRoles).not.toHaveBeenCalled();
    expect(interaction.reply.mock.calls[0][0].content).toContain("本人のみ");
  });
  it.each([
    { values: [] }, { values: ["guild"] }, { values: ["deleted"] },
    { values: Array.from({ length: 26 }, (_, i) => `role-${i}`) },
  ])("rejects invalid role selections without writes (%j)", async ({ values }) => {
    const interaction = fixture();
    interaction.values = values;
    await handleForumCastRoleConfig(interaction as unknown as RoleSelectMenuInteraction);
    expect(mocks.setRoles).not.toHaveBeenCalled();
    expect(interaction.editReply.mock.calls[0][0].components).toEqual([]);
  });
  it("rejects an expired configuration for a replaced/deleted panel", async () => {
    mocks.setRoles.mockResolvedValue(undefined);
    const interaction = fixture();
    await handleForumCastRoleConfig(interaction as unknown as RoleSelectMenuInteraction);
    expect(interaction.editReply.mock.calls[0][0].content).toContain("別の商品に変更");
  });
  it("shows a clear error when the update fails, without claiming success", async () => {
    mocks.setRoles.mockRejectedValue(new Error("Database unavailable"));
    const interaction = fixture();
    await handleForumCastRoleConfig(interaction as unknown as RoleSelectMenuInteraction);
    expect(interaction.editReply.mock.calls[0][0].content).toBe("Database unavailable");
  });
  it("does not write settings from a non-forum channel", async () => {
    const interaction = fixture();
    interaction.channel.isThread = () => false;
    await handleForumCastRoleConfig(interaction as unknown as RoleSelectMenuInteraction);
    expect(mocks.setRoles).not.toHaveBeenCalled();
  });
});
