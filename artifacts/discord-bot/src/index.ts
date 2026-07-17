import { ChannelType, Client, Events, GatewayIntentBits, MessageFlags, PermissionFlagsBits, VoiceState, TextChannel } from "discord.js";
import { EmbedBuilder } from "discord.js";
import {
  commands,
  handleNicknameModalSubmit,
  handleVcRenameModalSubmit,
  handleShopBuyButton,
  NICKNAME_MODAL_PREFIX,
  VC_RENAME_MODAL_PREFIX,
  SHOP_BUY_PREFIX,
  postWeeklyShifts,
  getNextWeeklyPostTime,
  SHIFT_TOGGLE_PREFIX,
  SHIFT_CONFIRM_PREFIX,
  SHIFT_CANCEL_PREFIX,
  SHIFT_TIME_PREFIX,
  handleShiftToggle,
  handleShiftConfirm,
  handleShiftCancel,
  handleShiftTime,
} from "./commands";
import { buildSheetEmbed, buildSheetThreadName, findSelfIntro } from "./commands/sheet";
import { getShiftSettings, getShiftCountsByUser } from "./lib/shift";

import { logger } from "./lib/logger";
import {
  getVcRewardSettings,
  recordVcJoin,
  clearVcPresence,
  getAllVcPresences,
  payVcReward,
  getVcLogSettings,
  recordVcLogJoin,
  recordVcLogLeave,
} from "./lib/vcReward";
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
  seedDefaultUraShopItems,
  getEvalSheetSettings,
  createEvalSheet,
  getSheetVcSeconds,
  listActiveSheets,
  claimInitialIssue,
  listSheetsNeedingReminder,
  markSheetReminderSent,
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
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates, // required for voiceStateUpdate
    GatewayIntentBits.GuildMessages,         // required for messageCreate
    GatewayIntentBits.MessageContent,        // privileged — enable in Developer Portal
    GatewayIntentBits.GuildEmojisAndStickers, // required for emoji cache (slot setup)
  ],
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
      logger.error(`[vc-expiry] Failed to delete channel ${session.channelId}`, err);
    }

    // Always remove the session record even if channel deletion failed
    // (channel may have already been manually deleted).
    await deletePrivateVcSession(session.id).catch((err) =>
      logger.error(`[vc-expiry] Failed to delete session ${session.id}`, err),
    );
  }
}


// ─── Eval-sheet VC-time periodic refresh ─────────────────────────────────────

