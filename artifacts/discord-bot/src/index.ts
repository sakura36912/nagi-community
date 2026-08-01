import { AuditLogEvent, ChannelType, Client, DiscordAPIError, Events, GatewayIntentBits, MessageFlags, PermissionFlagsBits, VoiceState, TextChannel } from "discord.js";
import { handleRolePanelButton, ROLE_PANEL_PREFIX } from "./commands/rolepanel";
import { handleGuideSelect, GUIDE_SELECT_ID } from "./commands/guide";
import { EmbedBuilder } from "discord.js";
import {
  commands,
  handleNicknameModalSubmit,
  handleVcRenameModalSubmit,
  handleShopBuyButton,
  handleShopSelectMenu,
  SHOP_SELECT_ID,
  NICKNAME_MODAL_PREFIX,
  VC_RENAME_MODAL_PREFIX,
  SHOP_BUY_PREFIX,
  postWeeklyShifts,
  getNextWeeklyPostTime,
  SHIFT_TOGGLE_PREFIX,
  SHIFT_CONFIRM_PREFIX,
  SHIFT_CANCEL_PREFIX,
  SHIFT_TIME_PREFIX,
  SHIFT_PANEL_OPEN_PREFIX,
  SHIFT_LIST_NAV_PREFIX,
  handleShiftToggle,
  handleShiftConfirm,
  handleShiftCancel,
  handleShiftTime,
  handleShiftPanelOpen,
  handleShiftListNav,
} from "./commands";
import { handleHubJoin, handleHubLeave } from "./commands/vc";
import { getHubSession, getHubChannelById, db, walletsTable, transactionsTable } from "@workspace/db";
import { sql as drizzleSql } from "drizzle-orm";
import {
  getExpiredSchedules,
  getSchedulesExpiringSoon,
  deleteSchedule,
  markScheduleNotified,
} from "./lib/vc";
import { buildSheetEmbed, buildSheetThreadName, findSelfIntro } from "./lib/sheet";
import { getStickyMessage, updateStickyLastMessageId } from "./lib/sticky";
import { getShiftSettings, getShiftCountsByUser } from "./lib/shift";

import { logger } from "./lib/logger";
import {
  getVcRewardSettings,
  recordVcJoin,
  clearVcPresence,
  getAllVcPresences,
  payVcReward,
  getVcLogSettings,
  setVcLogNotifyChannel,
  recordVcLogJoin,
  recordVcLogLeave,
  getVcLogPresence,
  updateVcPresenceChannel,
} from "./lib/vcReward";
import {
  recordPointVcJoin,
  settlePointVcSession,
  awardBoostPoints,
  distributeRoleTenurePoints,
  listVcCategoryConfigs,
  type PointVcCategoryConfig,
} from "./lib/points";
import {
  distributeRoleRewards,
  getExpiredPrivateVcSessions,
  deletePrivateVcSession,
  getGuildSettings,
  getGuildWalletUserIds,
  giveCurrency,
  isDueCalendarDay,
  markRewardDistributed,
  seedDefaultShopItems,
  seedDefaultVcShopItems,
  getEvalSheetSettings,
  createEvalSheet,
  getSheetVcSeconds,
  listActiveSheets,
  claimInitialIssue,
  listSheetsNeedingReminder,
  markSheetReminderSent,
  setBanLogChannelId,
  setLeaveLogChannelId,
  recordMemberJoin,
  recordMemberLeave,
  countPastJoins,
  findWallet,
} from "./lib/economy";
import { getEvalSheetConfigsForRoles } from "@workspace/db";

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
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates, // required for voiceStateUpdate
    GatewayIntentBits.GuildMessages,         // required for messageCreate
    GatewayIntentBits.MessageContent,        // privileged — enable in Developer Portal
    GatewayIntentBits.GuildEmojisAndStickers, // required for emoji cache (slot setup)
    GatewayIntentBits.GuildModeration,        // required for guildBanAdd
  ],
});

// Checks every minute whether any guild's reward day has arrived and
// distributes role-based rewards (salary) if so.
async function runRewardScheduler(): Promise<void> {
  const now = new Date();

  for (const guild of client.guilds.cache.values()) {
    try {
      const settings = await getGuildSettings(guild.id);

      // Only calendar-day mode is supported.
      if (settings.rewardDayOfMonth === null || settings.rewardDayOfMonth === undefined) continue;
      const due = isDueCalendarDay(settings, now);

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

      // ── シフト出勤報酬 ───────────────────────────────────────────────────────
      const shiftSettings = await getShiftSettings(guild.id);
      const rewardPerShift = shiftSettings?.shiftRewardAmount ?? 0;
      let shiftPaidCount = 0;
      let shiftTotalPaid = 0;
      if (rewardPerShift > 0) {
        // 集計期間: 前回給料日の翌日 〜 今日 (JST "YYYY-MM-DD")
        const toDate   = now.toISOString().slice(0, 10);
        const fromDate = settings.lastRewardAt
          ? new Date(settings.lastRewardAt.getTime() + 24 * 60 * 60 * 1000)
              .toISOString()
              .slice(0, 10)
          : new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000)
              .toISOString()
              .slice(0, 10);

        const counts = await getShiftCountsByUser(guild.id, fromDate, toDate);
        for (const [userId, shiftCount] of counts) {
          const amount = shiftCount * rewardPerShift;
          const result = await giveCurrency(
            guild.id,
            userId,
            amount,
            settings.currencyName,
            "shift-reward",
          );
          if (result.ok) {
            shiftPaidCount += 1;
            shiftTotalPaid += amount;
          }
        }
        if (shiftPaidCount > 0) {
          logger.info(
            `[reward] ${guild.name}: shift bonus ${shiftTotalPaid}${settings.currencyName} to ${shiftPaidCount} member(s) (${rewardPerShift}/shift).`,
          );
        }
      }

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
    let missingPermissions = false;
    try {
      const guild = client.guilds.cache.get(session.guildId);
      if (guild) {
        // Delete the VC channel.
        const channel = guild.channels.cache.get(session.channelId)
          ?? await guild.channels.fetch(session.channelId).catch(() => null);
        if (channel) {
          await channel.delete("非公開VCの期限切れ");
          logger.info(`[vc-expiry] Deleted expired VC ${session.channelId} for user ${session.userId} in guild ${session.guildId}`);
        }

        // For ura sessions, revoke the access channel permission.
        if (session.category === "ura") {
          try {
            const settings = await getGuildSettings(session.guildId);
            if (settings.uraChannelId) {
              const accessCh = guild.channels.cache.get(settings.uraChannelId)
                ?? await guild.channels.fetch(settings.uraChannelId).catch(() => null);
              if (accessCh && "permissionOverwrites" in accessCh) {
                await accessCh.permissionOverwrites.delete(session.userId, "裏フリールームVC期限切れ");
                logger.info(`[vc-expiry] Revoked ura channel access for user ${session.userId}`);
              }
            }
          } catch (err) {
            logger.error(`[vc-expiry] Failed to revoke ura channel access for ${session.userId}`, err);
          }
        }
      }
    } catch (err) {
      // DiscordAPIError code 50013 = Missing Permissions.
      // Do NOT remove the DB row — the channel is still alive. Leave the
      // session record intact so the next scheduler tick retries automatically
      // once an admin restores the ManageChannels permission.
      if (err instanceof DiscordAPIError && err.code === 50013) {
        missingPermissions = true;
        logger.error(
          `[vc-expiry] Missing Permissions — cannot delete channel ${session.channelId} ` +
          `for user ${session.userId} in guild ${session.guildId}. ` +
          `Grant the bot ManageChannels permission and the channel will be removed on the next tick.`,
          err,
        );
      } else {
        logger.error(`[vc-expiry] Failed to delete channel ${session.channelId}`, err);
      }
    }

    // Skip DB cleanup when the channel is still alive but we lack permission —
    // leave the row so the session is retried on the next tick.
    if (missingPermissions) continue;

    // Remove the session record (channel was deleted or was already gone).
    await deletePrivateVcSession(session.id).catch((err) =>
      logger.error(`[vc-expiry] Failed to delete session ${session.id}`, err),
    );
  }
}


