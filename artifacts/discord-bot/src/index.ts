import { ChannelType, Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { EmbedBuilder } from "discord.js";
import {
  commands,
  handleNicknameModalSubmit,
  handleShopBuyButton,
  NICKNAME_MODAL_PREFIX,
  SHOP_BUY_PREFIX,
} from "./commands";
import { logger } from "./lib/logger";
import {
  distributeRoleRewards,
  getExpiredPrivateVcSessions,
  deletePrivateVcSession,
  getGuildSettings,
  getGuildWalletUserIds,
  isDueCalendarDay,
  markRewardDistributed,
  seedDefaultShopItems,
  seedDefaultVcShopItems,
  seedDefaultUraShopItems,
} from "./lib/economy";
import {
  EVAL_SHEET_DEFAULT_DURATION_MS,
  getEvalSheetConfig,
  hasEvalSheet,
  recordEvalSheet,
} from "./lib/evalsheet";

const token = process.env["DISCORD_BOT_TOKEN"];

if (!token) {
  throw new Error("DISCORD_BOT_TOKEN environment variable is required.");
}

const commandsByName = new Map(commands.map((c) => [c.data.name, c]));

const client = new Client({
  // NOTE: GuildMembers (privileged intent) is commented out until you enable
  // "Server Members Intent" in the Discord Developer Portal.
  // Bot → Privileged Gateway Intents → Server Members Intent → ON
  // After enabling it there, restore GatewayIntentBits.GuildMembers here.
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// Checks every minute whether any guild's reward interval has elapsed and
// distributes role-based rewards (salary) if so.
async function runRewardScheduler(): Promise<void> {
  const now = new Date();

  for (const guild of client.guilds.cache.values()) {
    try {
      const settings = await getGuildSettings(guild.id);

      // Calendar-day mode takes priority over interval mode.
      const due = settings.rewardDayOfMonth !== null && settings.rewardDayOfMonth !== undefined
        ? isDueCalendarDay(settings, now)
        : now.getTime() - (settings.lastRewardAt?.getTime() ?? 0) >= settings.rewardIntervalMinutes * 60 * 1000;

      if (!due) {
        continue;
      }

      // Build userId → roleIds map from wallet holders only.
      // We fetch each member individually via REST so no privileged
      // GuildMembers gateway intent is needed.
      const userIds = await getGuildWalletUserIds(guild.id);
      const memberRoles = new Map<string, string[]>();
      for (const userId of userIds) {
        try {
          const member = await guild.members.fetch(userId);
          if (member.user.bot) continue;
          memberRoles.set(userId, [...member.roles.cache.keys()]);
        } catch {
          // Member may have left the guild — skip silently.
        }
      }

      const { paidCount, totalPaid } = await distributeRoleRewards(
        guild.id,
        settings.currencyName,
        memberRoles,
      );

      await markRewardDistributed(guild.id, now);

      if (paidCount > 0) {
        logger.info(
          `[reward] ${guild.name}: distributed ${totalPaid}${settings.currencyName} to ${paidCount} member(s).`,
        );
      }
    } catch (err) {
      logger.error(`[reward] Error processing guild ${guild.id}`, err);
    }
  }
}

// Checks every minute for private VC sessions whose lease has expired,
// deletes the Discord channel, and removes the session record from the DB.
async function runVcExpiryScheduler(): Promise<void> {
  const now = new Date();
  const expired = await getExpiredPrivateVcSessions(now);

  for (const session of expired) {
    try {
      const guild = client.guilds.cache.get(session.guildId);
      if (guild) {
        const channel = guild.channels.cache.get(session.channelId)
          ?? await guild.channels.fetch(session.channelId).catch(() => null);
        if (channel) {
          await channel.delete("非公開VCの期限切れ");
          logger.info(`[vc-expiry] Deleted expired VC ${session.channelId} for user ${session.userId} in guild ${session.guildId}`);
        }
      }
    } catch (err) {
      logger.error(`[vc-expiry] Failed to delete channel ${session.channelId}`, err);
    }

    // Always remove the session record even if channel deletion failed
    // (channel may have already been manually deleted).
    await deletePrivateVcSession(session.id).catch((err) =>
      logger.error(`[vc-expiry] Failed to delete session ${session.id}`, err),
    );
  }
}

client.once(Events.ClientReady, (readyClient) => {
  logger.info(`Logged in as ${readyClient.user.tag}`);

  // Seed default shop items for all guilds already in the bot's cache.
  for (const guild of readyClient.guilds.cache.values()) {
    seedDefaultShopItems(guild.id).catch((err) =>
      logger.error(`[seed] Failed to seed default shop items for guild ${guild.id}`, err),
    );
    seedDefaultVcShopItems(guild.id).catch((err) =>
      logger.error(`[seed] Failed to seed VC shop items for guild ${guild.id}`, err),
    );
    seedDefaultUraShopItems(guild.id).catch((err) =>
      logger.error(`[seed] Failed to seed ura shop items for guild ${guild.id}`, err),
    );
  }

  // Tick every 60 s; actual payout only happens when an interval has elapsed.
  setInterval(() => {
    runRewardScheduler().catch((err) => logger.error("[reward] Scheduler error", err));
    runVcExpiryScheduler().catch((err) => logger.error("[vc-expiry] Scheduler error", err));
  }, 60 * 1000);
});

// Builds the evaluation sheet embed posted as the first message in the forum thread.
function buildEvalSheetEmbed(
  member: { id: string; displayName: string; displayAvatarURL: () => string },
  roleId: string,
  expiresAt: Date,
): EmbedBuilder {
  const now = Math.floor(Date.now() / 1000);
  const exp = Math.floor(expiresAt.getTime() / 1000);
  return new EmbedBuilder()
    .setTitle(`📋 評価シート — ${member.displayName}`)
    .setColor(0x2ecc71)
    .setThumbnail(member.displayAvatarURL())
    .addFields(
      { name: "👤 ユーザー", value: `<@${member.id}>`, inline: true },
      { name: "🏷️ 対象ロール", value: `<@&${roleId}>`, inline: true },
      { name: "📅 作成日", value: `<t:${now}:D>`, inline: true },
      { name: "⏰ 有効期限", value: `<t:${exp}:F>（<t:${exp}:R>）`, inline: false },
      { name: "\u200b", value: "─────────────────────", inline: false },
      { name: "⭐ 総合評価", value: "☆ ☆ ☆ ☆ ☆", inline: false },
      { name: "💬 コミュニケーション", value: "─", inline: true },
      { name: "🔥 積極性", value: "─", inline: true },
      { name: "🤝 チームワーク", value: "─", inline: true },
      { name: "🛠️ 専門スキル", value: "─", inline: true },
      { name: "✅ 責任感", value: "─", inline: true },
      { name: "📈 成長性", value: "─", inline: true },
      { name: "\u200b", value: "─────────────────────", inline: false },
      { name: "📝 総評", value: "（管理者が記入してください）", inline: false },
    )
    .setFooter({ text: "期間延長券を使うと期限を1週間延長できます。" });
}

// Fires when a member's roles change. Checks each newly added role against
// the eval sheet config and creates a forum thread if one is configured.
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  logger.info(`[evalsheet] GuildMemberUpdate fired: user=${newMember.id} guild=${newMember.guild.id} oldPartial=${oldMember.partial}`);

  // If oldMember is partial (not cached), we cannot diff roles reliably.
  // Fetch the full old member first so we get an accurate before-state.
  const resolvedOld = oldMember.partial
    ? await oldMember.fetch().catch(() => null)
    : oldMember;

  let addedRoleIds: string[];
  if (!resolvedOld) {
    // Couldn't fetch old state — check all current roles; hasEvalSheet prevents duplication.
    addedRoleIds = [...newMember.roles.cache.keys()];
    logger.info(`[evalsheet] Could not resolve old member, checking all ${addedRoleIds.length} current roles`);
  } else {
    addedRoleIds = [...newMember.roles.cache.keys()].filter(
      (id) => !resolvedOld.roles.cache.has(id),
    );
    logger.info(`[evalsheet] Newly added role IDs: [${addedRoleIds.join(", ")}]`);
  }

  if (addedRoleIds.length === 0) {
    logger.info("[evalsheet] No newly added roles — skipping");
    return;
  }

  for (const roleId of addedRoleIds) {
    try {
      const config = await getEvalSheetConfig(newMember.guild.id, roleId);
      if (!config) {
        logger.info(`[evalsheet] No config for role ${roleId} — skipping`);
        continue;
      }

      logger.info(`[evalsheet] Config found: role=${roleId} forum=${config.forumChannelId}`);

      const already = await hasEvalSheet(newMember.guild.id, newMember.id, roleId);
      if (already) {
        logger.info(`[evalsheet] ${newMember.id} already has a sheet for role ${roleId} — skipping`);
        continue;
      }

      const forumChannel = newMember.guild.channels.cache.get(config.forumChannelId)
        ?? await newMember.guild.channels.fetch(config.forumChannelId).catch(() => null);

      if (!forumChannel) {
        logger.error(`[evalsheet] Channel ${config.forumChannelId} not found`);
        continue;
      }
      if (forumChannel.type !== ChannelType.GuildForum) {
        logger.error(`[evalsheet] Channel ${config.forumChannelId} is type ${forumChannel.type}, expected GuildForum (${ChannelType.GuildForum})`);
        continue;
      }

      const expiresAt = new Date(Date.now() + EVAL_SHEET_DEFAULT_DURATION_MS);
      const embed = buildEvalSheetEmbed(newMember, roleId, expiresAt);
      const threadName = `${newMember.displayName} の評価シート`.slice(0, 100);

      logger.info(`[evalsheet] Creating thread "${threadName}" in forum ${config.forumChannelId}`);

      const thread = await forumChannel.threads.create({
        name: threadName,
        message: { embeds: [embed] },
      });

      await recordEvalSheet(newMember.guild.id, newMember.id, roleId, thread.id, expiresAt);
      logger.info(`[evalsheet] ✅ Created thread ${thread.id} for ${newMember.id} (role ${roleId}), expires ${expiresAt.toISOString()}`);
    } catch (err) {
      logger.error(`[evalsheet] Error creating eval sheet for member ${newMember.id}, role ${roleId}`, err);
    }
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = commandsByName.get(interaction.commandName);
      if (!command) {
        logger.warn(`Unknown command: ${interaction.commandName}`);
        return;
      }
      await command.execute(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith(SHOP_BUY_PREFIX)) {
      await handleShopBuyButton(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith(NICKNAME_MODAL_PREFIX)) {
      await handleNicknameModalSubmit(interaction);
      return;
    }
  } catch (err) {
    logger.error("Error handling interaction", err);
    const errorMessage =
      err instanceof Error ? err.message : "処理中にエラーが発生しました。";

    if (interaction.isRepliable()) {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: errorMessage, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: errorMessage, flags: MessageFlags.Ephemeral });
      }
    }
  }
});

client.login(token).catch((err) => {
  logger.error("Failed to log in to Discord", err);
  process.exit(1);
});
