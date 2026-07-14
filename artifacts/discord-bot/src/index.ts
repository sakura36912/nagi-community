import { ChannelType, Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { EmbedBuilder } from "discord.js";
import {
  commands,
  handleNicknameModalSubmit,
  handleShopBuyButton,
  NICKNAME_MODAL_PREFIX,
  SHOP_BUY_PREFIX,
  VC_RENAME_BUTTON_PREFIX,
  durationFromKey,
  consumePendingRename,
} from "./commands";
import { saveSchedule, getExpiredSchedules, deleteSchedule } from "./lib/vc";
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

import { appendFileSync } from "fs";
const DEBUG_LOG = "/tmp/bot-debug.log";
function dlog(msg: string) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try { appendFileSync(DEBUG_LOG, line); } catch (e) {
    process.stderr.write(`dlog failed: ${e}\n`);
  }
}

dlog("=== bot starting ===");

const token = process.env["DISCORD_BOT_TOKEN"];
dlog(`token present: ${!!token}`);

if (!token) {
  dlog("ERROR: no token");
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

// Checks every 60 s for VC rename schedules whose lease has expired,
// deletes the Discord channel, and removes the schedule record from the DB.
// Bot requires ManageChannels permission to delete channels.
async function runVcDeleteScheduler(): Promise<void> {
  const now = new Date();
  const expired = await getExpiredSchedules(now);

  for (const schedule of expired) {
    try {
      const guild = client.guilds.cache.get(schedule.guildId);
      if (!guild) {
        // Bot is no longer in this guild — safe to clean up the record.
        await deleteSchedule(schedule.channelId).catch((err) =>
          logger.error(`[vc-schedule] Failed to remove orphaned schedule ${schedule.channelId}`, err),
        );
        continue;
      }

      // Try to fetch the channel; null means it was already deleted manually.
      const channel = guild.channels.cache.get(schedule.channelId)
        ?? await guild.channels.fetch(schedule.channelId).catch(() => null);

      if (!channel) {
        // Channel is already gone — clean up the stale record.
        logger.info(`[vc-schedule] Channel ${schedule.channelId} already absent; removing schedule`);
        await deleteSchedule(schedule.channelId).catch((err) =>
          logger.error(`[vc-schedule] Failed to delete stale schedule ${schedule.channelId}`, err),
        );
        continue;
      }

      // Attempt deletion. Only remove the DB record on success so that
      // transient or permission errors don't silently drop the schedule.
      await channel.delete("VCスケジュールの期限切れ");
      logger.info(`[vc-schedule] Deleted expired VC ${schedule.channelId} ("${schedule.channelName}") in guild ${schedule.guildId}`);
      await deleteSchedule(schedule.channelId).catch((err) =>
        logger.error(`[vc-schedule] Channel deleted but failed to remove schedule ${schedule.channelId}`, err),
      );
    } catch (err) {
      // channel.delete() threw — log and retain the DB record so the next
      // tick can retry (e.g., transient error) or an admin can investigate.
      logger.error(`[vc-schedule] Failed to delete channel ${schedule.channelId}; schedule retained for retry`, err);
    }
  }
}

client.once(Events.ClientReady, (readyClient) => {
  dlog(`Logged in as ${readyClient.user.tag}`);
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
    runVcDeleteScheduler().catch((err) => logger.error("[vc-schedule] Scheduler error", err));
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

    if (interaction.isButton() && interaction.customId.startsWith(VC_RENAME_BUTTON_PREFIX)) {
      // customId format: vc:rename:<durationKey>:<token>
      const payload = interaction.customId.slice(VC_RENAME_BUTTON_PREFIX.length);
      const colonIdx = payload.indexOf(":");
      const durationKey = payload.slice(0, colonIdx);
      const token = payload.slice(colonIdx + 1);

      const duration = durationFromKey(durationKey);
      const pending = token ? consumePendingRename(token) : undefined;

      if (!duration || !pending) {
        await interaction.reply({
          content: "このボタンは有効期限切れか不正です。もう一度 `/vc rename` を実行してください。",
          ephemeral: true,
        });
        return;
      }

      const { channelId, newName } = pending;

      if (!interaction.guildId) {
        await interaction.reply({ content: "このボタンはサーバー内でのみ使用できます。", ephemeral: true });
        return;
      }

      // Re-validate caller permissions at execution time (defence-in-depth).
      const memberPerms = interaction.memberPermissions;
      if (!memberPerms?.has("ManageChannels")) {
        await interaction.reply({
          content: "VCをリネームするには ManageChannels 権限が必要です。",
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      const guild = interaction.guild;
      if (!guild) {
        await interaction.editReply("サーバー情報を取得できませんでした。");
        return;
      }

      const channel = guild.channels.cache.get(channelId)
        ?? await guild.channels.fetch(channelId).catch(() => null);

      if (!channel) {
        await interaction.editReply("チャンネルが見つかりませんでした。");
        return;
      }

      // Rename the VC
      await channel.setName(newName);

      const expiresAt = new Date(Date.now() + duration.ms);
      await saveSchedule(interaction.guildId, channelId, newName, expiresAt);

      const ts = Math.floor(expiresAt.getTime() / 1000);
      logger.info(`[vc] Renamed channel ${channelId} to "${newName}", expires at ${expiresAt.toISOString()}`);

      await interaction.editReply(
        `<#${channelId}> を **${newName}** にリネームしました。\n削除予定: <t:${ts}:F>（<t:${ts}:R>）`,
      );
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

dlog("calling client.login()");
client.login(token).catch((err) => {
  dlog(`login failed: ${err}`);
  logger.error("Failed to log in to Discord", err);
  process.exit(1);
});
