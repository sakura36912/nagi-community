import { AuditLogEvent, ChannelType, Client, DiscordAPIError, Events, GatewayIntentBits, GuildMember, MessageFlags, PermissionFlagsBits, VoiceState, TextChannel } from "discord.js";
import { initRouletteGifCache } from "./lib/rouletteWheel";
import { handleRolePanelButton, ROLE_PANEL_PREFIX } from "./commands/rolepanel";
import { handleBlackjackButton, BJ_PREFIX } from "./commands/blackjack";

import { handleHighlowButton, HL_PREFIX } from "./commands/highlow";
import { handlePokerButton, POKER_PREFIX } from "./commands/poker";
import { handleRouletteInteraction, ROULETTE_PREFIX } from "./commands/roulette";
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
  VC_PANEL_BTN_ADD,
  VC_PANEL_BTN_KICK,
  VC_PANEL_BTN_EXTEND,
  VC_PANEL_BTN_EXPIRY,
  VC_PANEL_SEL_ADD,
  VC_PANEL_SEL_KICK,
  VC_PANEL_SEL_EXTEND,
  VC_PANEL_BTN_RENAME,
  VC_PANEL_BTN_STREAM,
  CHEST_OPEN_BTN_ID,
  buildChestPanelMessage,
  VC_PANEL_SEL_RENAME,
  VC_PANEL_RENAME_MODAL,
  handleVcPanelAddBtn,
  handleVcPanelKickBtn,
  handleVcPanelExtendBtn,
  handleVcPanelExpiryBtn,
  handleVcPanelRenameBtn,
  handleVcPanelStreamBtn,
  handleVcRefreshPanels,
  refreshAllVcPanelsOnStartup,
  handleChestOpenBtn,
  handleVcPanelAddSel,
  handleVcPanelKickSel,
  handleVcPanelExtendSel,
  handleVcPanelRenameSel,
  handleVcPanelRenameModal,
} from "./commands";
import {
  handleHubJoin,
  handleHubLeave,
  handlePanelOnlyHubTransfer,
  HUB_PANEL_BTN_RENAME,
  HUB_PANEL_BTN_STREAM,
  HUB_PANEL_RENAME_MODAL,
  handleHubRenameBtn,
  handleHubStreamBtn,
  handleHubRenameModal,
} from "./commands/vc";
import { getHubSession, getHubChannelById } from "@workspace/db";
import {
  getExpiredSchedules,
  getSchedulesExpiringSoon,
  getScheduleByChannelId,
  deleteSchedule,
  markScheduleNotified,
  pruneOrphanedVcSchedules,
  NOTIFY_BEFORE_MS,
} from "./lib/vc";
import { buildSheetEmbed, buildSheetThreadName, findSelfIntro } from "./lib/sheet";
import { getStickyMessage, updateStickyLastMessageId } from "./lib/sticky";
import { getShiftSettings, getShiftCountsByUser } from "./lib/shift";
import { handleChannelDelete } from "./lib/handleChannelDelete";
import { runStartupChannelValidation, validateGuildConfiguredChannels } from "./lib/validateConfiguredChannels";
import { makeChannelResolver } from "./lib/makeChannelResolver";
import { handleVcLogMove } from "./lib/vcLogMove";
import { sendVcNotifyJoin, sendVcNotifyLeave } from "./lib/vcNotify";
import { handleVcLogJoin } from "./lib/vcLogJoin";