// ─── Eval-sheet VC-time periodic refresh ─────────────────────────────────────

let lastSheetVcRefresh = 0;
const SHEET_VC_REFRESH_INTERVAL_MS = 60 * 1000; // 1 minute

async function runSheetVcRefreshScheduler(bot: Client<true>): Promise<void> {
  const now = Date.now();
  if (now - lastSheetVcRefresh < SHEET_VC_REFRESH_INTERVAL_MS) return;
  lastSheetVcRefresh = now;

  const sheets = await listActiveSheets();
  if (sheets.length === 0) return;

  logger.info(`[sheet-vc] Refreshing VC time for ${sheets.length} active sheet(s)`);

  for (const sheet of sheets) {
    if (!sheet.messageId) continue;
    try {
      const thread = await bot.channels.fetch(sheet.messageId).catch(() => null);
      if (!thread?.isTextBased()) continue;
      const message = await thread.messages.fetch(sheet.messageId).catch(() => null);
      if (!message) continue;

      const targetUser = await bot.users.fetch(sheet.userId).catch(() => null);
      if (!targetUser) continue;

      let displayName = targetUser.displayName;
      let sheetGuild: import("discord.js").Guild | null = null;
      try {
        sheetGuild = bot.guilds.cache.get(sheet.guildId) ?? await bot.guilds.fetch(sheet.guildId);
        const mem = await sheetGuild.members.fetch(sheet.userId).catch(() => null);
        if (mem) displayName = mem.displayName;
      } catch { /* use user displayName */ }

      const settings = await getEvalSheetSettings(sheet.guildId);
      const [vcSeconds, selfIntro] = await Promise.all([
        getSheetVcSeconds(sheet.guildId, sheet.userId, sheet.startDate, sheet.endDate),
        sheetGuild
          ? findSelfIntro(sheetGuild, sheet.userId, settings?.rosterCategoryId)
          : Promise.resolve(null),
      ]);

      const embed = buildSheetEmbed({
        targetUser,
        displayName,
        startDate: sheet.startDate,
        endDate: sheet.endDate,
        vcSeconds,
        nameboardUrl: settings?.nameboardUrl,
        selfIntro,
        createdByLabel: "自動更新（定期集計）",
        guildIconUrl: sheetGuild?.iconURL() ?? null,
      });

      await message.edit({ embeds: [embed] });
      logger.info(`[sheet-vc] Updated sheet ${sheet.id} for user ${sheet.userId}: ${vcSeconds}s`);
    } catch (err) {
      logger.error(`[sheet-vc] Failed to refresh sheet ${sheet.id}`, err);
    }
  }
}


// ─── Eval-sheet end-of-period reminder ───────────────────────────────────────

async function runSheetReminderScheduler(bot: Client<true>): Promise<void> {
  const sheets = await listSheetsNeedingReminder();
  for (const sheet of sheets) {
    try {
      // messageId holds the forum thread ID (thread.id == starterMessage.id).
      if (!sheet.messageId) {
        await markSheetReminderSent(sheet.id);
        continue;
      }

      const thread = await bot.channels.fetch(sheet.messageId).catch(() => null);
      if (!thread?.isTextBased()) {
        await markSheetReminderSent(sheet.id);
        continue;
      }

      const endTs = Math.floor(sheet.endDate.getTime() / 1000);
      const embed = new EmbedBuilder()
        .setTitle("⏰ 評価期間が終了しました")
        .setColor(0xe74c3c)
        .setDescription(
          `<@${sheet.userId}> さんの評価期間（〜<t:${endTs}:D>）が終了しました。\n` +
          `評価を締めくくって結果を記録してください。`,
        )
        .setTimestamp();

      if (!("send" in thread) || typeof thread.send !== "function") {
        await markSheetReminderSent(sheet.id);
        continue;
      }
      await (thread as import("discord.js").TextChannel).send({ content: `<@${sheet.userId}>`, embeds: [embed] });
      logger.info(`[sheet-reminder] Sent reminder for sheet ${sheet.id} (user ${sheet.userId})`);
    } catch (err) {
      logger.error(`[sheet-reminder] Failed to send reminder for sheet ${sheet.id}`, err);
    }
    // Always mark as sent (even on error) to avoid retry-spamming.
    await markSheetReminderSent(sheet.id).catch((e) =>
      logger.error(`[sheet-reminder] Failed to mark sheet ${sheet.id} as reminded`, e),
    );
  }
}