let lastSheetVcRefresh = 0;
const SHEET_VC_REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

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
      try {
        const guild = bot.guilds.cache.get(sheet.guildId) ?? await bot.guilds.fetch(sheet.guildId);
        const mem = await guild.members.fetch(sheet.userId).catch(() => null);
        if (mem) displayName = mem.displayName;
      } catch { /* use user displayName */ }

      const settings = await getEvalSheetSettings(sheet.guildId);
      const [vcSeconds, selfIntro] = await Promise.all([
        getSheetVcSeconds(sheet.guildId, sheet.userId, sheet.startDate, sheet.endDate),
        (async () => {
          try {
            const guild = bot.guilds.cache.get(sheet.guildId) ?? await bot.guilds.fetch(sheet.guildId);
            return findSelfIntro(guild, sheet.userId, settings?.rosterCategoryId);
          } catch { return null; }
        })(),
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
    seedDefaultUraShopItems(guild.id).catch((err) =>
      logger.error(`[seed] Failed to seed ura shop items for guild ${guild.id}`, err),
    );
  }

  // Tick every 60 s; actual payout only happens when an interval has elapsed.
  setInterval(() => {
    runRewardScheduler().catch((err) => logger.error("[reward] Scheduler error", err));
    runVcExpiryScheduler().catch((err) => logger.error("[vc-expiry] Scheduler error", err));
    runSheetReminderScheduler(readyClient).catch((err) => logger.error("[sheet-reminder] Scheduler error", err));
    runSheetVcRefreshScheduler(readyClient).catch((err) => logger.error("[sheet-vc] Scheduler error", err));
  }, 60 * 1000);

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
async function handleVcLeave(
  guild: VoiceState["guild"],
  userId: string,
  joinedAt: Date,
): Promise<void> {
  try {
    const [settings, guildSettings] = await Promise.all([
      getVcRewardSettings(guild.id),
      getGuildSettings(guild.id),
    ]);
    const reward = await payVcReward(
      guild.id,
      userId,
      joinedAt,
      guildSettings.currencyName,
      settings,
    );
    if (reward <= 0) return;

    const minutes = Math.floor((Date.now() - joinedAt.getTime()) / 60_000);
    logger.info(
      `[vcsalary] ${userId} in ${guild.id}: +${reward}${guildSettings.currencyName} for ${minutes}min VC`,
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

  // ── Joined VC (from nothing or from AFK) ─────────────────────────────────
  if (isInVc && !isInAfk && (!wasInVc || wasInAfk)) {
    await Promise.all([
      // Reward tracking
      (async () => {
        try {
          const settings = await getVcRewardSettings(guild.id);
          if (settings.ratePerHour > 0 && isEligibleChannel(newState.channelId!, settings.includedCategoryIds, guild)) {
            await recordVcJoin(guild.id, userId, newState.channelId!);
          }
        } catch (err) {
          logger.error(`[vcsalary] recordVcJoin error for ${userId}`, err);
        }
      })(),
      // Session log tracking
      (async () => {
        try {
          const logSettings = await getVcLogSettings(guild.id);
          const catId = getLogCategoryId(newState.channelId!, logSettings.categoryIds, guild);
          if (catId) await recordVcLogJoin(guild.id, userId, newState.channelId!, catId);
        } catch (err) {
          logger.error(`[vclog] recordVcLogJoin error for ${userId}`, err);
        }
      })(),
    ]);
    return;
  }

  // ── Left VC (to nothing or to AFK) ───────────────────────────────────────
  if (wasInVc && !wasInAfk && (!isInVc || isInAfk)) {
    await Promise.all([
      // Reward payout
      (async () => {
        const presence = await clearVcPresence(guild.id, userId).catch((err) => {
          logger.error(`[vcsalary] clearVcPresence error for ${userId}`, err);
          return undefined;
        });
        if (presence) await handleVcLeave(guild, userId, presence.joinedAt);
      })(),
      // Session log
      recordVcLogLeave(guild.id, userId).catch((err) =>
        logger.error(`[vclog] recordVcLogLeave error for ${userId}`, err),
      ),
    ]);
    return;
  }

  // ── Moved between two non-AFK VCs ────────────────────────────────────────
  if (wasInVc && !wasInAfk && isInVc && !isInAfk && oldState.channelId !== newState.channelId) {
    await Promise.all([
      // Reward tracking – category eligibility may have changed
      (async () => {
        try {
          const settings = await getVcRewardSettings(guild.id);
          if (settings.ratePerHour <= 0) return;
          const wasEligible = isEligibleChannel(oldState.channelId!, settings.includedCategoryIds, guild);
          const nowEligible = isEligibleChannel(newState.channelId!, settings.includedCategoryIds, guild);
          if (wasEligible && !nowEligible) {
            const presence = await clearVcPresence(guild.id, userId).catch(() => undefined);
            if (presence) await handleVcLeave(guild, userId, presence.joinedAt);
          } else if (!wasEligible && nowEligible) {
            await recordVcJoin(guild.id, userId, newState.channelId!);
          }
        } catch (err) {
          logger.error(`[vcsalary] channel-move handling error for ${userId}`, err);
        }
      })(),
      // Session log – category eligibility may have changed
      (async () => {
        try {
          const logSettings = await getVcLogSettings(guild.id);
          const wasLogCat = getLogCategoryId(oldState.channelId!, logSettings.categoryIds, guild);
          const nowLogCat = getLogCategoryId(newState.channelId!, logSettings.categoryIds, guild);
          if (wasLogCat && !nowLogCat) {
            await recordVcLogLeave(guild.id, userId);
          } else if (!wasLogCat && nowLogCat) {
            await recordVcLogJoin(guild.id, userId, newState.channelId!, nowLogCat);
          }
          // Both in or both out → no change needed
        } catch (err) {
          logger.error(`[vclog] channel-move log error for ${userId}`, err);
        }
      })(),
    ]);
  }
});

// ─── GuildMemberUpdate — eval sheet auto-creation on role assign ─────────────

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const guildId = newMember.guild.id;

  const addedRoleIds = oldMember.partial
    ? [...newMember.roles.cache.keys()]
    : [...newMember.roles.cache.keys()].filter((id) => !oldMember.roles.cache.has(id));

  if (addedRoleIds.length === 0) return;

  const settings = await getEvalSheetSettings(guildId).catch(() => undefined);
  if (!settings?.forumChannelId || !settings.triggerRoleIds) return;

  const triggerIds = settings.triggerRoleIds.split(",").filter(Boolean);
  const matchedRoleId = addedRoleIds.find((id) => triggerIds.includes(id));
  if (!matchedRoleId) return;

  const forum =
    newMember.guild.channels.cache.get(settings.forumChannelId) ??
    await newMember.guild.channels.fetch(settings.forumChannelId).catch(() => null);

  if (!forum || forum.type !== ChannelType.GuildForum) {
    logger.error(`[sheet] forum channel ${settings.forumChannelId} not found or wrong type`);
    return;
  }

  const evalDays = settings.evalPeriodDays ?? 14;
  const startDate = new Date();
  const endDate = new Date(startDate.getTime() + evalDays * 24 * 60 * 60 * 1000);

  let targetUser;
  try { targetUser = await newMember.client.users.fetch(newMember.id); }
  catch { logger.warn(`[sheet] Could not fetch user ${newMember.id}`); return; }

  const displayName = newMember.displayName;
  const roleName = newMember.guild.roles.cache.get(matchedRoleId)?.name ?? matchedRoleId;

  const [vcSeconds, selfIntro] = await Promise.all([
    getSheetVcSeconds(guildId, newMember.id, startDate, endDate).catch(() => 0),
    findSelfIntro(newMember.guild, newMember.id, settings.rosterCategoryId).catch(() => null),
  ]);

  const embed = buildSheetEmbed({
    targetUser,
    displayName,
    startDate,
    endDate,
    vcSeconds,
    nameboardUrl: settings.nameboardUrl,
    selfIntro,
    createdByLabel: `ロール付与により自動生成（${roleName}）`,
  });

  try {
    const thread = await forum.threads.create({
      name: buildSheetThreadName(displayName, endDate),
      message: { embeds: [embed] },
    });
    await createEvalSheet(guildId, newMember.id, startDate, endDate, forum.id, thread.id);
    logger.info(`[sheet] ✅ Created thread ${thread.id} for user ${newMember.id} on role ${roleName}`);
  } catch (err) {
    logger.error(`[sheet] Failed to create forum thread for user ${newMember.id}`, err);
  }
});

// ─── 初期発行 — テキストトリガー ───────────────────────────────────────────────

const INITIAL_ISSUE_TRIGGER = "初期発行お願いします。";
const INITIAL_ISSUE_AMOUNT  = 1000;

const INITIAL_ISSUE_CHANNEL_ID = "1526673304327291050";

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
    if (!result.ok) return;   // すでに受け取り済み — 無視

    await message.react("✅");
  } catch (err) {
    logger.error("[initial-issue] Error", err);
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

    if (interaction.isButton() && interaction.customId.startsWith(SHOP_BUY_PREFIX)) {
      await handleShopBuyButton(interaction);
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
