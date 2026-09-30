import { EmbedBuilder, type Guild, type TextChannel } from "discord.js";
import type { GuildSettings } from "@workspace/db";
import {
  distributeMonthlyRoleDebit,
  markMonthlyRoleDebitProcessed,
  type MonthlyRoleDebitRule,
} from "./economy";
import { logger } from "./logger";

/** Charge each member once for the sum of their configured monthly roles. */
export async function runMonthlyRoleDebitForGuild(
  guild: Guild,
  settings: GuildSettings,
  rules: MonthlyRoleDebitRule[],
  now: Date,
): Promise<void> {
  await guild.members.fetch();
  const memberRoles = new Map<string, string[]>();
  for (const member of guild.members.cache.values()) {
    if (!member.user.bot) memberRoles.set(member.id, [...member.roles.cache.keys()]);
  }

  const debit = await distributeMonthlyRoleDebit(guild.id, settings.currencyName, memberRoles, rules);
  const roleRemovalFailures: Array<{ userId: string; roleId: string }> = [];
  for (const charge of debit.insufficient) {
    const member = guild.members.cache.get(charge.userId)
      ?? await guild.members.fetch(charge.userId).catch(() => null);
    for (const rule of charge.rules) {
      if (!member) {
        roleRemovalFailures.push({ userId: charge.userId, roleId: rule.roleId });
        logger.warn(`[monthly-debit] Member ${charge.userId} missing in guild ${guild.id}; cannot remove ${rule.roleId}`);
        continue;
      }
      try {
        if (member.roles.cache.has(rule.roleId)) {
          await member.roles.remove(rule.roleId, "月額引き落としの合計残高不足");
        }
      } catch (err) {
        roleRemovalFailures.push({ userId: charge.userId, roleId: rule.roleId });
        logger.error(`[monthly-debit] Failed to remove role ${rule.roleId} from ${charge.userId} in guild ${guild.id}`, err);
      }
    }
  }

  // A charge can contain roles with different destinations. Notify every
  // configured destination once, with only its own relevant roles listed.
  const channels = new Set(debit.insufficient.flatMap((charge) =>
    charge.rules.map((rule) => rule.logChannelId).filter((id): id is string => Boolean(id))));
  if (debit.insufficient.some((charge) => charge.rules.some((rule) => !rule.logChannelId))) {
    logger.warn(`[monthly-debit] ${guild.name}: an unpaid role has no log channel configured`);
  }
  for (const channelId of channels) {
    const charges = debit.insufficient.filter((charge) =>
      charge.rules.some((rule) => rule.logChannelId === channelId));
    const channel = guild.channels.cache.get(channelId)
      ?? await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) {
      logger.warn(`[monthly-debit] Log channel ${channelId} unavailable in guild ${guild.id}`);
      continue;
    }
    const failed = charges.flatMap((charge) =>
      roleRemovalFailures.filter((entry) => entry.userId === charge.userId &&
        charge.rules.some((rule) => rule.roleId === entry.roleId && rule.logChannelId === channelId)));
    const summary = charges.map((charge) => {
      const localRules = charge.rules.filter((rule) => rule.logChannelId === channelId);
      const listedRoles = localRules.map((rule) => `<@&${rule.roleId}>`).join("、");
      const localAmount = localRules.reduce((sum, rule) => sum + rule.amount, 0);
      return `<@${charge.userId}>：この通知先の対象額 ${localAmount.toLocaleString()}${settings.currencyName}` +
        `（${listedRoles}）／全対象ロールの合計請求額 ${charge.amount.toLocaleString()}${settings.currencyName}`;
    }).join("\n");
    const embed = new EmbedBuilder()
      .setTitle("月額引き落とし：残高不足")
      .setColor(0xed4245)
      .setDescription(`**${guild.name}** の月額引き落としで残高不足が発生しました。`)
      .addFields(
        { name: "対象者と合計請求額", value: summary.slice(0, 1024) || "なし" },
        { name: "ロール剥奪失敗", value: failed.length
          ? failed.map(({ userId, roleId }) => `<@${userId}> / <@&${roleId}>`).join(", ").slice(0, 1024)
          : "なし" },
      )
      .setTimestamp();
    await (channel as TextChannel).send({ embeds: [embed], allowedMentions: { parse: [] } })
      .catch((err) => logger.error(`[monthly-debit] Failed to send log to ${channelId} in guild ${guild.id}`, err));
  }

  await markMonthlyRoleDebitProcessed(guild.id, now);
  const intendedRemovals = debit.insufficient.reduce((count, charge) => count + charge.rules.length, 0);
  logger.info(
    `[monthly-debit] ${guild.name}: charged ${debit.totalCharged}${settings.currencyName} ` +
    `to ${debit.chargedCount} member(s); insufficient balance: ${debit.insufficientCount}; ` +
    `roles removed: ${intendedRemovals - roleRemovalFailures.length}/${intendedRemovals}.`,
  );
}