// ─── VC rename-schedule: pre-expiry warning + deletion ───────────────────────

/**
 * Every tick:
 *  1. Find schedules within the notification window (10 min before expiry)
 *     that haven't been warned yet → DM the schedule owner.
 *  2. Find schedules that have already expired → delete the Discord channel
 *     and remove the DB row.
 */
async function runVcDeleteScheduler(): Promise<void> {
  const now = new Date();

  // ── Pre-expiry warning (per-guild, using each guild's configured warn time) ──
  for (const guild of client.guilds.cache.values()) {
    try {
      const guildSettings = await getGuildSettings(guild.id);
      const warnBeforeMs = guildSettings.vcWarnBeforeMinutes * 60 * 1000;
      const soon = await getSchedulesExpiringSoon(guild.id, now, warnBeforeMs);

      for (const schedule of soon) {
        try {
          if (schedule.userId) {
            const expiresTs = Math.floor(schedule.expiresAt.getTime() / 1000);
            const user = await client.users.fetch(schedule.userId).catch(() => null);
            if (user) {
              await user
                .send(
                  `⏰ VCチャンネル「**${schedule.channelName}**」は <t:${expiresTs}:R>（<t:${expiresTs}:T>）に自動削除されます。必要であれば会話を引き続き行ってください。`,
                )
                .then(() => {
                  logger.info(
                    `[vc-schedule] Sent expiry warning to ${schedule.userId} for channel ${schedule.channelId}`,
                  );
                })
                .catch(() => {
                  // DMs closed — ignore silently.
                });
            }
          }
        } catch (err) {
          logger.error(`[vc-schedule] Failed to send expiry warning for ${schedule.channelId}`, err);
        }
        // Always mark notified to prevent duplicate warnings, even if DM failed.
        await markScheduleNotified(schedule.id, now).catch((err) =>
          logger.error(`[vc-schedule] Failed to mark schedule ${schedule.id} as notified`, err),
        );
      }
    } catch (err) {
      logger.error(`[vc-schedule] Failed to process expiry warnings for guild ${guild.id}`, err);
    }
  }

  // ── Delete expired channels ───────────────────────────────────────────────
  const expired = await getExpiredSchedules(now);
  for (const schedule of expired) {
    let missingPermissions = false;
    try {
      const guild = client.guilds.cache.get(schedule.guildId);
      if (guild) {
        const channel =
          guild.channels.cache.get(schedule.channelId) ??
          (await guild.channels.fetch(schedule.channelId).catch(() => null));
        if (channel) {
          await channel.delete("スケジュールによる自動削除");
          logger.info(
            `[vc-schedule] Deleted scheduled VC ${schedule.channelId} (${schedule.channelName}) in guild ${schedule.guildId}`,
          );
        }
      }
    } catch (err) {
      // DiscordAPIError code 50013 = Missing Permissions.
      // In this case we must NOT remove the DB row so that /vc list still shows
      // the entry and an admin can notice the permission problem and act on it.
      if (err instanceof DiscordAPIError && err.code === 50013) {
        missingPermissions = true;
        logger.error(
          `[vc-schedule] Missing Permissions — cannot delete channel ${schedule.channelId} ` +
          `(${schedule.channelName}) in guild ${schedule.guildId}. ` +
          `Grant the bot ManageChannels permission and the channel will be removed on the next tick.`,
          err,
        );
      } else {
        logger.error(`[vc-schedule] Failed to delete channel ${schedule.channelId}`, err);
      }
    }

    // Skip DB cleanup when the channel is still alive but we lack permission —
    // leave the row so /vc list stays accurate and the admin can investigate.
    if (missingPermissions) continue;

    // Remove the DB row (channel was deleted or was already gone).
    await deleteSchedule(schedule.channelId).catch((err) =>
      logger.error(`[vc-schedule] Failed to remove schedule row for ${schedule.channelId}`, err),
    );
  }
}

client.once(Events.ClientReady, (readyClient) => {
  dlog(`Logged in as ${readyClient.user.tag}`);
  logger.info(`Logged in as ${readyClient.user.tag}`);

  // Clear stale vc_presence rows left over from a previous bot session.
  // We cannot recover exact join times after a restart, so we simply discard
  // them to prevent phantom payouts on the next leave event.
  getAllVcPresences()
    .then(async (rows) => {
      if (rows.length === 0) return;
      await Promise.all(rows.map((r) => clearVcPresence(r.guildId, r.userId)));
      logger.info(`[vcsalary] Cleared ${rows.length} stale presence record(s) on startup`);
    })
    .catch((err) => logger.error("[vcsalary] Failed to clear stale presences", err));

  // Seed default shop items for all guilds already in the bot's cache.
  for (const guild of readyClient.guilds.cache.values()) {
    seedDefaultShopItems(guild.id).catch((err) =>
      logger.error(`[seed] Failed to seed default shop items for guild ${guild.id}`, err),
    );
    seedDefaultVcShopItems(guild.id).catch((err) =>
      logger.error(`[seed] Failed to seed VC shop items for guild ${guild.id}`, err),
    );
  }

  // Tick every 60 s; actual payout only happens when an interval has elapsed.
  setInterval(() => {
    runRewardScheduler().catch((err) => logger.error("[reward] Scheduler error", err));
    runVcExpiryScheduler().catch((err) => logger.error("[vc-expiry] Scheduler error", err));
    runVcDeleteScheduler().catch((err) => logger.error("[vc-schedule] Scheduler error", err));
    runSheetReminderScheduler(readyClient).catch((err) => logger.error("[sheet-reminder] Scheduler error", err));
    runSheetVcRefreshScheduler(readyClient).catch((err) => logger.error("[sheet-vc] Scheduler error", err));
  }, 60 * 1000);

  // Daily role-tenure point distribution — run once every 24 h
  const ROLE_TENURE_INTERVAL_MS = 24 * 60 * 60 * 1000;
  setInterval(() => {
    for (const guild of readyClient.guilds.cache.values()) {
      distributeRoleTenurePoints(guild).catch((err) =>
        logger.error(`[points] role tenure error for guild ${guild.id}`, err),
      );
    }
  }, ROLE_TENURE_INTERVAL_MS);

  // ── Weekly shift post — every Monday 00:00 UTC (= 09:00 JST) ─────────────
  const nextWeeklyPost = getNextWeeklyPostTime();
  const shiftDelay = nextWeeklyPost.getTime() - Date.now();
  logger.info(
    `[shift] Next weekly post in ${Math.round(shiftDelay / 60000)} min (${nextWeeklyPost.toISOString()})`,
  );
  setTimeout(() => {
    postWeeklyShifts(readyClient).catch((err) =>
      logger.error("[shift] Weekly post error", err),
    );
    setInterval(() => {
      postWeeklyShifts(readyClient).catch((err) =>
        logger.error("[shift] Weekly post error", err),
      );
    }, 7 * 24 * 60 * 60 * 1000);
  }, shiftDelay);
});


