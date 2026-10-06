import { afterEach, describe, expect, it, vi } from "vitest";
import { Collection, type ForumChannel, type Message, type ThreadChannel } from "discord.js";
import {
  copyForumMessages, downloadForumFile, ForumCopyFailure, parseForumSource, readForumMessages,
  splitForumText, type ForumCopyMessage,
} from "../lib/forumCopy";
import { resolveForumCopyTags } from "../commands/forumCopy";

afterEach(() => vi.unstubAllGlobals());
const guildId = "1526418867335725247";
const sourceId = "1540000000000000000";
const original: ForumCopyMessage = {
  id: "100", url: `https://discord.com/channels/${guildId}/${sourceId}/100`,
  author: "元*投稿者", authorId: "author-id", createdAt: new Date("2026-10-07T01:02:03Z"),
  content: "本文 @everyone", attachments: [],
};
function destination() {
  const edit = vi.fn().mockResolvedValue(undefined);
  let count = 0;
  const send = vi.fn(async (_payload: { content: string }) => ({ id: `copied-${++count}` }));
  const thread = { url: "https://discord.com/channels/guild/copy", send, fetchStarterMessage: vi.fn(async () => ({ edit })) };
  const create = vi.fn(async () => thread);
  return { forum: { threads: { create } } as unknown as ForumChannel, thread, create, edit, send };
}
function options(dest: ReturnType<typeof destination>, messages = [original]) {
  return {
    destination: dest.forum, title: "元のタイトル", sourceUrl: `https://discord.com/channels/${guildId}/${sourceId}`,
    messages, tags: ["tag"], actorId: "admin", fileLimit: 1000, onCreated: vi.fn(async () => {}),
  };
}
function message(id: string): Message {
  return {
    id, url: `https://discord.com/channels/${guildId}/${sourceId}/${id}`,
    author: { id: "author", username: "元投稿者" }, member: null, createdTimestamp: 1,
    content: `本文${id}`, embeds: [], stickers: new Collection(), attachments: new Collection(),
    reference: null, system: false,
  } as unknown as Message;
}

describe("forum copy source and preflight", () => {
  it("accepts a thread ID or same-guild post/message link, rejecting other guilds and arbitrary URLs", () => {
    expect(parseForumSource(sourceId, guildId)).toBe(sourceId);
    expect(parseForumSource(`https://discord.com/channels/${guildId}/${sourceId}/1550000000000000000`, guildId)).toBe(sourceId);
    for (const value of ["https://evil.example/channels/x/y", `https://discord.com/channels/111111111111111111/${sourceId}`, "not-an-id"]) {
      expect(() => parseForumSource(value, guildId)).toThrow();
    }
  });
  it("reads all pages oldest-first and checks attachment sizes before any copy", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Collection([["103", message("103")], ["102", message("102")]]))
      .mockResolvedValueOnce(new Collection([["101", message("101")]]))
      .mockResolvedValueOnce(new Collection());
    const source = { messages: { fetch } } as unknown as ThreadChannel;
    expect((await readForumMessages(source, 1000)).map((row) => row.id)).toEqual(["101", "102", "103"]);
    expect(fetch).toHaveBeenNthCalledWith(2, { limit: 100, before: "102" });
    const oversized = message("104");
    Object.assign(oversized, { attachments: new Collection([["file", { name: "big.png", size: 1001, url: "https://cdn.discordapp.com/file" }]]) });
    fetch.mockResolvedValueOnce(new Collection([["104", oversized]])).mockResolvedValueOnce(new Collection());
    await expect(readForumMessages(source, 1000)).rejects.toThrow("big.png");
  });
  it("fails explicitly above 1000 messages rather than silently truncating", async () => {
    let page = 0;
    const fetch = vi.fn(async () => new Collection(Array.from({ length: 100 }, (_, i) => {
      const id = String(10_000 - page * 100 - i);
      return [id, message(id)] as const;
    })));
    fetch.mockImplementation(async () => {
      const rows = new Collection(Array.from({ length: 100 }, (_, i) => {
        const id = String(10_000 - page * 100 - i);
        return [id, message(id)] as const;
      }));
      page++;
      return rows;
    });
    await expect(readForumMessages({ messages: { fetch } } as unknown as ThreadChannel, 1000)).rejects.toThrow("1000");
  });
  it("maps tag names across forums and enforces required destination tags", () => {
    const source = { appliedTags: ["old"], parent: { type: 15, availableTags: [{ id: "old", name: "商品" }] } } as unknown as ThreadChannel;
    const target = { availableTags: [{ id: "new", name: "商品" }], flags: { has: () => true } } as unknown as ForumChannel;
    expect(resolveForumCopyTags(target, source)).toEqual(["new"]);
    expect(resolveForumCopyTags(target, source, "商品")).toEqual(["new"]);
    expect(resolveForumCopyTags(target, source, "new")).toEqual(["new"]);
    expect(() => resolveForumCopyTags(target, source, "存在しない")).toThrow();
    expect(() => resolveForumCopyTags(target, { ...source, appliedTags: [] } as unknown as ThreadChannel)).toThrow("タグが必須");
  });
  it("splits long Unicode content without losing characters or splitting surrogate pairs", () => {
    const text = "🙂".repeat(2000) + "終わり";
    const parts = splitForumText(text, 1799);
    expect(parts.join("")).toBe(text);
    expect(parts.every((part) => part.length <= 1799 && !/[\uD800-\uDBFF]$/.test(part))).toBe(true);
  });
});

