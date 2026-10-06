import { AttachmentBuilder, escapeMarkdown, type ForumChannel, type Message, type ThreadChannel } from "discord.js";

export const FORUM_COPY_MAX_MESSAGES = 1_000;
export const FORUM_COPY_MAX_FILE_BYTES = 25 * 1024 * 1024;
export type ForumCopyMessage = {
  id: string; url: string; author: string; authorId: string; createdAt: Date;
  content: string; replyTo?: string;
  attachments: { url: string; name: string; size: number }[];
};

export function parseForumSource(value: string, guildId: string): string {
  if (/^\d{17,20}$/.test(value.trim())) return value.trim();
  const match = /^https:\/\/(?:(?:www|canary|ptb)\.)?discord\.com\/channels\/(\d{17,20})\/(\d{17,20})(?:\/\d{17,20})?\/?$/.exec(value.trim());
  if (!match || match[1] !== guildId) throw new Error("同じサーバーの投稿URLまたはスレッドIDを指定してください。");
  return match[2];
}

export function splitForumText(text: string, limit: number): string[] {
  if (limit < 2) throw new Error("メッセージの分割サイズが小さすぎます。");
  const parts: string[] = [];
  while (text.length > limit) {
    let end = limit;
    if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    parts.push(text.slice(0, end));
    text = text.slice(end);
  }
  if (text || !parts.length) parts.push(text);
  return parts;
}

function snapshot(message: Message): ForumCopyMessage {
  const richEmbeds = message.embeds.filter((embed) => embed.data.type === "rich").map((embed) => [
    embed.title, embed.description, ...embed.fields.map((field) => `${field.name}\n${field.value}`),
    embed.url, embed.image?.url, embed.thumbnail?.url,
  ].filter(Boolean).join("\n"));
  const stickers = [...message.stickers.values()].map((sticker) => `スタンプ: ${sticker.name}\n${sticker.url}`);
  return {
    id: message.id, url: message.url, author: message.member?.displayName ?? message.author.username,
    authorId: message.author.id, createdAt: new Date(message.createdTimestamp),
    content: [message.content, ...richEmbeds, ...stickers].filter(Boolean).join("\n\n"),
    replyTo: message.reference?.messageId,
    attachments: [...message.attachments.values()].map((file) => ({
      url: file.url, name: file.name, size: file.size,
    })),
  };
}

/** Fetch every page up to the explicit safety limit; never silently truncate. */
export async function readForumMessages(source: ThreadChannel, fileLimit: number): Promise<ForumCopyMessage[]> {
  const messages = new Map<string, Message>();
  let before: string | undefined;
  for (;;) {
    const page = await source.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!page.size) break;
    for (const message of page.values()) if (!message.system) messages.set(message.id, message);
    if (messages.size > FORUM_COPY_MAX_MESSAGES) {
      throw new Error(`コピーできるのは${FORUM_COPY_MAX_MESSAGES}メッセージまでです。元投稿は変更していません。`);
    }
    const oldest = [...page.keys()].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1)[0];
    if (oldest === before) throw new Error("履歴取得が進まないためコピーを中止しました。");
    before = oldest;
  }
  const result = [...messages.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1).map(snapshot);
  if (!result.length) throw new Error("コピーできるメッセージがありません。");
  const oversized = result.flatMap((message) => message.attachments).find((file) => file.size > fileLimit);
  if (oversized) throw new Error(`添付「${oversized.name}」がコピー上限（${Math.floor(fileLimit / 1024 / 1024)}MB）を超えています。投稿は作成していません。`);
  return result;
}

export async function downloadForumFile(file: ForumCopyMessage["attachments"][number], limit: number): Promise<Buffer> {
  const url = new URL(file.url);
  if (url.protocol !== "https:" || !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)) {
    throw new Error("Discord以外の添付URLはコピーできません。");
  }
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) throw new Error(`添付「${file.name}」の取得に失敗しました。`);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error(`添付「${file.name}」がサイズ上限を超えています。`);
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

export class ForumCopyFailure extends Error {
  constructor(public readonly threadUrl: string, public readonly copied: number, cause: unknown) {
    super(`コピー途中で停止しました（${copied}件完了）。コピー先: ${threadUrl}`, { cause });
  }
}

export async function copyForumMessages(options: {
  destination: ForumChannel; title: string; sourceUrl: string; messages: ForumCopyMessage[];
  tags: string[]; actorId: string; fileLimit: number;
  onCreated: (url: string) => Promise<void>;
  download?: typeof downloadForumFile;
}): Promise<{ url: string; copied: number }> {
  const { destination, messages, sourceUrl } = options;
  if (messages.some((message) => message.attachments.some((file) => file.size > options.fileLimit))) {
    throw new Error("添付サイズ上限が変更されています。投稿は作成していません。");
  }
  const mentions = { parse: [] as [] };
  const base = `コピー元: ${sourceUrl}\n実行者ID: ${options.actorId}\n元投稿は削除・ロックしていません。投稿者名・日時は元の記録です。`;
  const thread = await destination.threads.create({
    name: options.title, appliedTags: options.tags,
    message: { content: `${base}\nコピー中: 0/${messages.length}件`, allowedMentions: mentions },
    reason: "管理者の確認によるフォーラム投稿コピー",
  });
  let copied = 0;
  let status: Message | null = null;
  const references = new Map<string, string>();
  try {
    status = await thread.fetchStarterMessage();
    if (!status) throw new Error("コピー先の進捗メッセージを取得できません。");
    await options.onCreated(thread.url);
    for (const message of messages) {
      const date = message.createdAt.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false });
      const header = `**${escapeMarkdown(message.author).slice(0, 100)}**（ID: ${message.authorId}）｜${date} JST\n元メッセージ: ${message.url}\n`;
      const chunks = splitForumText(message.content || "（本文なし）", 2_000 - header.length);
      let firstId: string | undefined;
      // Upload one file per message to bound memory and per-request upload size.
      for (let index = 0; index < Math.max(chunks.length, message.attachments.length); index++) {
        const file = message.attachments[index];
        const buffer = file ? await (options.download ?? downloadForumFile)(file, options.fileLimit) : undefined;
        const reference = index === 0 && message.replyTo ? references.get(message.replyTo) : undefined;
        const sent = await thread.send({
          content: `${header}${chunks[index] ?? "（添付ファイルの続き）"}`,
          ...(file && buffer ? { files: [new AttachmentBuilder(buffer, { name: file.name })] } : {}),
          ...(reference ? { reply: { messageReference: reference, failIfNotExists: false } } : {}),
          allowedMentions: { parse: [], repliedUser: false },
        });
        firstId ??= sent.id;
      }
      if (firstId) references.set(message.id, firstId);
      copied++;
      if (copied % 10 === 0) await status.edit({ content: `${base}\nコピー中: ${copied}/${messages.length}件`, allowedMentions: mentions });
    }
    await status.edit({ content: `${base}\nコピー完了: ${copied}件`, allowedMentions: mentions });
    return { url: thread.url, copied };
  } catch (error) {
    if (status) await status.edit({
      content: `${base}\nコピー停止: ${copied}/${messages.length}件。途中の投稿は残しています。管理者が内容を確認してください。`,
      allowedMentions: mentions,
    }).catch(() => {});
    throw new ForumCopyFailure(thread.url, copied, error);
  }
}