// ─── VC 入退室通知 ────────────────────────────────────────────────────────────

/** メンバーの表示名を取得。キャッシュになければユーザーIDをフォールバックとして使用 */
function getMemberDisplayName(guild: VoiceState["guild"], userId: string): string {
  return guild.members.cache.get(userId)?.displayName ?? `ユーザー(${userId})`;
}

/** チャンネル名を取得。キャッシュになければチャンネルIDをフォールバックとして使用 */
function getVcChannelName(guild: VoiceState["guild"], channelId: string): string {
  return guild.channels.cache.get(channelId)?.name ?? `チャンネル(${channelId})`;
}

/** 秒数を「X時間Y分Z秒」形式に変換 */
function formatDuration(totalSecs: number): string {
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (h > 0) return `${h}時間${m}分${s}秒`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

async function sendVcNotifyJoin(guild: VoiceState["guild"], userId: string, channelId: string, notifyChannelId: string): Promise<void> {
  try {
    const ch = guild.channels.cache.get(notifyChannelId);
    if (!ch || !("send" in ch)) return;
    const member      = guild.members.cache.get(userId);
    const memberName  = member?.displayName ?? `ユーザー(${userId})`;
    const avatarUrl   = member?.displayAvatarURL() ?? undefined;
    const channelName = getVcChannelName(guild, channelId);
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setAuthor({ name: memberName, iconURL: avatarUrl })
      .setDescription(`🔊 **${channelName}** に参加しました`)
      .setTimestamp();
    if (avatarUrl) embed.setThumbnail(avatarUrl);
    await (ch as TextChannel).send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch {
    // 通知失敗は無視
  }
}

async function sendVcNotifyLeave(guild: VoiceState["guild"], userId: string, channelId: string, notifyChannelId: string, joinedAt?: Date): Promise<void> {
  try {
    const ch = guild.channels.cache.get(notifyChannelId);
    if (!ch || !("send" in ch)) return;
    const member      = guild.members.cache.get(userId);
    const memberName  = member?.displayName ?? `ユーザー(${userId})`;
    const avatarUrl   = member?.displayAvatarURL() ?? undefined;
    const channelName = getVcChannelName(guild, channelId);
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setAuthor({ name: memberName, iconURL: avatarUrl })
      .setDescription(`🔇 **${channelName}** から退出しました`)
      .setTimestamp();
    if (avatarUrl) embed.setThumbnail(avatarUrl);
    if (joinedAt) {
      const secs = Math.floor((Date.now() - joinedAt.getTime()) / 1000);
      embed.addFields({ name: "⏱ 滞在時間", value: formatDuration(secs), inline: true });
    }
    await (ch as TextChannel).send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch {
    // 通知失敗は無視
  }
}

// ─── VC-time reward handler ───────────────────────────────────────────────────

/**
 * Returns true if the given channelId is in an eligible category.
 * When includedCategoryIds is empty, all categories are eligible.
 */
function isEligibleChannel(
  channelId: string,
  includedCategoryIds: string[],
  guild: VoiceState["guild"],
): boolean {
  if (includedCategoryIds.length === 0) return true;
  const channel = guild.channels.cache.get(channelId);
  if (!channel || !channel.parentId) return false;
  return includedCategoryIds.includes(channel.parentId);
}

/**
 * Credit a user's wallet for a completed VC session and notify them via DM.
 * Silently no-ops when the reward comes out to 0 (below minMinutes, rate=0).
 */
/** Hub チャンネルIDが hub-salary VC なら { ratePerHour, minMinutes } を返す。それ以外は null。 */
async function getHubSalaryForChannel(
  channelId: string,
): Promise<{ ratePerHour: number; minMinutes: number } | null> {
  try {
    const session = await getHubSession(channelId);
    if (!session) return null;
    const hub = await getHubChannelById(session.hubId);
    if (!hub?.salaryRatePerHour || hub.salaryRatePerHour <= 0) return null;
    return { ratePerHour: hub.salaryRatePerHour, minMinutes: hub.salaryMinMinutes };
  } catch {
    return null;
  }
}

async function handleVcLeave(
  guild: VoiceState["guild"],
  userId: string,
  joinedAt: Date,
  /** Hub チャンネルの分給設定。指定時はギルドデフォルト設定の代わりに使用。 */
  hubSalaryOverride?: { ratePerHour: number; minMinutes: number },
): Promise<void> {
  try {
    const guildSettings = await getGuildSettings(guild.id);
    let reward: number;

    if (hubSalaryOverride) {
      // Hub 分給: guild 設定を使わず hub 設定で直接計算
      const minutes = (Date.now() - joinedAt.getTime()) / 60_000;
      if (minutes < hubSalaryOverride.minMinutes) return;
      reward = Math.floor((minutes / 60) * hubSalaryOverride.ratePerHour);
      if (reward <= 0) return;

      const reason = `Hub VC滞在報酬（${Math.floor(minutes)}分）`;
      await db
        .insert(walletsTable)
        .values({ guildId: guild.id, userId, balance: reward })
        .onConflictDoUpdate({
          target: [walletsTable.guildId, walletsTable.userId],
          set: { balance: drizzleSql`${walletsTable.balance} + ${reward}` },
        });
      await db.insert(transactionsTable).values({ guildId: guild.id, userId, amount: reward, reason });
    } else {
      const settings = await getVcRewardSettings(guild.id);
      reward = await payVcReward(guild.id, userId, joinedAt, guildSettings.currencyName, settings);
      if (reward <= 0) return;
    }

    const minutes = Math.floor((Date.now() - joinedAt.getTime()) / 60_000);
    logger.info(
      `[vcsalary] ${userId} in ${guild.id}: +${reward}${guildSettings.currencyName} for ${minutes}min VC${hubSalaryOverride ? " (hub)" : ""}`,
    );

    // DM the user (best-effort; closed DMs are silently ignored).
    try {
      const member = guild.members.cache.get(userId)
        ?? await guild.members.fetch(userId).catch(() => null);
      if (member) {
        await member.send(
          `🎙️ VC滞在報酬として **${reward} ${guildSettings.currencyName}** が付与されました！（${minutes}分 滞在）`,
        );
      }
    } catch {
      // DMs closed or member left — ignore.
    }
  } catch (err) {
    logger.error(`[vcsalary] Error paying VC reward for ${userId} in ${guild.id}`, err);
  }
}

/** Returns the category ID if the channel is in the log category list, else null. */
function getLogCategoryId(channelId: string, categoryIds: string[], guild: VoiceState["guild"]): string | null {
  if (categoryIds.length === 0) return null; // empty = disabled
  const channel = guild.channels.cache.get(channelId);
  if (!channel || !channel.parentId) return null;
  return categoryIds.includes(channel.parentId) ? channel.parentId : null;
}

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  // Ignore bots.
  const userId = newState.member?.id ?? oldState.member?.id;
  if (!userId) return;
  if (newState.member?.user.bot ?? oldState.member?.user.bot) return;

  const guild = newState.guild;
  const afkChannelId = guild.afkChannelId;

  const wasInVc = oldState.channelId !== null;
  const isInVc = newState.channelId !== null;
  const wasInAfk = oldState.channelId === afkChannelId;
  const isInAfk = newState.channelId === afkChannelId;

  /** Returns the category ID for a channel if it matches a configured point VC category. */
  async function getPointCategoryId(channelId: string): Promise<string | null> {
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.parentId) return null;
    const configs = await listVcCategoryConfigs(guild.id).catch(() => [] as Awaited<ReturnType<typeof listVcCategoryConfigs>>);
    return configs.some((c) => c.categoryId === channel.parentId) ? channel.parentId! : null;
  }

  // ── Joined VC (from nothing or from AFK) ─────────────────────────────────
  if (isInVc && !isInAfk && (!wasInVc || wasInAfk)) {
    await Promise.all([
      // Reward tracking (hub salary takes priority over general eligibility)
      (async () => {
        try {
          const hubSalary = await getHubSalaryForChannel(newState.channelId!);
          if (hubSalary) {
            await recordVcJoin(guild.id, userId, newState.channelId!);
          } else {
            const settings = await getVcRewardSettings(guild.id);
            if (settings.ratePerHour > 0 && isEligibleChannel(newState.channelId!, settings.includedCategoryIds, guild)) {
              await recordVcJoin(guild.id, userId, newState.channelId!);
            }
          }
        } catch (err) {
          logger.error(`[vcsalary] recordVcJoin error for ${userId}`, err);
        }
      })(),
      // Point VC tracking
      (async () => {
        try {
          const catId = await getPointCategoryId(newState.channelId!);
          if (catId) await recordPointVcJoin(guild.id, userId, catId);
        } catch (err) {
          logger.error(`[points] recordPointVcJoin error for ${userId}`, err);
        }
      })(),
      // Session log tracking + join notification
      (async () => {
        try {
          const logSettings = await getVcLogSettings(guild.id);
          const catId = getLogCategoryId(newState.channelId!, logSettings.categoryIds, guild);
          if (catId) await recordVcLogJoin(guild.id, userId, newState.channelId!, catId);
          if (logSettings.notifyChannelId) {
            await sendVcNotifyJoin(guild, userId, newState.channelId!, logSettings.notifyChannelId);
          }
        } catch (err) {
          logger.error(`[vclog] recordVcLogJoin error for ${userId}`, err);
        }
      })(),
      // Hub: メンバーが Hub チャンネルに参加した場合は新VCを作成して転送
      handleHubJoin(newState).catch((err) =>
        logger.error(`[vcHub] handleHubJoin error for ${userId}`, err),
      ),
    ]);
    return;
  }

  // ── Left VC (to nothing or to AFK) ───────────────────────────────────────
  if (wasInVc && !wasInAfk && (!isInVc || isInAfk)) {
    await Promise.all([
      // Reward payout (use hub salary if the channel was a hub-salary VC)
      (async () => {
        const presence = await clearVcPresence(guild.id, userId).catch((err) => {
          logger.error(`[vcsalary] clearVcPresence error for ${userId}`, err);
          return undefined;
        });
        if (presence) {
          const hubSalary = await getHubSalaryForChannel(presence.channelId);
          await handleVcLeave(guild, userId, presence.joinedAt, hubSalary ?? undefined);
        }
      })(),
      // Point VC settlement
      settlePointVcSession(guild.id, userId).catch((err) =>
        logger.error(`[points] settlePointVcSession error for ${userId}`, err),
      ),
      // Session log + leave notification
      (async () => {
        try {
          const logSettings = await getVcLogSettings(guild.id);
          const leaveResult = await recordVcLogLeave(guild.id, userId);
          if (logSettings.notifyChannelId) {
            const joinedAt = leaveResult
              ? new Date(Date.now() - leaveResult.durationSeconds * 1000)
              : undefined;
            await sendVcNotifyLeave(guild, userId, oldState.channelId!, logSettings.notifyChannelId, joinedAt);
          }
        } catch (err) {
          logger.error(`[vclog] recordVcLogLeave error for ${userId}`, err);
        }
      })(),
      // Hub: Hub が生成したVCが空になった場合は自動削除
      handleHubLeave(oldState).catch((err) =>
        logger.error(`[vcHub] handleHubLeave error for ${userId}`, err),
      ),
    ]);
    return;
  }

  // ── Moved between two non-AFK VCs ────────────────────────────────────────
  if (wasInVc && !wasInAfk && isInVc && !isInAfk && oldState.channelId !== newState.channelId) {
    await Promise.all([
      // Reward tracking – hub salary and/or category eligibility may have changed
      (async () => {
        try {
          const [oldHubSalary, newHubSalary, settings] = await Promise.all([
            getHubSalaryForChannel(oldState.channelId!),
            getHubSalaryForChannel(newState.channelId!),
            getVcRewardSettings(guild.id),
          ]);
          const wasGeneralEligible = settings.ratePerHour > 0 && isEligibleChannel(oldState.channelId!, settings.includedCategoryIds, guild);
          const nowGeneralEligible = settings.ratePerHour > 0 && isEligibleChannel(newState.channelId!, settings.includedCategoryIds, guild);
          const wasTracked = oldHubSalary != null || wasGeneralEligible;
          const nowTracked = newHubSalary != null || nowGeneralEligible;

          if (wasTracked && !nowTracked) {
            // 報酬対象外に移動 → 精算
            const presence = await clearVcPresence(guild.id, userId).catch(() => undefined);
            if (presence) await handleVcLeave(guild, userId, presence.joinedAt, oldHubSalary ?? undefined);
          } else if (!wasTracked && nowTracked) {
            // 報酬対象に移動 → 計測開始
            await recordVcJoin(guild.id, userId, newState.channelId!);
          } else if (wasTracked && nowTracked) {
            const typeChanged = (oldHubSalary != null) !== (newHubSalary != null);
            const rateChanged = (oldHubSalary?.ratePerHour ?? settings.ratePerHour) !== (newHubSalary?.ratePerHour ?? settings.ratePerHour);
            if (typeChanged || rateChanged) {
              // 報酬レート変化 → 旧セッション精算 → 新セッション開始
              const presence = await clearVcPresence(guild.id, userId).catch(() => undefined);
              if (presence) await handleVcLeave(guild, userId, presence.joinedAt, oldHubSalary ?? undefined);
              await recordVcJoin(guild.id, userId, newState.channelId!);
            } else if (newHubSalary != null) {
              // 同レートのHub VC間移動 → channelId だけ更新（joinedAt は保持）
              await updateVcPresenceChannel(guild.id, userId, newState.channelId!);
            }
            // else: 同カテゴリのgeneral VC間移動 → 何もしない（既存の蓄積を継続）
          }
        } catch (err) {
          logger.error(`[vcsalary] channel-move handling error for ${userId}`, err);
        }
      })(),
      // Point VC tracking – category may have changed
      (async () => {
        try {
          const wasPointCat = await getPointCategoryId(oldState.channelId!);
          const nowPointCat = await getPointCategoryId(newState.channelId!);
          if (wasPointCat && !nowPointCat) {
            await settlePointVcSession(guild.id, userId);
          } else if (!wasPointCat && nowPointCat) {
            await recordPointVcJoin(guild.id, userId, nowPointCat);
          } else if (wasPointCat && nowPointCat && wasPointCat !== nowPointCat) {
            // Different point category — settle old, start new
            await settlePointVcSession(guild.id, userId);
            await recordPointVcJoin(guild.id, userId, nowPointCat);
          }
        } catch (err) {
          logger.error(`[points] VC move point tracking error for ${userId}`, err);
        }
      })(),
      // Session log + move notification – category eligibility may have changed
      (async () => {
        try {
          const logSettings = await getVcLogSettings(guild.id);
          const wasLogCat = getLogCategoryId(oldState.channelId!, logSettings.categoryIds, guild);
          const nowLogCat = getLogCategoryId(newState.channelId!, logSettings.categoryIds, guild);
          if (wasLogCat && !nowLogCat) {
            const leaveResult = await recordVcLogLeave(guild.id, userId);
            if (logSettings.notifyChannelId) {
              const joinedAt = leaveResult
                ? new Date(Date.now() - leaveResult.durationSeconds * 1000)
                : undefined;
              await sendVcNotifyLeave(guild, userId, oldState.channelId!, logSettings.notifyChannelId, joinedAt);
            }
          } else if (!wasLogCat && nowLogCat) {
            await recordVcLogJoin(guild.id, userId, newState.channelId!, nowLogCat);
            if (logSettings.notifyChannelId) {
              await sendVcNotifyJoin(guild, userId, newState.channelId!, logSettings.notifyChannelId);
            }
          } else if (wasLogCat && nowLogCat && logSettings.notifyChannelId) {
            // Both tracked: notify move only (session tracking continues uninterrupted)
            const presence = await getVcLogPresence(guild.id, userId);
            await sendVcNotifyLeave(guild, userId, oldState.channelId!, logSettings.notifyChannelId, presence?.joinedAt);
            await sendVcNotifyJoin(guild, userId, newState.channelId!, logSettings.notifyChannelId);
          }
        } catch (err) {
          logger.error(`[vclog] channel-move log error for ${userId}`, err);
        }
      })(),
      // Hub: 別VCから Hub に移動してきた場合 → 新VC作成＆転送
      handleHubJoin(newState).catch((err) =>
        logger.error(`[vcHub] handleHubJoin (move) error for ${userId}`, err),
      ),
      // Hub: Hub 生成VCから別VCに移動した場合 → 空なら自動削除
      handleHubLeave(oldState).catch((err) =>
        logger.error(`[vcHub] handleHubLeave (move) error for ${userId}`, err),
      ),
    ]);
  }
});