describe("forum copying", () => {
  it("copies attribution, timestamps, reply links, text and reuploads spoiler attachments without pinging anyone", async () => {
    const dest = destination();
    const file = { url: "https://cdn.discordapp.com/file", name: "SPOILER_image.png", size: 4 };
    const messages = [
      { ...original, attachments: [file] },
      { ...original, id: "101", replyTo: original.id, content: "返信", attachments: [] },
    ];
    const download = vi.fn(async () => Buffer.from("file"));
    const opts = { ...options(dest, messages), download };
    expect(await copyForumMessages(opts)).toEqual({ url: dest.thread.url, copied: 2 });
    expect(dest.create).toHaveBeenCalledWith(expect.objectContaining({ name: "元のタイトル", appliedTags: ["tag"] }));
    expect(opts.onCreated).toHaveBeenCalledWith(dest.thread.url);
    expect(download).toHaveBeenCalledWith(file, 1000);
    const first = dest.send.mock.calls[0][0] as unknown as { content: string; files: { name: string }[]; allowedMentions: unknown };
    expect(first.content).toContain("元\\*投稿者");
    expect(first.content).toContain("JST");
    expect(first.content).toContain(original.content);
    expect(first.files[0].name).toBe(file.name);
    expect(first.allowedMentions).toEqual({ parse: [], repliedUser: false });
    expect(dest.send.mock.calls[1][0]).toMatchObject({ reply: { messageReference: "copied-1", failIfNotExists: false } });
    expect(dest.edit.mock.calls.at(-1)?.[0].content).toContain("コピー完了: 2件");
  });
  it("copies long messages in full and refuses files above a changed size limit before creating a thread", async () => {
    const dest = destination();
    const content = "文".repeat(5000);
    await copyForumMessages(options(dest, [{ ...original, content }]));
    const text = dest.send.mock.calls.map(([payload]) => (payload as { content: string }).content.split("\n").at(-1)).join("");
    expect(text).toBe(content);
    expect(dest.send.mock.calls.every(([payload]) => (payload as { content: string }).content.length <= 2000)).toBe(true);
    dest.create.mockClear();
    await expect(copyForumMessages(options(dest, [{
      ...original, attachments: [{ url: "https://cdn.discordapp.com/file", name: "big.png", size: 1001 }],
    }]))).rejects.toThrow("上限");
    expect(dest.create).not.toHaveBeenCalled();
  });
  it("reports partial failure accurately and keeps the created destination for inspection", async () => {
    const dest = destination();
    dest.send.mockRejectedValueOnce(new Error("send failed"));
    await expect(copyForumMessages(options(dest))).rejects.toMatchObject({
      threadUrl: dest.thread.url, copied: 0,
    } satisfies Partial<ForumCopyFailure>);
    expect(dest.edit.mock.calls.at(-1)?.[0].content).toContain("コピー停止: 0/1件");
  });
  it("only downloads Discord attachments and bounds actual bytes received", async () => {
    const fetch = vi.fn(async () => new Response(Buffer.from("12345")));
    vi.stubGlobal("fetch", fetch);
    await expect(downloadForumFile({ url: "https://evil.example/file", name: "file", size: 1 }, 4)).rejects.toThrow("Discord以外");
    expect(fetch).not.toHaveBeenCalled();
    await expect(downloadForumFile({ url: "https://cdn.discordapp.com/file", name: "file", size: 1 }, 4)).rejects.toThrow("上限");
    expect(await downloadForumFile({ url: "https://cdn.discordapp.com/file", name: "file", size: 5 }, 5)).toEqual(Buffer.from("12345"));
  });
});
