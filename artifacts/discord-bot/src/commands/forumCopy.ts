import {
  ActionRowBuilder, ApplicationCommandType, ButtonBuilder, ButtonStyle, ChannelType,
  PermissionFlagsBits, SlashCommandBuilder, escapeMarkdown,
  type ButtonInteraction, type ChatInputCommandInteraction, type Client, type ForumChannel,
  type Guild, type ThreadChannel,
} from "discord.js";
import { randomUUID } from "node:crypto";
import {
  copyForumMessages, ForumCopyFailure, FORUM_COPY_MAX_FILE_BYTES,
  parseForumSource, readForumMessages, type ForumCopyMessage,
} from "../lib/forumCopy";
import { logger } from "../lib/logger";

export const FORUM_COPY_PREFIX = "forum-copy:";
type Preview = {
  guildId: string; actorId: string; sourceId: string; targetId: string; title: string;
  tags: string[]; messages: ForumCopyMessage[]; fileLimit: number; expiresAt: number;
};
const pending = new Map<string, Preview>();
const running = new Set<string>();
const previewTtl = 5 * 60_000;
const noMentions = { parse: [] as [] };

async function resolveChannels(guild: Guild, sourceId: string, targetId: string): Promise<{
  source: ThreadChannel; target: ForumChannel;
}> {
  const [source, target] = await Promise.all([
    guild.channels.fetch(sourceId, { force: true }), guild.channels.fetch(targetId, { force: true }),
  ]);
  if (!source || source.type !== ChannelType.PublicThread || source.guild.id !== guild.id || !source.parentId) {
    throw new Error("コピー元は同じサーバー内のフォーラム投稿を指定してください。");
  }
  const parent = await guild.channels.fetch(source.parentId);
  if (parent?.type !== ChannelType.GuildForum) throw new Error("コピー元はフォーラム投稿ではありません。");
  if (!target || target.type !== ChannelType.GuildForum || target.guild.id !== guild.id || target.id === parent.id) {
    throw new Error("コピー先は同じサーバー内の別のフォーラムを指定してください。");
  }
  const bot = guild.members.me ?? await guild.members.fetchMe();
  if (!source.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
    throw new Error("Botにコピー元の閲覧・メッセージ履歴閲覧権限が必要です。");
  }
  if (!target.permissionsFor(bot)?.has([
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendMessagesInThreads,
  ])) throw new Error("Botにコピー先の閲覧・投稿作成・スレッド内送信権限が必要です。");
  return { source, target };
}

export function resolveForumCopyTags(target: ForumChannel, source: ThreadChannel, input?: string | null): string[] {
  const tags = input?.trim()
    ? target.availableTags.filter((tag) => tag.id === input.trim() || tag.name === input.trim()).map((tag) => tag.id)
    : target.availableTags.filter((tag) => source.parent?.type === ChannelType.GuildForum
      && source.parent.availableTags.some((old) => source.appliedTags.includes(old.id) && old.name === tag.name)).slice(0, 5).map((tag) => tag.id);
  if (input?.trim() && tags.length !== 1) throw new Error("コピー先のタグ名またはタグIDを1つ指定してください。");
  // Discord's REQUIRE_TAG channel flag.
  if (target.flags.has(1 << 4) && !tags.length) {
    throw new Error(`コピー先はタグが必須です。tag に次のタグ名を指定してください: ${target.availableTags.map((tag) => tag.name).join("、")}`);
  }
  return tags;
}

export const forumCopyCommand = {
  data: new SlashCommandBuilder()
    .setName("forum-copy")
    .setDescription("フォーラム投稿を別フォーラムへコピー（元投稿は維持・最大1000件）")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((option) => option.setName("source").setDescription("コピー元の投稿URLまたはスレッドID").setRequired(true))
    .addChannelOption((option) => option.setName("target").setDescription("コピー先のフォーラム").addChannelTypes(ChannelType.GuildForum).setRequired(true))
    .addStringOption((option) => option.setName("tag").setDescription("コピー先のタグ名またはタグID（必要な場合）")),
  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: "サーバー管理者のみ実行できます。", ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      const sourceId = parseForumSource(interaction.options.getString("source", true), interaction.guild.id);
      const targetId = interaction.options.getChannel("target", true).id;
      const { source, target } = await resolveChannels(interaction.guild, sourceId, targetId);
      const tags = resolveForumCopyTags(target, source, interaction.options.getString("tag"));
      const fileLimit = Math.min(interaction.attachmentSizeLimit, FORUM_COPY_MAX_FILE_BYTES);
      const messages = await readForumMessages(source, fileLimit);
      for (const [key, value] of pending) if (value.expiresAt <= Date.now()) pending.delete(key);
      const token = randomUUID();
      pending.set(token, {
        guildId: interaction.guild.id, actorId: interaction.user.id, sourceId, targetId,
        title: source.name, tags, messages, fileLimit, expiresAt: Date.now() + previewTtl,
      });
      const timer = setTimeout(() => pending.delete(token), previewTtl);
      timer.unref();
      await interaction.editReply({
        content: `**コピー前の確認（5分以内）**\n投稿: ${escapeMarkdown(source.name)}\nコピー元: ${source.url}\nコピー先: <#${target.id}>\nメッセージ: ${messages.length}件／添付: ${messages.reduce((n, message) => n + message.attachments.length, 0)}件\n\n元投稿は削除・ロックしません。確認画面作成時点の本文・返信・添付をBot名義で投稿者名・元日時付きでコピーします。ID・リアクション・投票・ボタンは引き継ぎません。\n**コピー先の閲覧者に内容が公開されます。公開範囲を確認して実行してください。**`,
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`${FORUM_COPY_PREFIX}confirm:${token}`).setLabel("確認してコピー").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`${FORUM_COPY_PREFIX}cancel:${token}`).setLabel("キャンセル").setStyle(ButtonStyle.Secondary),
        )],
        allowedMentions: noMentions,
      });
    } catch (error) {
      logger.warn("[forum-copy] Preview failed", error);
      await interaction.editReply({ content: error instanceof Error ? error.message : "コピーの確認に失敗しました。", components: [], allowedMentions: noMentions });
    }
  },
};