// ─── GuildMemberUpdate — 昇格通知 ＆ eval sheet ───────────────────────────────

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const guildId = newMember.guild.id;

  const addedRoleIds = oldMember.partial
    ? [...newMember.roles.cache.keys()]
    : [...newMember.roles.cache.keys()].filter((id) => !oldMember.roles.cache.has(id));

  const removedRoleIds = oldMember.partial
    ? []
    : [...oldMember.roles.cache.keys()].filter((id) => !newMember.roles.cache.has(id));

  // ── サーバーブースト開始検知 → ポイント付与 ──────────────────────────────
  const justBoosted = !oldMember.partial && !oldMember.premiumSince && !!newMember.premiumSince;
  if (justBoosted) {
    awardBoostPoints(guildId, newMember.id).then((pts) => {
      if (pts > 0) logger.info(`[points] boost award ${newMember.id} +${pts}pt`);
    }).catch((err) => logger.error("[points] boost award error", err));
  }

  if (addedRoleIds.length === 0) return;

  // ── 複数フォーラム × ロール マッピングで一致するものをすべて処理 ─────────
  const matchedConfigs = await getEvalSheetConfigsForRoles(guildId, addedRoleIds).catch(() => []);
  if (matchedConfigs.length === 0) return;

  // 共通設定（nameboard・rosterCategory）は community_sheet_settings から取得
  const globalSettings = await getEvalSheetSettings(guildId).catch(() => undefined);

  let targetUser;
  try { targetUser = await newMember.client.users.fetch(newMember.id); }
  catch { logger.warn(`[sheet] Could not fetch user ${newMember.id}`); return; }

  const displayName = newMember.displayName;

  for (const cfg of matchedConfigs) {
    const forum =
      newMember.guild.channels.cache.get(cfg.forumChannelId) ??
      await newMember.guild.channels.fetch(cfg.forumChannelId).catch(() => null);

    if (!forum || forum.type !== ChannelType.GuildForum) {
      logger.error(`[sheet] forum channel ${cfg.forumChannelId} not found or wrong type (roleId=${cfg.roleId})`);
      continue;
    }

    const roleName = newMember.guild.roles.cache.get(cfg.roleId)?.name ?? cfg.roleId;
    const startDate = new Date();
    const endDate = new Date(startDate.getTime() + cfg.evalPeriodDays * 24 * 60 * 60 * 1000);

    const [vcSeconds, selfIntro] = await Promise.all([
      getSheetVcSeconds(guildId, newMember.id, startDate, endDate).catch(() => 0),
      findSelfIntro(newMember.guild, newMember.id, globalSettings?.rosterCategoryId ?? null).catch(() => null),
    ]);

    const embed = buildSheetEmbed({
      targetUser,
      displayName,
      startDate,
      endDate,
      vcSeconds,
      nameboardUrl: globalSettings?.nameboardUrl ?? null,
      selfIntro,
      createdByLabel: `ロール付与により自動生成（${roleName}）`,
      guildIconUrl: newMember.guild.iconURL() ?? null,
    });

    try {
      const thread = await forum.threads.create({
        name: buildSheetThreadName(displayName, endDate),
        message: { embeds: [embed] },
      });
      await createEvalSheet(guildId, newMember.id, startDate, endDate, forum.id, thread.id);
      logger.info(`[sheet] ✅ Created thread ${thread.id} for user ${newMember.id} role=${roleName} forum=${cfg.forumChannelId}`);
    } catch (err) {
      logger.error(`[sheet] Failed to create forum thread for user ${newMember.id} role=${cfg.roleId}`, err);
    }
  }
});

