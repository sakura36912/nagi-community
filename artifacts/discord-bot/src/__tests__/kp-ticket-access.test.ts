import { ChannelType, type ButtonInteraction, type GuildMember } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { grantKpTicketCastAccess } from "../lib/kpTicketAccess";

vi.mock("../lib/logger", () => ({ logger: { error: vi.fn() } }));
function fixture(type = ChannelType.GuildText) {
  const edit = vi.fn().mockResolvedValue(undefined), add = vi.fn().mockResolvedValue("cast");
  const parent = { guildId: "guild", permissionsFor: vi.fn((_member: unknown) => ({ has: (): boolean => true })), permissionOverwrites: { edit: vi.fn().mockResolvedValue(undefined) } };
  const channel = {
    id: "ticket", guildId: "guild", type, isThread: () => type !== ChannelType.GuildText,
    archived: false, locked: false, parent, parentId: "parent",
    permissionsFor: vi.fn(() => ({ has: (): boolean => true })),
    permissionOverwrites: { edit }, members: { add },
  };
  const cast = { id: "cast", guild: { id: "guild" } };
  const interaction = { channel, channelId: "ticket", guildId: "guild", guild: { members: { me: { id: "bot" } } } };
  const grant = () => grantKpTicketCastAccess(interaction as unknown as ButtonInteraction, cast as GuildMember);
  return { channel, parent, cast, interaction, edit, add, grant };
}
beforeEach(() => vi.clearAllMocks());
describe("KP ticket selected-cast access", () => {
  it("merges only the selected member's read/write/history permissions into this ticket", async () => {
    const i = fixture(); await i.grant(); await i.grant();
    expect(i.edit).toHaveBeenCalledWith("cast", {
      ViewChannel: true, SendMessages: true, ReadMessageHistory: true,
    }, expect.objectContaining({ reason: expect.any(String) }));
    expect(i.edit).toHaveBeenCalledTimes(2); // Same edit is safe to repeat.
    expect(i.parent.permissionOverwrites.edit).not.toHaveBeenCalled();
    expect(i.add).not.toHaveBeenCalled();
    expect(i.channel.permissionsFor).toHaveBeenCalledWith({ id: "bot" });
  });
  it.each([ChannelType.PrivateThread, ChannelType.PublicThread])("adds the cast to thread type %s without widening its parent", async type => {
    const i = fixture(type); await i.grant();
    expect(i.add).toHaveBeenCalledWith("cast");
    expect(i.edit).not.toHaveBeenCalled();
    expect(i.parent.permissionOverwrites.edit).not.toHaveBeenCalled();
    expect(i.parent.permissionsFor).toHaveBeenCalledWith(i.cast);
  });
  it.each([ChannelType.PrivateThread, ChannelType.PublicThread])("grants only required parent permissions to the selected cast for thread type %s", async type => {
    const i = fixture(type);
    i.parent.permissionsFor.mockImplementation(member => ({ has: () => member !== i.cast }));
    await i.grant();
    expect(i.parent.permissionOverwrites.edit).toHaveBeenCalledWith("cast", {
      ViewChannel: true, SendMessagesInThreads: true, ReadMessageHistory: true,
    }, expect.objectContaining({ reason: expect.any(String) }));
    expect(i.add).toHaveBeenCalledWith("cast");
    expect(i.parent.permissionOverwrites.edit.mock.invocationCallOrder[0]).toBeLessThan(i.add.mock.invocationCallOrder[0]);
    expect(i.edit).not.toHaveBeenCalled();
  });
  it("blocks thread membership when the bot cannot manage missing parent permissions", async () => {
    const i = fixture(ChannelType.PrivateThread);
    i.parent.permissionsFor.mockReturnValue({ has: () => false });
    await expect(i.grant()).rejects.toThrow("親チャンネル");
    expect(i.add).not.toHaveBeenCalled(); expect(i.edit).not.toHaveBeenCalled();
    expect(i.parent.permissionOverwrites.edit).not.toHaveBeenCalled();
  });
  it("blocks thread membership if the parent permission update fails", async () => {
    const i = fixture(ChannelType.PrivateThread);
    i.parent.permissionsFor.mockImplementation(member => ({ has: () => member !== i.cast }));
    i.parent.permissionOverwrites.edit.mockRejectedValue(new Error("Missing Permissions"));
    await expect(i.grant()).rejects.toThrow("引き落としは行っていません");
    expect(i.add).not.toHaveBeenCalled();
  });
  it("does not grant access to a parent from another guild", async () => {
    const i = fixture(ChannelType.PrivateThread); i.parent.guildId = "another-guild";
    await expect(i.grant()).rejects.toThrow("親チャンネルを確認できません");
    expect(i.parent.permissionOverwrites.edit).not.toHaveBeenCalled();
    expect(i.add).not.toHaveBeenCalled();
  });
  it.each(["archived", "locked"] as const)("does not reopen a thread that is %s", async flag => {
    const i = fixture(ChannelType.PrivateThread); i.channel[flag] = true;
    await expect(i.grant()).rejects.toThrow("終了・ロック済み");
    expect(i.add).not.toHaveBeenCalled();
  });
  it("requires the bot's overwrite-management permission, not administrator access for the cast", async () => {
    const i = fixture();
    i.channel.permissionsFor.mockReturnValue({ has: () => false });
    await expect(i.grant()).rejects.toThrow("ロールの管理");
    expect(i.edit).not.toHaveBeenCalled();
  });
  it.each(["channel", "guild", "cast"] as const)("rejects a mismatched %s before granting access", async mismatch => {
    const i = fixture();
    if (mismatch === "channel") i.interaction.channelId = "another-ticket";
    if (mismatch === "guild") i.interaction.guildId = "another-guild";
    if (mismatch === "cast") i.cast.guild.id = "another-guild";
    await expect(i.grant()).rejects.toThrow("チケットを確認できない");
    expect(i.edit).not.toHaveBeenCalled(); expect(i.add).not.toHaveBeenCalled();
  });
  it.each([ChannelType.GuildText, ChannelType.PrivateThread])("reports Discord permission failures for type %s", async type => {
    const i = fixture(type);
    (type === ChannelType.GuildText ? i.edit : i.add).mockRejectedValue(new Error("Missing Permissions"));
    await expect(i.grant()).rejects.toThrow("引き落としは行っていません");
  });
});
