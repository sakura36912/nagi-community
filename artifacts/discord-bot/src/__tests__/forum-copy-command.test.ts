import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelType, Collection, type ButtonInteraction, type ChatInputCommandInteraction } from "discord.js";
import { forumCopyCommand, handleForumCopyButton } from "../commands/forumCopy";

const guildId = "1526418867335725247";
const sourceId = "1540000000000000000";
const targetId = "1550000000000000000";
function fixture() {
  const status = { edit: vi.fn().mockResolvedValue(undefined) };
  const copiedThread = { url: "https://discord.com/channels/guild/copied", fetchStarterMessage: vi.fn(async () => status), send: vi.fn(async () => ({ id: "copied" })) };
  const create = vi.fn(async () => copiedThread);
  const parent = { id: "parent", type: ChannelType.GuildForum, availableTags: [] };
  const sourceMessage = {
    id: "1560000000000000000", author: { id: "original-author", username: "投稿者" }, member: null,
    content: "コピー本文", createdTimestamp: Date.now(), url: "https://discord.com/channels/guild/source/message",
    system: false, embeds: [], attachments: new Collection(), stickers: new Collection(), reference: null,
  };
  const source = {
    id: sourceId, guild: { id: guildId }, type: ChannelType.PublicThread,
    name: "元の投稿", parentId: parent.id, parent, appliedTags: [], url: `https://discord.com/channels/${guildId}/${sourceId}`,
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: vi.fn(async (opts: { before?: string }) => opts.before
      ? new Collection() : new Collection([[sourceMessage.id, sourceMessage]])) },
    delete: vi.fn(), setLocked: vi.fn(), setArchived: vi.fn(),
  };
  const target = {
    id: targetId, guild: { id: guildId }, type: ChannelType.GuildForum,
    availableTags: [], flags: { has: () => false }, permissionsFor: () => ({ has: () => true }),
    threads: { create },
  };
  const guild = {
    id: guildId, members: { me: {} },
    channels: { fetch: vi.fn(async (id: string) => id === sourceId ? source : id === targetId ? target : parent) },
  };
  const base = {
    guild, guildId, user: { id: "admin" }, memberPermissions: { has: () => true },
    attachmentSizeLimit: 10 * 1024 * 1024,
    reply: vi.fn(), deferReply: vi.fn(), deferUpdate: vi.fn(), editReply: vi.fn().mockResolvedValue(undefined),
  };
  const command = {
    ...base, options: { getString: (name: string) => name === "source" ? sourceId : null, getChannel: () => ({ id: targetId }) },
  };
  const button = (id: string, userId = "admin", admin = true) => ({
    ...base, customId: id, user: { id: userId }, memberPermissions: { has: () => admin },
    reply: vi.fn(), deferUpdate: vi.fn(), editReply: vi.fn().mockResolvedValue(undefined),
  });
  const preview = async () => {
    command.editReply.mockClear();
    await forumCopyCommand.execute(command as unknown as ChatInputCommandInteraction);
    const payload = command.editReply.mock.calls[0][0];
    return payload.components[0].components.map((component: { data: { custom_id: string } }) => component.data.custom_id) as [string, string];
  };
  return { source, target, command, button, preview, create, copiedThread, status };
}
afterEach(() => vi.useRealTimers());

describe("/forum-copy confirmation workflow", () => {
  it("requires administrators and makes no changes during preview or cancellation", async () => {
    const f = fixture();
    const denied = { ...f.command, memberPermissions: { has: () => false }, reply: vi.fn() };
    await forumCopyCommand.execute(denied as unknown as ChatInputCommandInteraction);
    expect(denied.reply).toHaveBeenCalledWith(expect.objectContaining({ content: "サーバー管理者のみ実行できます。" }));
    const [, cancel] = await f.preview();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.command.editReply.mock.calls[0][0].content).toContain("公開範囲");
    const clicked = f.button(cancel);
    await handleForumCopyButton(clicked as unknown as ButtonInteraction);
    expect(clicked.editReply.mock.calls[0][0].content).toContain("キャンセル");
    expect(f.create).not.toHaveBeenCalled();
  });
  it("allows only the initiating administrator to confirm and consumes the confirmation exactly once", async () => {
    const f = fixture();
    const [confirm] = await f.preview();
    const stranger = f.button(confirm, "other-admin");
    await handleForumCopyButton(stranger as unknown as ButtonInteraction);
    expect(stranger.reply.mock.calls[0][0].content).toContain("本人のみ");
    const lostPermissions = f.button(confirm, "admin", false);
    await handleForumCopyButton(lostPermissions as unknown as ButtonInteraction);
    expect(f.create).not.toHaveBeenCalled();
    const clicked = f.button(confirm);
    await handleForumCopyButton(clicked as unknown as ButtonInteraction);
    expect(f.create).toHaveBeenCalledOnce();
    expect(clicked.editReply.mock.calls.at(-1)?.[0].content).toContain("コピー完了");
    await handleForumCopyButton(f.button(confirm) as unknown as ButtonInteraction);
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.source.delete).not.toHaveBeenCalled();
    expect(f.source.setLocked).not.toHaveBeenCalled();
    expect(f.source.setArchived).not.toHaveBeenCalled();
  });
  it("expires confirmations after five minutes", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const [confirm] = await f.preview();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const clicked = f.button(confirm);
    await handleForumCopyButton(clicked as unknown as ButtonInteraction);
    expect(clicked.reply.mock.calls[0][0].content).toContain("確認期限");
    expect(f.create).not.toHaveBeenCalled();
  });
  it("rechecks permissions and destination type before creating anything", async () => {
    const f = fixture();
    const [confirm] = await f.preview();
    f.target.permissionsFor = () => ({ has: () => false });
    const clicked = f.button(confirm);
    await handleForumCopyButton(clicked as unknown as ButtonInteraction);
    expect(f.create).not.toHaveBeenCalled();
    expect(clicked.editReply.mock.calls[0][0].content).toContain("権限");
  });
  it("keeps the original untouched and reports the partial destination on copy failure", async () => {
    const f = fixture();
    const [confirm] = await f.preview();
    f.copiedThread.send.mockRejectedValueOnce(new Error("Discord unavailable"));
    const clicked = f.button(confirm);
    await handleForumCopyButton(clicked as unknown as ButtonInteraction);
    expect(clicked.editReply.mock.calls.at(-1)?.[0].content).toContain("途中まで");
    expect(clicked.editReply.mock.calls.at(-1)?.[0].content).toContain(f.copiedThread.url);
    expect(f.status.edit.mock.calls.at(-1)?.[0].content).toContain("コピー停止");
    expect(f.source.delete).not.toHaveBeenCalled();
  });
});