// ─── GuildMemberAdd — 参加記録 ────────────────────────────────────────────────

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    await recordMemberJoin(member.guild.id, member.id);
  } catch (err) {
    logger.error("[leavelog] Failed to record member join", err);
  }
});

// ─── GuildMemberRemove — 退出通知 ─────────────────────────────────────────────

client.on(Events.GuildMemberRemove, async (member) => {
  const guildId = member.guild.id;

  // 参加記録を退出済みにする
  recordMemberLeave(guildId, member.id).catch((err) =>
    logger.error("[leavelog] Failed to record member leave", err),
  );

  // 通知チャンネル設定確認
  const settings = await getGuildSettings(guildId).catch(() => null);
  if (!settings?.leaveLogChannelId) return;

  const logChannel =
    member.guild.channels.cache.get(settings.leaveLogChannelId) ??
    await member.guild.channels.fetch(settings.leaveLogChannelId).catch(() => null);
  if (!logChannel?.isTextBased()) return;

  // 過去の退出済み参加回数（今回の退出を記録する前に取得済みのため +0 で正確）
  const pastJoins = await countPastJoins(guildId, member.id).catch(() => 0);
  // 今回が退出なので出戻り回数 = 過去の退出済み回数（次に来たとき pastJoins+1 回目になる）
  const rejoinDisplay =
    pastJoins === 0 ? "初回の退出（出戻りなし）" : `**${pastJoins}** 回目の出戻り後の退出`;

  // ウォレット残高
  const wallet = await findWallet(guildId, member.id).catch(() => null);
  const balance = wallet ? wallet.balance.toLocaleString("ja-JP") : "0";
  const currencyName = settings.currencyName;

  // ロール一覧（@everyone 除く、高位順）
  const roles = member.roles?.cache
    ? [...member.roles.cache.values()]
        .filter((r) => r.id !== member.guild.id)
        .sort((a, b) => b.position - a.position)
    : [];
  const roleDisplay =
    roles.length === 0
      ? "なし"
      : roles.length <= 10
        ? roles.map((r) => `<@&${r.id}>`).join(" ")
        : roles.slice(0, 10).map((r) => `<@&${r.id}>`).join(" ") + ` … 他 ${roles.length - 10} 件`;

  const createdAt = Math.floor(member.user.createdTimestamp / 1000);

  const embed = new EmbedBuilder()
    .setTitle("🚪 メンバーが退出しました")
    .setColor(0x95a5a6)
    .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: "ユーザー", value: `${member.user.tag}\n<@${member.id}>`, inline: true },
      { name: "ユーザーID", value: member.id, inline: true },
      { name: "出戻り履歴", value: rejoinDisplay, inline: true },
      { name: "アカウント作成日", value: `<t:${createdAt}:D>（<t:${createdAt}:R>）`, inline: false },
      { name: "所持金", value: `${balance} ${currencyName}`, inline: true },
      { name: "ロール", value: roleDisplay, inline: false },
    )
    .setTimestamp()
    .setFooter({ text: member.guild.name, iconURL: member.guild.iconURL() ?? undefined });

  await (logChannel as TextChannel).send({ embeds: [embed] }).catch((err) =>
    logger.error("[leavelog] Failed to send leave log", err),
  );
});

