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
import {
  EVAL_SHEET_DEFAULT_DURATION_MS,
  deleteEvalSheet,
  getEvalSheetConfig,
  hasEvalSheet,
  recordEvalSheet,
} from "./lib/evalsheet";

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

// Searches the guild for a channel whose name contains "名簿" and returns
// the URL of the first message posted by the given user (up to 500 messages back).
async function findNameboMessageUrl(guild: import("discord.js").Guild, userId: string): Promise<string | null> {
  const channel = guild.channels.cache.find(
    (c) => c.name.includes("名簿") && c.isTextBased(),
  );
  if (!channel || !channel.isTextBased()) return null;

  let before: string | undefined;
  for (let page = 0; page < 5; page++) {
    const messages = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
    if (!messages || messages.size === 0) break;
    const found = messages.find((m) => m.author.id === userId);
    if (found) return found.url;
    before = messages.last()?.id;
  }
  return null;
}

// Builds the evaluation sheet embed posted as the first message in the forum thread.
function buildEvalSheetEmbed(
  member: { id: string; displayName: string; displayAvatarURL: () => string },
  roleId: string,
  createdAt: Date,
  expiresAt: Date,
  nameboUrl: string | null,
): EmbedBuilder {
  const created = Math.floor(createdAt.getTime() / 1000);
  const exp = Math.floor(expiresAt.getTime() / 1000);
  const nameboValue = nameboUrl ? `[名簿を見る](${nameboUrl})` : "（名簿に投稿が見つかりませんでした）";

  return new EmbedBuilder()
    .setTitle(`📋 評価シート — ${member.displayName}`)
    .setColor(0x2ecc71)
    .setThumbnail(member.displayAvatarURL())
    .addFields(
      { name: "👤 名前", value: `${member.displayName}（<@${member.id}>）`, inline: false },
      { name: "🏷️ 対象ロール", value: `<@&${roleId}>`, inline: true },
      { name: "📋 名簿", value: nameboValue, inline: true },
      { name: "\u200b", value: "\u200b", inline: false },
      { name: "📅 評価開始", value: `<t:${created}:D>`, inline: true },
      { name: "⏰ 評価終了", value: `<t:${exp}:D>（<t:${exp}:R>）`, inline: true },
    )
    .setFooter({ text: "期間延長券を使うと期限を1週間延長できます。" });
}

// Fires when a member's roles change. Checks each newly added role against
// the eval sheet config and creates a forum thread if one is configured.
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  dlog(`GuildMemberUpdate fired: user=${newMember.id} guild=${newMember.guild.id} oldPartial=${oldMember.partial}`);
  logger.info(`[evalsheet] GuildMemberUpdate fired: user=${newMember.id} guild=${newMember.guild.id} oldPartial=${oldMember.partial}`);

  // oldMember.partial が true のときは fetch() してはいけない。
  // fetch() はロール付与後の最新状態を返すため差分が空になる。
  // partial のときは全現在ロールを対象にし、hasEvalSheet で重複防止する。
  let addedRoleIds: string[];
  let removedRoleIds: string[];
  if (oldMember.partial) {
    addedRoleIds = [...newMember.roles.cache.keys()];
    removedRoleIds = [];
    dlog(`oldMember partial — treating all ${addedRoleIds.length} current roles as added`);
  } else {
    addedRoleIds = [...newMember.roles.cache.keys()].filter(
      (id) => !oldMember.roles.cache.has(id),
    );
    removedRoleIds = [...oldMember.roles.cache.keys()].filter(
      (id) => !newMember.roles.cache.has(id),
    );
    dlog(`added=[${addedRoleIds.join(",")}] removed=[${removedRoleIds.join(",")}]`);
  }

  // ロールが外されたときは DB レコードを削除して再付与時に新規作成できるようにする。
  for (const roleId of removedRoleIds) {
    const config = await getEvalSheetConfig(newMember.guild.id, roleId);
    if (!config) continue;
    const deleted = await deleteEvalSheet(newMember.guild.id, newMember.id, roleId);
    dlog(`deleted eval sheet for user=${newMember.id} role=${roleId}: ${deleted}`);
  }

  if (addedRoleIds.length === 0) {
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

      const createdAt = new Date();
      const expiresAt = new Date(createdAt.getTime() + EVAL_SHEET_DEFAULT_DURATION_MS);
      const nameboUrl = await findNameboMessageUrl(newMember.guild, newMember.id);
      const embed = buildEvalSheetEmbed(newMember, roleId, createdAt, expiresAt, nameboUrl);
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
