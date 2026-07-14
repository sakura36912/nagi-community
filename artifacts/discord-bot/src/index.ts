import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
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

const token = process.env["DISCORD_BOT_TOKEN"];

if (!token) {
  throw new Error("DISCORD_BOT_TOKEN environment variable is required.");
}

const commandsByName = new Map(commands.map((c) => [c.data.name, c]));

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
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
