import { ChannelType, type Guild } from "discord.js";
import { logger } from "./logger";

type Intro = { content: string; url: string; createdTimestamp: number };

/**
 * Optional guild -> exact role name -> channel IDs mapping.
 * A matched role replaces category-wide searching so unrelated chat is never copied.
 */
export async function findConfiguredRoleSelfIntro(
  guild: Guild, userId: string,
): Promise<{ configured: false } | { configured: true; intro: { content: string; url: string } | null }> {
  const raw = process.env.EVAL_SHEET_INTRO_CHANNELS_BY_ROLE;
  if (!raw) return { configured: false };
  let roleSources: Record<string, unknown>;
  try {
    const mapping: unknown = JSON.parse(raw);
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) throw new Error("Invalid source mapping");
    const entry = (mapping as Record<string, unknown>)[guild.id];
    if (entry === undefined) return { configured: false };
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid guild source mapping");
    roleSources = entry as Record<string, unknown>;
    for (const ids of Object.values(roleSources)) {
      if (!Array.isArray(ids) || !ids.length || ids.length > 10
        || !ids.every(id => typeof id === "string" && /^\d{17,20}$/.test(id))) {
        throw new Error("Invalid source channel IDs");
      }
    }
  } catch (error) {
    logger.error("[sheet-intro] Invalid EVAL_SHEET_INTRO_CHANNELS_BY_ROLE configuration", error);
    throw new Error("自己紹介の検索先設定が不正です。");
  }
  // A removed role must not continue selecting restricted introduction sources.
  const member = await guild.members.fetch({ user: userId, force: true }).catch(error => {
    logger.error("[sheet-intro] Could not verify source role membership", error);
    throw new Error("自己紹介の検索対象ロールを確認できません。");
  });
  const matched = Object.entries(roleSources).filter(([name]) => member.roles.cache.some(role => role.name === name));
  if (!matched.length) return { configured: false };
  const ids = [...new Set(matched.flatMap(([, ids]) => ids as string[]))];
  let latest: Intro | null = null;
  for (const id of ids) {
    try {
      const channel = await guild.channels.fetch(id);
      if (!channel || channel.guildId !== guild.id
        || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
        logger.warn(`[sheet-intro] Invalid introduction source guild=${guild.id} channel=${id}`);
        continue;
      }
      let before: string | undefined;
      // Same bounded history search as the existing category-based introductions.
      for (let page = 0; page < 5; page++) {
        const messages = await channel.messages.fetch({ limit: 100, before });
        if (!messages.size) break;
        const found = messages.find(message => message.author.id === userId && message.content.trim().length > 0);
        if (found) {
          if (!latest || found.createdTimestamp > latest.createdTimestamp) {
            latest = { content: found.content, url: found.url, createdTimestamp: found.createdTimestamp };
          }
          break;
        }
        before = messages.last()?.id;
        if (!before) break;
      }
    } catch (error) {
      logger.warn(`[sheet-intro] Could not read introduction source guild=${guild.id} channel=${id}`, error);
    }
  }
  return { configured: true, intro: latest ? { content: latest.content, url: latest.url } : null };
}