import { logger } from "./lib/logger";
import {
  getVcRewardSettings,
  recordVcJoin,
  clearVcPresence,
  getAllVcPresences,
  payVcReward,
  payHubSalary,
  getVcLogSettings,
  setVcLogNotifyChannel,
  recordVcLogLeave,
  getVcLogPresence,
  updateVcPresenceChannel,
} from "./lib/vcReward";
import { isTavernChannel, getTavernChannelNames, onTavernJoin, onTavernLeave, flushAllTavernSessions } from "./lib/chestTracker";
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
  getPrivateVcSessionByChannelId,
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
  deactivateSheet,
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
import { getEvalSheetConfigsForRoles, getExpiredTimedRoleGrants, deleteTimedRoleGrant, pool, checkSchemaDrift } from "@workspace/db";

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

      // Build userId → roleIds map from ALL guild members.
      await guild.members.fetch();
      const memberRoles = new Map<string, string[]>();
      for (const member of guild.members.cache.values()) {
        if (member.user.bot) continue;
        memberRoles.set(member.id, [...member.roles.cache.keys()]);
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

// ─── Timed role expiry scheduler ─────────────────────────────────────────────

async function runTimedRoleExpiryScheduler(): Promise<void> {
  const now = new Date();
  const expired = await getExpiredTimedRoleGrants(now);
  for (const grant of expired) {
    try {
      const guild = client.guilds.cache.get(grant.guildId);
      if (guild) {
        const member = guild.members.cache.get(grant.userId)
          ?? await guild.members.fetch(grant.userId).catch(() => null);
        if (member) {
          await member.roles.remove(grant.roleId, "期限付きロール付与の期限切れ");
          logger.info(`[role-expiry] Removed role ${grant.roleId} from ${grant.userId} in ${grant.guildId}`);
        }
      }
    } catch (err) {
      logger.error(`[role-expiry] Failed to remove role ${grant.roleId} from ${grant.userId}`, err);
    }
    await deleteTimedRoleGrant(grant.id).catch((err) =>
      logger.error(`[role-expiry] Failed to delete grant record ${grant.id}`, err),
    );
  }
}

// Checks every minute for private VC sessions whose lease has expired,
// deletes the Discord channel, and removes the session record from the DB.
async function runVcExpiryScheduler(): Promise<void> {
  const now = new Date();
  const expired = await getExpiredPrivateVcSessions(now);

  for (const session of expired) {
    let missingPermissions = false;
    let uraRevocationFailed = false;
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
                ?? await guild.channels.fetch(settings.uraChannelId);
              if (accessCh && "permissionOverwrites" in accessCh) {
                await accessCh.permissionOverwrites.delete(session.userId, "裏フリールームVC期限切れ");
                logger.info(`[vc-expiry] Revoked ura channel access for user ${session.userId}`);
              }
            }
          } catch (err) {
            // Do NOT remove the DB row when ura revocation fails — leave the
            // session record intact so the next scheduler tick retries the
            // revocation.  The VC channel may already be gone, but the session
            // row drives the retry: on the next tick the channel fetch returns
            // null (skipped silently) and revocation is attempted again until
            // it succeeds.
            uraRevocationFailed = true;
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

    // Skip DB cleanup when the channel is still alive but we lack permission,
    // or when the ura access-channel revocation has not yet succeeded — leave
    // the row so the session is retried on the next tick.
    if (missingPermissions || uraRevocationFailed) continue;

    // Remove the session record (channel was deleted or was already gone).
    await deletePrivateVcSession(session.id).catch((err) =>
      logger.error(`[vc-expiry] Failed to delete session ${session.id}`, err),
    );
    // Remove the schedule row so the pre-expiry warning scheduler does not
    // attempt to DM the user for an already-deleted channel.
    await deleteSchedule(session.channelId).catch((err) =>
      logger.error(`[vc-expiry] Failed to remove schedule row for ${session.channelId}`, err),
    );
  }
}


// ─── Eval-sheet VC-time periodic refresh ─────────────────────────────────────

let lastSheetVcRefresh = 0;
let sheetVcRefreshRunning = false;
const SHEET_VC_REFRESH_INTERVAL_MS = 60 * 1000; // 1 minute

// GuildMemberUpdate の oldMember が partial のときに使うロール事前スナップショット。
// キー: `${guildId}:${userId}`  値: そのメンバーが直前に持っていたロール ID の Set
const memberRoleSnapshots = new Map<string, Set<string>>();

// 評価シート作成の二重発火を防ぐための処理中ロック
// Discord が GuildMemberUpdate を短時間に複数回発火することがあり、
// 両イベントが同時にスナップショットを読むとレースコンディションになる。
const sheetCreationLocks = new Set<string>();

async function runSheetVcRefreshScheduler(bot: Client<true>): Promise<void> {
  const now = Date.now();
  if (now - lastSheetVcRefresh < SHEET_VC_REFRESH_INTERVAL_MS) return;
  if (sheetVcRefreshRunning) return; // 前バッチが終わるまで新バッチを起動しない
  lastSheetVcRefresh = now;
  sheetVcRefreshRunning = true;

  try {
  const sheets = await listActiveSheets();
  if (sheets.length === 0) return;

  logger.info(`[sheet-vc] Refreshing VC time for ${sheets.length} active sheet(s)`);

  for (const sheet of sheets) {
    if (!sheet.messageId) continue;
    try {
      const thread = await bot.channels.fetch(sheet.messageId).catch(() => null);
      if (!thread) {
        // Discord スレッドが存在しない → DB から除外して次回以降スキップ
        logger.warn(`[sheet-vc] sheet ${sheet.id} thread not found — deactivating`);
        await deactivateSheet(sheet.id).catch(() => null);
        continue;
      }
      if (!thread.isTextBased()) continue;
      const message = await thread.messages.fetch(sheet.messageId).catch(() => null);
      if (!message) continue;

      const targetUser = await bot.users.fetch(sheet.userId).catch(() => null);
      if (!targetUser) continue;

      let displayName = targetUser.displayName;
      let sheetGuild: import("discord.js").Guild | null = null;
      let mem: import("discord.js").GuildMember | null = null;
      try {
        sheetGuild = bot.guilds.cache.get(sheet.guildId) ?? await bot.guilds.fetch(sheet.guildId);
        mem = await sheetGuild.members.fetch(sheet.userId).catch(() => null);
        if (mem) displayName = mem.displayName;
      } catch { /* use user displayName */ }

      const settings = await getEvalSheetSettings(sheet.guildId);
      const [vcSeconds, selfIntroResult] = await Promise.all([
        getSheetVcSeconds(sheet.guildId, sheet.userId, sheet.startDate, sheet.endDate),
        sheetGuild
          ? findSelfIntro(sheetGuild, sheet.userId, settings?.rosterCategoryId)
          : Promise.resolve(null),
      ]);

      const embed = buildSheetEmbed({
        targetUser,
        member: mem ?? null,
        displayName,
        startDate: sheet.startDate,
        endDate: sheet.endDate,
        vcSeconds,
        selfIntro: selfIntroResult?.content ?? null,
        rosterPostUrl: selfIntroResult?.url ?? null,
        createdByLabel: "自動更新（定期集計）",
        guildIconUrl: sheetGuild?.iconURL() ?? null,
      });

      await message.edit({ embeds: [embed] });
      logger.info(`[sheet-vc] Updated sheet ${sheet.id} for user ${sheet.userId}: ${vcSeconds}s`);
    } catch (err) {
      logger.error(`[sheet-vc] Failed to refresh sheet ${sheet.id}`, err);
    }
  }
  } finally {
    sheetVcRefreshRunning = false;
  }
}


