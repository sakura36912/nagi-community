import { type Client, type GuildMember, type User, EmbedBuilder } from "discord.js";
import {
  getEvalSheetSettings,
  getLatestEvalSheet,
  getSheetVcSeconds,
} from "./economy";
import { logger } from "./logger";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** 評価シートのフォーラムスレッド名を生成する（最大100文字） */
export function buildSheetThreadName(displayName: string, endDate: Date): string {
  const d = new Date(endDate.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const mm = d.getMonth() + 1;
  const dd = d.getDate();
  return `${displayName} — 評価シート（〜${mm}/${dd}）`.slice(0, 100);
}

function formatSeconds(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return [h > 0 ? `${h}時間` : "", m > 0 ? `${m}分` : "", s > 0 ? `${s}秒` : ""]
    .filter(Boolean)
    .join("") || "0秒";
}

export function buildSheetEmbed(opts: {
  targetUser: User;
  member?: GuildMember | null;
  displayName: string;
  startDate: Date;
  endDate: Date;
  vcSeconds: number;
  selfIntro: string | null | undefined;
  createdByLabel: string;
  /** サーバーアイコンURL */
  guildIconUrl?: string | null;
}): EmbedBuilder {
  const { targetUser, member, displayName, startDate, endDate, vcSeconds, selfIntro, createdByLabel, guildIconUrl } = opts;
  const startTs = Math.floor(startDate.getTime() / 1000);
  const endTs = Math.floor(endDate.getTime() / 1000);

  const embed = new EmbedBuilder()
    .setTitle(`📋 評価シート — ${displayName}`)
    .setColor(0x2ecc71)
    .setThumbnail(member?.displayAvatarURL() ?? targetUser.displayAvatarURL())
    .addFields(
      { name: "👤 メンバー", value: `${displayName}（<@${targetUser.id}>）`, inline: false },
    );

  if (selfIntro) {
    embed.addFields({ name: "📝 自己紹介", value: selfIntro.slice(0, 1024), inline: false });
  }

  embed
    .addFields(
      { name: "📅 評価開始", value: `<t:${startTs}:D>`, inline: true },
      { name: "⏰ 評価終了", value: `<t:${endTs}:D>`, inline: true },
      { name: "🎙️ 期間中のVC滞在時間", value: formatSeconds(vcSeconds), inline: false },
    )
    .setFooter({ text: createdByLabel })
    .setTimestamp();

  return embed;
}

/**
 * 指定カテゴリ内のテキストチャンネルから、ユーザーの最新メッセージを自己紹介として返す。
 */
export async function findSelfIntro(
  guild: import("discord.js").Guild,
  userId: string,
  rosterCategoryId: string | null | undefined,
): Promise<string | null> {
  if (!rosterCategoryId) return null;
  const candidates = [...guild.channels.cache.values()].filter(
    (c) => c.isTextBased() && "parentId" in c && c.parentId === rosterCategoryId,
  );
  for (const channel of candidates) {
    if (!channel.isTextBased()) continue;
    let before: string | undefined;
    for (let page = 0; page < 5; page++) {
      const messages = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
      if (!messages || messages.size === 0) break;
      const found = messages.find((m) => m.author.id === userId && m.content.trim().length > 0);
      if (found) return found.content;
      before = messages.last()?.id;
    }
  }
  return null;
}

/**
 * 評価期間延長券購入後、フォーラムスレッドの先頭 embed を新しい終了日で更新する。
 * Fire-and-forget で呼び出してください（await しない）。
 */
export async function applySheetEmbedUpdate(
  client: Client,
  guildId: string,
  info: {
    newEndDate: Date;
    channelId: string | null;
    messageId: string | null;
    startDate: Date;
    userId: string;
  },
): Promise<void> {
  const { channelId, messageId, startDate, newEndDate, userId } = info;
  if (!channelId || !messageId) return;

  logger.info(`[sheet] applySheetEmbedUpdate: userId=${userId} channelId=${channelId} messageId=${messageId}`);
  try {
    const thread = await client.channels.fetch(messageId);
    logger.info(`[sheet] thread fetched: ${thread?.id} isTextBased=${thread?.isTextBased()}`);
    if (!thread?.isTextBased()) return;

    if ("setName" in thread && typeof thread.setName === "function") {
      const targetUserForName = await client.users.fetch(userId).catch(() => null);
      if (targetUserForName) {
        let dn = targetUserForName.displayName;
        try {
          const guildObj = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId);
          const mem = await guildObj.members.fetch(userId).catch(() => null);
          if (mem) dn = mem.displayName;
        } catch { /* fallback */ }
        await (thread as import("discord.js").ThreadChannel)
          .setName(buildSheetThreadName(dn, newEndDate))
          .catch(() => {});
      }
    }

    const message = await thread.messages.fetch(messageId);
    logger.info(`[sheet] starter message fetched: ${message.id}`);
    const targetUser = await client.users.fetch(userId);

    let displayName = targetUser.displayName;
    let guild: import("discord.js").Guild | null = null;
    let member: GuildMember | null = null;
    try {
      guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId);
      member = await guild.members.fetch(userId);
      displayName = member.displayName;
    } catch { /* fallback */ }

    const settings = await getEvalSheetSettings(guildId);
    const [vcSeconds, selfIntro] = await Promise.all([
      getSheetVcSeconds(guildId, userId, startDate, newEndDate),
      guild ? findSelfIntro(guild, userId, settings?.rosterCategoryId) : Promise.resolve(null),
    ]);

    const embed = buildSheetEmbed({
      targetUser,
      member: member ?? null,
      displayName,
      startDate,
      endDate: newEndDate,
      vcSeconds,
      selfIntro,
      createdByLabel: "評価期間延長券により更新",
      guildIconUrl: guild?.iconURL() ?? null,
    });

    await message.edit({ embeds: [embed] });
    logger.info(`[sheet] ✅ embed updated for user=${userId}`);
  } catch (err) {
    logger.error(`[sheet] Failed to refresh embed for user=${userId}`, err);
  }
}