// ─── 初期発行 — テキストトリガー ───────────────────────────────────────────────

const INITIAL_ISSUE_TRIGGER = "初期発行お願いします。";
const INITIAL_ISSUE_AMOUNT  = 1000;

const INITIAL_ISSUE_CHANNEL_ID = "1526673304327291050";

// ─── MessageCreate — スティッキーメッセージ ───────────────────────────────────

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.guildId)   return;

  const sticky = await getStickyMessage(message.guildId, message.channelId).catch(() => null);
  if (sticky) {
    // Delete the previous sticky post
    if (sticky.lastMessageId) {
      await message.channel.messages.delete(sticky.lastMessageId).catch(() => null);
    }
    // Re-post at the bottom
    try {
      const posted = await message.channel.send({ content: sticky.content, allowedMentions: { parse: [] } });
      await updateStickyLastMessageId(message.guildId, message.channelId, posted.id);
    } catch (err) {
      logger.warn(`[sticky] Failed to re-post sticky in ${message.channelId}`, err);
    }
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.guildId)   return;
  if (message.channelId !== INITIAL_ISSUE_CHANNEL_ID) return;
  if (message.content !== INITIAL_ISSUE_TRIGGER) return;

  const guildId = message.guildId;
  const userId  = message.author.id;

  try {
    const settings = await getGuildSettings(guildId);
    const result = await claimInitialIssue(guildId, userId, INITIAL_ISSUE_AMOUNT, settings.currencyName);
    if (!result.ok) {
      // すでに受け取り済み
      await message.react("📭");
      return;
    }

    await message.react("✅");
  } catch (err) {
    logger.error("[initial-issue] Error", err);
  }
});