// ─── Eval-sheet end-of-period reminder ───────────────────────────────────────

async function runSheetReminderScheduler(bot: Client<true>): Promise<void> {
  const sheets = await listSheetsNeedingReminder();
  for (const sheet of sheets) {
    try {
      const endTs = Math.floor(sheet.endDate.getTime() / 1000);

      // ── 1. フォーラムスレッド内リマインダー ──────────────────────────────
      if (sheet.messageId) {
        const thread = await bot.channels.fetch(sheet.messageId).catch(() => null);
        if (thread?.isTextBased() && "send" in thread && typeof thread.send === "function") {
          const threadEmbed = new EmbedBuilder()
            .setTitle("⏰ 評価期間が終了しました")
            .setColor(0xe74c3c)
            .setDescription(
              `<@${sheet.userId}> さんの評価期間（〜<t:${endTs}:D>）が終了しました。\n` +
              `評価を締めくくって結果を記録してください。`,
            )
            .setTimestamp();
          await (thread as import("discord.js").TextChannel)
            .send({ content: `<@${sheet.userId}>`, embeds: [threadEmbed] });
          logger.info(`[sheet-reminder] Sent thread reminder for sheet ${sheet.id} (user ${sheet.userId})`);
        }
      }

      // ── 2. 設定済みチャンネルへのロールメンション通知 ────────────────────
      const guildSettings = await getEvalSheetSettings(sheet.guildId);
      if (guildSettings?.deadlineNotifyChannelId) {
        const notifChannel = await bot.channels.fetch(guildSettings.deadlineNotifyChannelId).catch(() => null);
        if (notifChannel?.isTextBased() && "send" in notifChannel && typeof notifChannel.send === "function") {
          const roleMention = guildSettings.deadlineNotifyRoleId
            ? `<@&${guildSettings.deadlineNotifyRoleId}> `
            : "";
          const notifEmbed = new EmbedBuilder()
            .setTitle("📋 評価期日のお知らせ")
            .setColor(0xe67e22)
            .setDescription(
              `<@${sheet.userId}> さんの評価期間が本日（<t:${endTs}:D>）で終了します。\n` +
              `評価を確認し、結果を記録してください。`,
            )
            .setTimestamp();
          await (notifChannel as import("discord.js").TextChannel)
            .send({ content: roleMention.trim() || undefined, embeds: [notifEmbed] });
          logger.info(`[sheet-reminder] Sent channel notification for sheet ${sheet.id} to ${guildSettings.deadlineNotifyChannelId}`);
        }
      }
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
      const configuredMinutes = guildSettings.vcWarnBeforeMinutes;
      const warnBeforeMs =
        configuredMinutes != null && configuredMinutes > 0
          ? configuredMinutes * 60 * 1000
          : (logger.info(
              `[vc-schedule] vcWarnBeforeMinutes not set for guild ${guild.id}; falling back to default ${NOTIFY_BEFORE_MS / 60000} min`,
            ),
            NOTIFY_BEFORE_MS);
      const soon = await getSchedulesExpiringSoon(guild.id, now, warnBeforeMs);

      for (const schedule of soon) {
        // Guard: if the channel was deleted without calling deleteSchedule the
        // row may still be here.  Distinguish a confirmed absence from a
        // transient lookup failure so we don't accidentally destroy a live row.
        const cachedCh = guild.channels.cache.get(schedule.channelId);
        let channelConfirmedGone = false;
        let channelLookupFailed = false;

        if (!cachedCh) {
          try {
            const fetched = await guild.channels.fetch(schedule.channelId);
            // fetch() returns null when the channel is not found (some d.js versions)
            if (fetched === null) channelConfirmedGone = true;
          } catch (err) {
            if (err instanceof DiscordAPIError && err.code === 10003) {
              // Unknown Channel — confirmed deleted on Discord's side
              channelConfirmedGone = true;
            } else {
              // Transient failure (network issue, 50013 Missing Access, etc.)
              // Leave the schedule row intact so the next tick can retry.
              logger.error(
                `[vc-schedule] Could not look up channel ${schedule.channelId} — will retry on next tick`,
                err,
              );
              channelLookupFailed = true;
            }
          }
        }

        if (channelLookupFailed) continue;

        if (channelConfirmedGone) {
          logger.info(
            `[vc-schedule] Channel ${schedule.channelId} no longer exists — removing stale schedule row`,
          );
          await deleteSchedule(schedule.channelId).catch((err) =>
            logger.error(
              `[vc-schedule] Failed to remove stale schedule for ${schedule.channelId}`,
              err,
            ),
          );
          continue;
        }

        try {
          if (schedule.userId && schedule.channelName) {
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
          } else if (!schedule.channelName) {
            logger.warn(
              `[vc-schedule] Skipping expiry warning DM for channel ${schedule.channelId} — channelName is missing`,
            );
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
    // Re-check the current expiresAt to guard against a race where the user
    // called extendSchedule() after getExpiredSchedules() captured the stale
    // row but before we act on it.  If the row has been extended (expiresAt >
    // now) or already removed, skip the deletion entirely.
    const currentSchedule = await getScheduleByChannelId(schedule.channelId);
    if (!currentSchedule || currentSchedule.expiresAt > now) {
      logger.info(
        `[vc-schedule] Skipping deletion of ${schedule.channelId} — schedule was extended or already removed`,
      );
      continue;
    }

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
      // In this case we must NOT remove the DB row so that the scheduler can
      // retry on the next tick once an admin restores the permission.
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
    // leave the row so the scheduler retries on the next tick.
    if (missingPermissions) continue;

    // Remove the DB row (channel was deleted or was already gone).
    await deleteSchedule(schedule.channelId).catch((err) =>
      logger.error(`[vc-schedule] Failed to remove schedule row for ${schedule.channelId}`, err),
    );
  }
}

client.once(Events.ClientReady, async (readyClient) => {
  dlog(`Logged in as ${readyClient.user.tag}`);
  logger.info(`Logged in as ${readyClient.user.tag}`);

  // ルーレットGIFを全番号分バックグラウンドで事前生成してキャッシュする。
  // コマンド応答を即時化するため、ready 直後に起動して完了を待たない。
  initRouletteGifCache((done, total) => {
    if (done === total) {
      logger.info(`[roulette-cache] All ${total} GIFs pre-generated and cached`);
    }
  }).catch((err) => logger.error("[roulette-cache] Failed to initialize GIF cache", err));

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

  // Remove vc_schedules rows for guilds the bot is no longer a member of.
  // When the bot is removed from a guild its schedule rows are never cleaned
  // up by the regular expiry loop, so they accumulate indefinitely.
  const activeGuildIds = [...readyClient.guilds.cache.keys()];
  pruneOrphanedVcSchedules(activeGuildIds)
    .then((count) => {
      if (count > 0) {
        logger.info(`[vc-schedule] Pruned ${count} orphaned schedule row(s) for guilds the bot has left`);
      }
    })
    .catch((err) => logger.error("[vc-schedule] Failed to prune orphaned vc_schedules rows", err));

  // Seed default shop items for all guilds already in the bot's cache.
  for (const guild of readyClient.guilds.cache.values()) {
    seedDefaultShopItems(guild.id).catch((err) =>
      logger.error(`[seed] Failed to seed default shop items for guild ${guild.id}`, err),
    );
    seedDefaultVcShopItems(guild.id).catch((err) =>
      logger.error(`[seed] Failed to seed VC shop items for guild ${guild.id}`, err),
    );
  }

  // Validate configured channel IDs for every guild that was already in cache
  // when the bot connected.  If the bot was offline when a channel was deleted
  // the ChannelDelete handler never fired and the stale ID remains in the DB;
  // this pass clears any such IDs so the bot starts in a consistent state.
  //
  // NOTE: Events.GuildAvailable is NOT fired for guilds received during initial
  // READY, so we must iterate readyClient.guilds.cache here.  GuildAvailable
  // is kept below only as a runtime recovery path (unavailable → available).
  runStartupChannelValidation(
    readyClient.guilds.cache.values(),
    (guild) => makeChannelResolver(guild),
  ).catch((err) => logger.error("[startup] チャンネル検証に失敗しました", err));

  // Re-register any members already sitting in a tavern VC when the bot
  // restarts.  We cannot recover the exact join time, so we use the current
  // time as a proxy — members who leave shortly after restart will still
  // accumulate seconds from the moment the bot came back online.
  let tavernSeedCount = 0;
  for (const guild of readyClient.guilds.cache.values()) {
    const tavernNames = await getTavernChannelNames(guild.id).catch(() => undefined);
    for (const voiceState of guild.voiceStates.cache.values()) {
      const channelId = voiceState.channelId;
      if (!channelId) continue;
      const ch = guild.channels.cache.get(channelId);
      if (!ch) continue;
      const names = tavernNames ?? (await getTavernChannelNames(guild.id).catch(() => new Set<string>()));
      if (!names.has(ch.name)) continue;
      const userId = voiceState.id;
      onTavernJoin(guild.id, userId);
      tavernSeedCount++;
    }
  }
  if (tavernSeedCount > 0) {
    logger.info(`[chest] Seeded ${tavernSeedCount} tavern member(s) into tracker on startup`);
  }

  // 起動直後に全シートを即時更新（名簿リンク等の変更を既存シートに即反映）
  runSheetVcRefreshScheduler(readyClient).catch((err) => logger.error("[sheet-vc] Startup refresh error", err));

  // 起動直後に全高級船室パネルを最新レイアウトに一括更新（ボタン追加・変更等を既存パネルに即反映）
  refreshAllVcPanelsOnStartup(readyClient).catch((err) => logger.error("[vc-startup-refresh] Startup panel refresh error", err));

  // 酒場 VC 滞在時間を 10 分ごとに DB へフラッシュ（Bot 再起動によるロストを最大 10 分に制限）
  setInterval(() => {
    flushAllTavernSessions().catch((err) => logger.error("[chest] flushAllTavernSessions error", err));
  }, 10 * 60 * 1000);

  // Tick every 60 s; actual payout only happens when an interval has elapsed.
  setInterval(() => {
    runRewardScheduler().catch((err) => logger.error("[reward] Scheduler error", err));
    runVcExpiryScheduler().catch((err) => logger.error("[vc-expiry] Scheduler error", err));
    runVcDeleteScheduler().catch((err) => logger.error("[vc-schedule] Scheduler error", err));
    runTimedRoleExpiryScheduler().catch((err) => logger.error("[role-expiry] Scheduler error", err));
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


// ─── Startup channel validation ───────────────────────────────────────────────
//
// When the bot was offline while a channel was deleted, the ChannelDelete
// handler never fired and the stale ID remains in the database.  We validate
// every configured channel ID against the live cache on startup (ClientReady)
// and again whenever a guild transitions from unavailable → available at
// runtime (GuildAvailable).

/**
 * Build a resolveChannel callback for the given guild.
 *
 * Returns true  when the channel still exists on Discord (cache hit or REST).
 * Returns false when it is confirmed gone (API error 10003 / null fetch).
 * Throws        on transient errors (network, 50013 Missing Access, etc.) so
 *               validateGuildConfiguredChannels treats the channel as "still
 *               exists" rather than clearing it spuriously.
 */

// Runtime recovery: fired when a guild transitions from unavailable → available
// during an active session.  Not fired for guilds present at initial READY.
client.on(Events.GuildAvailable, (guild) => {
  validateGuildConfiguredChannels(guild.id, makeChannelResolver(guild)).catch((err) =>
    logger.error(`[startup] チャンネル検証中にエラーが発生しました (guild=${guild.id})`, err),
  );
});

// ─── VC 入退室通知 ────────────────────────────────────────────────────────────

/** メンバーの表示名を取得。キャッシュになければユーザーIDをフォールバックとして使用 */
function getMemberDisplayName(guild: VoiceState["guild"], userId: string): string {
  return guild.members.cache.get(userId)?.displayName ?? `ユーザー(${userId})`;
}

/** チャンネル名を取得。キャッシュになければチャンネルIDをフォールバックとして使用 */
// ─── VC-time reward handler ───────────────────────────────────────────────────

/**
 * Returns true if the given channelId is in the eligible channel list.
 * When includedChannelIds is empty, all voice channels are eligible.
 * Private VCs created by /vc are always eligible regardless of the list.
 * Hub-generated VCs (高級船室) are always excluded — hub salary is handled separately.
 */
async function isEligibleChannel(
  channelId: string,
  includedChannelIds: string[],
): Promise<boolean> {
  // Hub生成のプライベートVC（高級船室）は通常報酬対象外（Hub分給で別途制御）
  const hubSession = await getHubSession(channelId).catch(() => null);
  if (hubSession != null) return false;

  if (includedChannelIds.length === 0) return true;
  if (includedChannelIds.includes(channelId)) return true;
  // /vc で作成された private VC は常に対象
  const session = await getPrivateVcSessionByChannelId(channelId);
  return session != null;
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
      // Hub 分給: guild 設定を使わず hub 設定で直接計算し、DM で通知する
      const member = guild.members.cache.get(userId);
      reward = await payHubSalary(
        guild.id,
        userId,
        joinedAt,
        guildSettings.currencyName,
        hubSalaryOverride,
        member ? (msg: string) => member.send(msg) : undefined,
      );
      if (reward <= 0) return;
    } else {
      const settings = await getVcRewardSettings(guild.id);
      const member = guild.members.cache.get(userId);
      reward = await payVcReward(
        guild.id,
        userId,
        joinedAt,
        guildSettings.currencyName,
        settings,
        member ? (msg: string) => member.send(msg) : undefined,
      );
      if (reward <= 0) return;
    }

    const minutes = Math.floor((Date.now() - joinedAt.getTime()) / 60_000);
    logger.info(
      `[vcsalary] ${userId} in ${guild.id}: +${reward}${guildSettings.currencyName} for ${minutes}min VC${hubSalaryOverride ? " (hub)" : ""}`,
    );

  } catch (err) {
    logger.error(`[vcsalary] Error paying VC reward for ${userId} in ${guild.id}`, err);
  }

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
    // 宝箱トラッカー：酒場に入室したら記録
    if (await isTavernChannel(guild.id, guild, newState.channelId!)) {
      onTavernJoin(guild.id, userId);
    }
    await Promise.all([
      // Reward tracking (hub salary takes priority over general eligibility)
      (async () => {
        try {
          const hubSalary = await getHubSalaryForChannel(newState.channelId!);
          if (hubSalary) {
            await recordVcJoin(guild.id, userId, newState.channelId!);
          } else {
            const settings = await getVcRewardSettings(guild.id);
            if (settings.ratePerHour > 0 && await isEligibleChannel(newState.channelId!, settings.includedChannelIds)) {
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
      handleVcLogJoin(guild, userId, newState.channelId!).catch((err) =>
        logger.error(`[vclog] handleVcLogJoin error for ${userId}`, err),
      ),
      // Hub: メンバーが Hub チャンネルに参加した場合は新VCを作成して転送
      handleHubJoin(newState).catch((err) =>
        logger.error(`[vcHub] handleHubJoin error for ${userId}`, err),
      ),
    ]);
    return;
  }

  // ── Left VC (to nothing or to AFK) ───────────────────────────────────────
  if (wasInVc && !wasInAfk && (!isInVc || isInAfk)) {
    // 宝箱トラッカー：酒場から退出したら秒数を確定して DB に記録
    await onTavernLeave(guild.id, userId);
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
    // 宝箱トラッカー：酒場→別 or 別→酒場 の移動を処理
    const [wasTavern, nowTavern] = await Promise.all([
      isTavernChannel(guild.id, guild, oldState.channelId!),
      isTavernChannel(guild.id, guild, newState.channelId!),
    ]);
    if (wasTavern && !nowTavern) {
      await onTavernLeave(guild.id, userId); // 酒場から出た → 秒数確定
    } else if (!wasTavern && nowTavern) {
      onTavernJoin(guild.id, userId); // 酒場に入った → 計測開始
    }
    // 酒場→酒場 の移動は起こり得ないため else は不要
    await Promise.all([
      // Reward tracking – hub salary and/or category eligibility may have changed
      (async () => {
        try {
          const [oldHubSalary, newHubSalary, settings] = await Promise.all([
            getHubSalaryForChannel(oldState.channelId!),
            getHubSalaryForChannel(newState.channelId!),
            getVcRewardSettings(guild.id),
          ]);
          const [wasGeneralEligible, nowGeneralEligible] = await Promise.all([
            isEligibleChannel(oldState.channelId!, settings.includedChannelIds).then((e) => settings.ratePerHour > 0 && e),
            isEligibleChannel(newState.channelId!, settings.includedChannelIds).then((e) => settings.ratePerHour > 0 && e),
          ]);
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
            // チャンネル移動時は joinedAt を保持したまま channelId だけ更新
            // レート・種別が変わっても精算しない（滞在時間をリセットしない）
            await updateVcPresenceChannel(guild.id, userId, newState.channelId!);
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
      handleVcLogMove(
        guild.id,
        userId,
        oldState.channelId!,
        newState.channelId!,
        (channelId) => guild.channels.cache.get(channelId)?.parentId,
        {
          sendJoin: (uid, channelId, notifyChannelId) =>
            sendVcNotifyJoin(guild, uid, channelId, notifyChannelId),
          sendLeave: (uid, channelId, notifyChannelId, joinedAt) =>
            sendVcNotifyLeave(guild, uid, channelId, notifyChannelId, joinedAt),
        },
      ).catch((err) => logger.error(`[vclog] channel-move log error for ${userId}`, err)),
      // Hub: 別VCから Hub に移動してきた場合 → 新VC作成＆転送
      handleHubJoin(newState).catch((err) =>
        logger.error(`[vcHub] handleHubJoin (move) error for ${userId}`, err),
      ),
      // Hub: Hub 生成VCから別VCに移動した場合 → 空なら自動削除
      handleHubLeave(oldState).catch((err) =>
        logger.error(`[vcHub] handleHubLeave (move) error for ${userId}`, err),
      ),
      // パネルのみ Hub（娯楽甲板など）から別Botが転送したVCへ移動 → パネル送信
      handlePanelOnlyHubTransfer(oldState, newState).catch((err) =>
        logger.error(`[vcHub] handlePanelOnlyHubTransfer error for ${userId}`, err),
      ),
    ]);
  }
});

// ─── GuildMemberUpdate — 昇格通知 ＆ eval sheet ───────────────────────────────

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const guildId = newMember.guild.id;
  const snapshotKey = `${guildId}:${newMember.id}`;

  // oldMember が partial（キャッシュ未保持）のとき、Discord の REST fetch は
  // 更新後の状態を返すため差分計算には使えない。代わりにイベントごとに管理する
  // ロールスナップショットを参照する。スナップショットが存在しない場合は差分不明
  // として eval sheet 処理をスキップし、今回の状態を記録して次回以降に備える。
  let oldRoles: Set<string>;
  if (oldMember.partial) {
    const snapshot = memberRoleSnapshots.get(snapshotKey);
    if (!snapshot) {
      logger.warn(
        `[sheet] GuildMemberUpdate user=${newMember.id} guild=${guildId} — oldMember is partial and no role snapshot exists; skipping to avoid spurious sheet creation`,
      );
      // 次回のイベントで正確な差分が取れるよう現在のロールを記録しておく
      memberRoleSnapshots.set(snapshotKey, new Set(newMember.roles.cache.keys()));
      return;
    }
    logger.info(`[sheet] GuildMemberUpdate user=${newMember.id} guild=${guildId} — oldMember is partial; using cached role snapshot`);
    oldRoles = snapshot;
  } else {
    oldRoles = new Set(oldMember.roles.cache.keys());
  }

  // 次回のイベントのために最新ロールを保存（差分計算より前に更新しても安全）
  memberRoleSnapshots.set(snapshotKey, new Set(newMember.roles.cache.keys()));

  const addedRoleIds = [...newMember.roles.cache.keys()].filter((id) => !oldRoles.has(id));
  const removedRoleIds = [...oldRoles.keys()].filter((id) => !newMember.roles.cache.has(id));

  // ── サーバーブースト開始検知 → ポイント付与 ──────────────────────────────
  const justBoosted = !oldMember.partial && !oldMember.premiumSince && !!newMember.premiumSince;
  if (justBoosted) {
    awardBoostPoints(guildId, newMember.id).then((pts) => {
      if (pts > 0) logger.info(`[points] boost award ${newMember.id} +${pts}pt`);
    }).catch((err) => logger.error("[points] boost award error", err));
  }

  logger.info(`[sheet] GuildMemberUpdate user=${newMember.id} guild=${guildId} addedRoles=[${addedRoleIds.join(",")}] partial=${oldMember.partial}`);

  if (addedRoleIds.length === 0) return;

  // 同一ユーザーの二重処理をロックで防ぐ
  const lockKey = `${guildId}:${newMember.id}`;
  if (sheetCreationLocks.has(lockKey)) {
    logger.warn(`[sheet] Skipping duplicate GuildMemberUpdate for user=${newMember.id} guild=${guildId} (already processing)`);
    return;
  }
  sheetCreationLocks.add(lockKey);

  try {

  // ── 複数フォーラム × ロール マッピングで一致するものをすべて処理 ─────────
  let matchedConfigs: Awaited<ReturnType<typeof getEvalSheetConfigsForRoles>> = [];
  try {
    matchedConfigs = await getEvalSheetConfigsForRoles(guildId, addedRoleIds);
  } catch (err) {
    logger.error(`[sheet] getEvalSheetConfigsForRoles failed guild=${guildId}`, err);
    return;
  }
  if (matchedConfigs.length === 0) {
    logger.info(`[sheet] no config matched for roles [${addedRoleIds.join(",")}] in guild ${guildId} — /evalsheet setup を確認してください`);
    return;
  }

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

    const [vcSeconds, selfIntroResult] = await Promise.all([
      getSheetVcSeconds(guildId, newMember.id, startDate, endDate).catch(() => 0),
      findSelfIntro(newMember.guild, newMember.id, globalSettings?.rosterCategoryId ?? null).catch(() => null),
    ]);

    const embed = buildSheetEmbed({
      targetUser,
      member: newMember,
      displayName,
      startDate,
      endDate,
      vcSeconds,
      selfIntro: selfIntroResult?.content ?? null,
      rosterPostUrl: selfIntroResult?.url ?? null,
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

  } finally {
    sheetCreationLocks.delete(lockKey);
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

  // ロールスナップショットを削除する。削除しないと再参加後の partial GuildMemberUpdate で
  // 退出前のロールが「既存」と誤判定され、eval sheet が作成されなくなる。
  memberRoleSnapshots.delete(`${guildId}:${member.id}`);

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

// ボットメッセージは message.author.bot で弾き、ユーザーメッセージは
// チャンネルごとのロックで同時実行を防ぐ。
// ※ デバウンス方式は「タイマー削除後に非同期処理が続く間に新規タイマーが
//    並走して2件投稿される」レースコンディションがあるため採用しない。
const stickyProcessingChannels = new Set<string>();

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return; // ボット投稿（自分自身を含む）は無視
  if (!message.guildId) return;

  const guildId    = message.guildId;
  const channelKey = `${guildId}:${message.channelId}`;

  if (stickyProcessingChannels.has(channelKey)) return; // 処理中はスキップ
  stickyProcessingChannels.add(channelKey);

  try {
    const sticky = await getStickyMessage(guildId, message.channelId).catch(() => null);
    if (!sticky) return;

    // 直近100件のうちボット自身のスティッキーと同内容のものをまとめて削除
    // （過去の重複投稿による孤立メッセージも一緒に消える）
    try {
      const recent = await message.channel.messages.fetch({ limit: 100 });
      const botStickies = recent.filter(
        (m) => m.author.bot && m.content === sticky.content,
      );
      if (botStickies.size > 0) {
        await Promise.allSettled(botStickies.map((m) => m.delete()));
      }
    } catch (err) {
      logger.warn(`[sticky] Failed to bulk-delete old stickies in ${message.channelId}`, err);
    }

    // 最下部に再投稿
    try {
      const posted = await message.channel.send({ content: sticky.content, allowedMentions: { parse: [] } });
      await updateStickyLastMessageId(guildId, message.channelId, posted.id);
    } catch (err) {
      logger.warn(`[sticky] Failed to re-post sticky in ${message.channelId}`, err);
    }
  } finally {
    stickyProcessingChannels.delete(channelKey);
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

client.on(Events.ChannelDelete, (channel) => { void handleChannelDelete(channel); });

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
      // 島民・追放者ロール制限: 送金・残高確認のみ許可（スタッフロールは免除）
      if (interaction.inGuild()) {
        const member = interaction.member as GuildMember;
        const EXEMPT_ROLES    = ["守門卿", "門番", "門番見習い", "見習い門番", "航海士", "提督", "大提督"];
        const RESTRICTED_ROLES = ["島民", "追放者"];
        const RESTRICTED_ALLOWED = new Set(["送金", "残高確認"]);
        const isExempt = EXEMPT_ROLES.some((name) =>
          interaction.guild?.roles.cache.some((r) => r.name === name && member.roles.cache.has(r.id)),
        );
        const hasRestrictedRole = !isExempt && RESTRICTED_ROLES.some((name) =>
          interaction.guild?.roles.cache.some((r) => r.name === name && member.roles.cache.has(r.id)),
        );
        if (hasRestrictedRole && !RESTRICTED_ALLOWED.has(interaction.commandName)) {
          await interaction.reply({ content: "このロールでは `/送金` と `/残高確認` のみ使用できます。", ephemeral: true });
          return;
        }
      }
      // /vc refresh-panels は commands/index.ts にあるハンドラで処理
      // (vc.ts から commands/index.ts を import すると循環参照になるため)
      if (interaction.commandName === "vc" && interaction.options.getSubcommand(false) === "refresh-panels") {
        await handleVcRefreshPanels(interaction);
        return;
      }
      await command.execute(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith(BJ_PREFIX)) {
      await handleBlackjackButton(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith(HL_PREFIX)) {
      await handleHighlowButton(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith(POKER_PREFIX)) {
      await handlePokerButton(interaction);
      return;
    }

    if (
      (interaction.isButton() || interaction.isStringSelectMenu()) &&
      interaction.customId.startsWith(ROULETTE_PREFIX)
    ) {
      await handleRouletteInteraction(interaction as Parameters<typeof handleRouletteInteraction>[0]);
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

    if (interaction.isButton() && interaction.customId.startsWith(VC_PANEL_BTN_ADD)) {
      await handleVcPanelAddBtn(interaction); return;
    }
    if (interaction.isButton() && interaction.customId.startsWith(VC_PANEL_BTN_KICK)) {
      await handleVcPanelKickBtn(interaction); return;
    }
    if (interaction.isButton() && interaction.customId.startsWith(VC_PANEL_BTN_EXTEND)) {
      await handleVcPanelExtendBtn(interaction); return;
    }
    if (interaction.isButton() && interaction.customId.startsWith(VC_PANEL_BTN_EXPIRY)) {
      await handleVcPanelExpiryBtn(interaction); return;
    }
    if (interaction.isUserSelectMenu() && interaction.customId.startsWith(VC_PANEL_SEL_ADD)) {
      await handleVcPanelAddSel(interaction); return;
    }
    if (interaction.isUserSelectMenu() && interaction.customId.startsWith(VC_PANEL_SEL_KICK)) {
      await handleVcPanelKickSel(interaction); return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith(VC_PANEL_SEL_EXTEND)) {
      await handleVcPanelExtendSel(interaction); return;
    }
    if (interaction.isButton() && interaction.customId.startsWith(VC_PANEL_BTN_RENAME)) {
      await handleVcPanelRenameBtn(interaction); return;
    }
    if (interaction.isButton() && interaction.customId.startsWith(VC_PANEL_BTN_STREAM)) {
      await handleVcPanelStreamBtn(interaction); return;
    }
    if (interaction.isButton() && interaction.customId.startsWith("chest:open")) {
      await handleChestOpenBtn(interaction); return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith(VC_PANEL_SEL_RENAME)) {
      await handleVcPanelRenameSel(interaction); return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith(VC_PANEL_RENAME_MODAL)) {
      await handleVcPanelRenameModal(interaction); return;
    }

    // ─── Hub VC panel ────────────────────────────────────────────────────────
    if (interaction.isButton() && interaction.customId.startsWith(HUB_PANEL_BTN_RENAME)) {
      await handleHubRenameBtn(interaction); return;
    }
    if (interaction.isButton() && interaction.customId.startsWith(HUB_PANEL_BTN_STREAM)) {
      await handleHubStreamBtn(interaction); return;
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith(HUB_PANEL_RENAME_MODAL)) {
      await handleHubRenameModal(interaction); return;
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
    // 10062 = Unknown interaction (expired before we could respond) — not actionable, skip silently.
    const code = (err as { code?: number }).code;
    if (code === 10062) return;

    logger.error("Error handling interaction", err);
    if (interaction.isRepliable()) {
      try {
        const msg = "処理中にエラーが発生しました。";
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral });
        } else {
          await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
        }
      } catch {
        // Ignore errors from the error-reply itself (e.g. 40060 already-acknowledged).
      }
    }
  }
});

// Check for schema drift at startup. A missing column (e.g. after a merge
// where drizzle-kit push was never run) causes cryptic runtime errors on every
// query that touches the affected table. Logging a clear warning here makes the
// root cause immediately visible in bot logs.
checkSchemaDrift(pool, (msg) => logger.warn(msg)).then((result) => {
  if (!result.ok) {
    logger.warn(
      "[schema-check] ⚠ The bot will continue, but queries against affected tables will fail. " +
        "Fix: run `pnpm --filter @workspace/db run push-force` then restart the bot.",
    );
  }
}).catch(() => {
  // Never let a schema check failure block startup.
});

dlog("calling client.login()");
client.login(token).catch((err) => {
  dlog(`login failed: ${err}`);
  logger.error("Failed to log in to Discord", err);
  process.exit(1);
});