/**
 * ニックネーム変更後にフォーラムスレッドのタイトルと embed を新しい表示名に更新する。
 * Fire-and-forget で呼び出してください（await しない）。
 */
export async function refreshSheetEmbedForUser(
  client: Client,
  guildId: string,
  userId: string,
  newDisplayName: string,
): Promise<void> {
  try {
    const sheet = await getLatestEvalSheet(guildId, userId);
    if (!sheet?.messageId) return;

    const thread = await client.channels.fetch(sheet.messageId).catch(() => null);
    if (!thread?.isTextBased()) return;

    if ("setName" in thread && typeof thread.setName === "function") {
      await (thread as import("discord.js").ThreadChannel)
        .setName(buildSheetThreadName(newDisplayName, sheet.endDate))
        .catch(() => {});
    }

    const message = await thread.messages.fetch(sheet.messageId).catch(() => null);
    if (!message) return;

    const targetUser = await client.users.fetch(userId).catch(() => null);
    if (!targetUser) return;

    const settings = await getEvalSheetSettings(guildId);
    let guildForIcon: import("discord.js").Guild | null = null;
    try {
      guildForIcon = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId);
    } catch { /* fallback */ }
    const [vcSeconds, selfIntro] = await Promise.all([
      getSheetVcSeconds(guildId, userId, sheet.startDate, sheet.endDate),
      guildForIcon
        ? findSelfIntro(guildForIcon, userId, settings?.rosterCategoryId)
        : Promise.resolve(null),
    ]);

    let memberForEmbed: GuildMember | null = null;
    if (guildForIcon) {
      memberForEmbed = await guildForIcon.members.fetch(userId).catch(() => null);
    }
    const embed = buildSheetEmbed({
      targetUser,
      member: memberForEmbed,
      displayName: newDisplayName,
      startDate: sheet.startDate,
      endDate: sheet.endDate,
      vcSeconds,
      selfIntro,
      createdByLabel: "ニックネーム変更により更新",
      guildIconUrl: guildForIcon?.iconURL() ?? null,
    });

    await message.edit({ embeds: [embed] });
    logger.info(`[sheet] ✅ embed refreshed for user=${userId} newName=${newDisplayName}`);
  } catch (err) {
    logger.error(`[sheet] refreshSheetEmbedForUser failed for user=${userId}`, err);
  }
}
