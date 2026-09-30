import { EmbedBuilder, type Guild, type TextChannel } from "discord.js";
import {
  clearPendingDailyRoleRemoval,
  listPendingDailyRoleRemovals,
  processDailyRoleDebit,
} from "./economy";
import { logger } from "./logger";

/** Retry unpaid-role revocations on later ticks even after the day's debit is complete. */
export async function retryPendingDailyRoleRemovals(guild: Guild): Promise<string[]> {
  const pending = await listPendingDailyRoleRemovals(guild.id);
  const failures: string[] = [];
  for (const { userId, roleId } of pending) {
    const member = guild.members.cache.get(userId)
      ?? await guild.members.fetch(userId).catch(() => null);
    if (!member) {
      failures.push(userId);
      logger.warn(`[daily-debit] Member ${userId} is missing in guild ${guild.id}; role removal will retry`);
      continue;
    }
    try {
      if (member.roles.cache.has(roleId)) {
        await member.roles.remove(roleId, "日額引き落としの残高不足");
      }
      await clearPendingDailyRoleRemoval(guild.id, userId, roleId);
    } catch (err) {
      failures.push(userId);
      logger.error(`[daily-debit] Failed to remove role ${roleId} from ${userId} in guild ${guild.id}; will retry`, err);
    }
  }
  return failures;
}

/** Discord-side effects happen after the atomic balance/ledger update commits. */
export async function runDailyRoleDebitForGuild(guild: Guild): Promise<void> {
  await guild.members.fetch();
  const memberRoles = new Map<string, string[]>();
  for (const member of guild.members.cache.values()) {
    if (!member.user.bot) memberRoles.set(member.id, [...member.roles.cache.keys()]);
  }
  const result = await processDailyRoleDebit(guild.id, memberRoles, new Date());
  const removalFailures = await retryPendingDailyRoleRemovals(guild);
  if (!result) return;
  const currentFailures = result.insufficientUserIds.filter((id) => removalFailures.includes(id));

  if (result.insufficientUserIds.length > 0) {
    const logChannel = result.logChannelId
      ? guild.channels.cache.get(result.logChannelId)
        ?? await guild.channels.fetch(result.logChannelId).catch(() => null)
      : null;
    if (!logChannel?.isTextBased()) {
      logger.warn(`[daily-debit] Insufficient balance in guild ${guild.id}, but the configured log channel is unavailable`);
    } else {
      const embed = new EmbedBuilder()
        .setTitle("日額引き落とし：残高不足")
        .setColor(0xed4245)
        .setDescription(`**${guild.name}** の日額引き落としで残高不足が発生しました。`)
        .addFields(
          { name: "対象ロール", value: `<@&${result.roleId}>`, inline: true },
          { name: "請求額", value: `${result.amount.toLocaleString()}${result.currencyName}`, inline: true },
          { name: "対象者", value: result.insufficientUserIds.map((id) => `<@${id}>`).join(", ").slice(0, 1024) },
          { name: "ロール剥奪", value: `${result.insufficientUserIds.length - currentFailures.length}/${result.insufficientUserIds.length}人`, inline: true },
          ...(currentFailures.length
            ? [{ name: "剥奪失敗（自動再試行）", value: currentFailures.map((id) => `<@${id}>`).join(", ").slice(0, 1024), inline: true }]
            : []),
        )
        .setTimestamp();
      await (logChannel as TextChannel).send({ embeds: [embed], allowedMentions: { parse: [] } })
        .catch((err) => logger.error(`[daily-debit] Failed to send insufficient-balance log in guild ${guild.id}`, err));
    }
  }
  logger.info(
    `[daily-debit] ${guild.name}: charged ${result.totalCharged}${result.currencyName} ` +
    `to ${result.chargedCount} member(s); insufficient balance: ${result.insufficientUserIds.length}; ` +
    `roles removed: ${result.insufficientUserIds.length - currentFailures.length}.`,
  );
}