// ─── GuildBanAdd — BAN通知 ────────────────────────────────────────────────────

client.on(Events.GuildBanAdd, async (ban) => {
  const guildId = ban.guild.id;

  const settings = await getGuildSettings(guildId).catch(() => null);
  if (!settings?.banLogChannelId) return;

  const logChannel = ban.guild.channels.cache.get(settings.banLogChannelId)
    ?? await ban.guild.channels.fetch(settings.banLogChannelId).catch(() => null);

  if (!logChannel || !logChannel.isTextBased()) {
    logger.warn(`[bannotify] log channel ${settings.banLogChannelId} not found or not text-based`);
    return;
  }

  // Fetch full user object and ban reason
  const user = await ban.user.fetch().catch(() => ban.user);

  // Fetch audit log to identify the moderator who performed the ban
  let moderator: string = "不明";
  let auditReason: string | null = null;
  try {
    if (ban.guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
      const auditLogs = await ban.guild.fetchAuditLogs({
        type: AuditLogEvent.MemberBanAdd,
        limit: 5,
      });
      const entry = auditLogs.entries.find((e) => e.target?.id === user.id);
      if (entry) {
        moderator = entry.executor ? `<@${entry.executor.id}> (${entry.executor.tag})` : "不明";
        auditReason = entry.reason ?? null;
      }
    }
  } catch (err) {
    logger.warn("[bannotify] Failed to fetch audit log", err);
  }

  const reason = auditReason ?? ban.reason ?? "理由なし";
  const createdAt = Math.floor(user.createdTimestamp / 1000);

  const embed = new EmbedBuilder()
    .setTitle("🔨 メンバーがBANされました")
    .setColor(0xe74c3c)
    .setThumbnail(user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: "ユーザー", value: `${user.tag}\n<@${user.id}>`, inline: true },
      { name: "ユーザーID", value: user.id, inline: true },
      { name: "アカウント作成日", value: `<t:${createdAt}:D>（<t:${createdAt}:R>）`, inline: false },
      { name: "実行者", value: moderator, inline: true },
      { name: "理由", value: reason, inline: false },
    )
    .setTimestamp()
    .setFooter({ text: ban.guild.name, iconURL: ban.guild.iconURL() ?? undefined });

  try {
    await (logChannel as TextChannel).send({ embeds: [embed] });
  } catch (err) {
    logger.error("[bannotify] Failed to send ban notification", err);
  }
});

// ─── ChannelDelete — 通知チャンネル自動クリア ────────────────────────────────

client.on(Events.ChannelDelete, async (channel) => {
  // DM チャンネルはギルドに属さないので無視
  if (!("guildId" in channel) || !channel.guildId) return;

  const guildId = channel.guildId;

  try {
    const logSettings = await getVcLogSettings(guildId);
    if (logSettings.notifyChannelId !== channel.id) return;

    // 削除されたチャンネルが通知チャンネルとして設定されていたので null にクリア
    await setVcLogNotifyChannel(guildId, null);
    logger.warn(
      `[vclog] 通知チャンネル ${channel.id} がギルド ${guildId} で削除されたため notifyChannelId を自動クリアしました。` +
      ` /vclog channel set で再設定してください。`,
    );
  } catch (err) {
    logger.error(`[vclog] ChannelDelete: 通知チャンネル設定のクリアに失敗 (guild=${guildId}, channel=${channel.id})`, err);
  }
});

// ─── InteractionCreate ───────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      const command = commandsByName.get(interaction.commandName);
      if (command?.autocomplete) await command.autocomplete(interaction);
      return;
    }

    if (interaction.isChatInputCommand()) {
      const command = commandsByName.get(interaction.commandName);
      if (!command) {
        logger.warn(`Unknown command: ${interaction.commandName}`);
        return;
      }
      await command.execute(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith(ROLE_PANEL_PREFIX)) {
      await handleRolePanelButton(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith(SHOP_BUY_PREFIX)) {
      await handleShopBuyButton(interaction);
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === SHOP_SELECT_ID) {
      await handleShopSelectMenu(interaction);
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === GUIDE_SELECT_ID) {
      await handleGuideSelect(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith(SHIFT_TOGGLE_PREFIX)) {
      await handleShiftToggle(interaction);
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith(SHIFT_TIME_PREFIX)) {
      await handleShiftTime(interaction);
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith(SHIFT_CONFIRM_PREFIX)) {
      await handleShiftConfirm(interaction);
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith(SHIFT_CANCEL_PREFIX)) {
      await handleShiftCancel(interaction);
      return;
    }
    // Also match the legacy bare ID ("shift:panel:open") posted by older panel messages.
    if (
      interaction.isButton() &&
      (interaction.customId === "shift:panel:open" ||
        interaction.customId.startsWith(SHIFT_PANEL_OPEN_PREFIX))
    ) {
      await handleShiftPanelOpen(interaction);
      return;
    }
    if (interaction.isButton() && interaction.customId.startsWith(SHIFT_LIST_NAV_PREFIX)) {
      await handleShiftListNav(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith(NICKNAME_MODAL_PREFIX)) {
      await handleNicknameModalSubmit(interaction);
      return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith(VC_RENAME_MODAL_PREFIX)) {
      await handleVcRenameModalSubmit(interaction);
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