export async function handleForumCopyButton(interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith(FORUM_COPY_PREFIX)) return false;
  const [, action, token] = interaction.customId.split(":");
  const job = pending.get(token);
  if (!job || job.expiresAt <= Date.now() || !["confirm", "cancel"].includes(action)) {
    await interaction.reply({ content: "確認期限が切れたか、Botが再起動しました。コマンドからやり直してください。", ephemeral: true });
    return true;
  }
  if (!interaction.guild || interaction.guildId !== job.guildId || interaction.user.id !== job.actorId
    || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "確認を開始した管理者本人のみ操作できます。", ephemeral: true });
    return true;
  }
  pending.delete(token);
  await interaction.deferUpdate();
  if (action === "cancel") {
    await interaction.editReply({ content: "キャンセルしました。投稿は変更していません。", components: [] });
    return true;
  }
  const lockKey = `${job.guildId}:${job.sourceId}:${job.targetId}`;
  if (running.has(lockKey)) {
    await interaction.editReply({ content: "同じ投稿のコピーを実行中です。完了を待ってください。", components: [] });
    return true;
  }
  running.add(lockKey);
  try {
    const { source, target } = await resolveChannels(interaction.guild, job.sourceId, job.targetId);
    if (job.tags.some((id) => !target.availableTags.some((tag) => tag.id === id))) throw new Error("コピー先のタグが変更されています。確認からやり直してください。");
    if (target.flags.has(1 << 4) && !job.tags.length) throw new Error("コピー先のタグ設定が変わっています。確認からやり直してください。");
    const result = await copyForumMessages({
      destination: target, title: job.title, sourceUrl: source.url, messages: job.messages,
      tags: job.tags, actorId: job.actorId, fileLimit: Math.min(job.fileLimit, interaction.attachmentSizeLimit),
      onCreated: async (url) => {
        await interaction.editReply({ content: `コピー中です。進捗はコピー先で確認できます: ${url}\n元投稿は変更しません。`, components: [], allowedMentions: noMentions });
      },
    });
    logger.info(`[forum-copy] Completed guild=${job.guildId} actor=${job.actorId} source=${job.sourceId} target=${job.targetId} messages=${result.copied}`);
    await interaction.editReply({ content: `コピー完了: ${result.copied}件\n${result.url}\n元投稿は削除・ロックしていません。`, components: [], allowedMentions: noMentions })
      .catch((error) => logger.warn("[forum-copy] Completed but interaction reply expired; result is in destination", error));
  } catch (error) {
    logger.error("[forum-copy] Copy failed", error);
    const content = error instanceof ForumCopyFailure
      ? `${error.message}\n元投稿は変更していません。コピー先には途中までの内容が残っています。再実行前に内容を確認してください。`
      : `コピーを開始できませんでした: ${error instanceof Error ? error.message : "不明なエラー"}\n元投稿は変更していません。`;
    await interaction.editReply({ content, components: [], allowedMentions: noMentions })
      .catch((replyError) => logger.warn("[forum-copy] Failed to report copy failure", replyError));
  } finally {
    running.delete(lockKey);
  }
  return true;
}

export async function syncForumCopyCommandRegistration(client: Client): Promise<void> {
  if (!client.application) throw new Error("Discord application is unavailable");
  const manager = client.application.commands;
  const existing = (await manager.fetch({})).find((command) => command.name === forumCopyCommand.data.name
    && command.type === ApplicationCommandType.ChatInput);
  const saved = existing
    ? await manager.edit(existing.id, forumCopyCommand.data.toJSON())
    : await manager.create(forumCopyCommand.data.toJSON());
  const verified = await manager.fetch(saved.id, { force: true });
  if (!verified || verified.name !== "forum-copy") throw new Error("Forum-copy command verification failed");
  logger.info("[forum-copy] Global command synchronized");
}
