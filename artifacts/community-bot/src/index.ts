import {
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  GuildMember,
  MessageFlags,
} from "discord.js";
import { logger } from "./lib/logger.js";
import {
  closeAllOpenSessions,
  closeSession,
  closeSessionAndGetDuration,
  getAllRankingSettings,
  getEvent,
  getEventSettings,
  getEventsNeedingReminder,
  getEventsNeeding24hReminder,
  getEventsNeedingParticipationPoints,
  mark24hReminderSent,
  markParticipationPointsAwarded,
  getParticipants,
  getVcRanking,
  getActiveSessionCount,
  getLeaveLogChannel,
  markReminderSent,
  openSession,
  getVcSessionRetentionDays,
  pruneGuildVcSessions,
  pruneOrphanedVcSessions,
  getTrackedVcCategoryId,
} from "./lib/community.js";
import { runPerGuildVcPrune } from "./lib/vc-prune-scheduler.js";
import { awardVcTime, awardEventParticipation, runRoleTenureBatch } from "./lib/points.js";
import { getPreban } from "@workspace/db";
import {
  buildEventEmbed,
  buildRankingEmbed,
  buildRankingPeriodStart,
  commands,
  type RankingPeriod,
  COMM_EVENT_JOIN_PREFIX,
  COMM_EVENT_CANCEL_PREFIX,
  COMM_TICKET_CREATE,
  COMM_TICKET_CLOSE_PREFIX,
  COMM_TICKET_PANEL_PREFIX,
  COMM_PRIVACY_DELETE_CONFIRM,
  COMM_PRIVACY_DELETE_CANCEL,
  COMM_PRIVACY_OPTOUT_KEEP,
  COMM_PRIVACY_OPTOUT_DELETE,
  COMM_PRIVACY_GLOBAL_OPTOUT_KEEP,
  COMM_PRIVACY_GLOBAL_OPTOUT_DELETE,
  COMM_PRIVACY_ADMIN_DELETE_CONFIRM_PREFIX,
  COMM_PRIVACY_ADMIN_DELETE_CANCEL_PREFIX,
  COMM_BOTSTATUS_REFRESH,
  COMM_RETENTION_CONFIRM_PREFIX,
  COMM_RETENTION_CANCEL_PREFIX,
  handleEventJoin,
  handleEventCancel,
  handleTicketCreate,
  handleTicketClose,
  handlePrivacyDeleteConfirm,
  handlePrivacyDeleteCancel,
  handlePrivacyOptoutKeep,
  handlePrivacyOptoutDelete,
  handlePrivacyGlobalOptoutKeep,
  handlePrivacyGlobalOptoutDelete,
  handlePrivacyAdminDeleteConfirm,
  handlePrivacyAdminDeleteCancel,
  handleBotstatusRefresh,
  handleRoleButton,
  handleRetentionConfirm,
  handleRetentionCancel,
  COMM_ROLEBUTTON_PREFIX,
} from "./commands/index.js";

const token = process.env["COMMUNITY_BOT_TOKEN"];

if (!token) {
  throw new Error("COMMUNITY_BOT_TOKEN environment variable is required.");
}

const commandsByName = new Map(commands.map((c) => [c.data.name, c]));

// Required intents:
//   GuildVoiceStates — for VC tracking and temp VC management
//   GuildMembers     — to fetch member info (privileged; enable in Developer Portal)
//   Guilds           — base intent
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

// ─── Event reminder scheduler ────────────────────────────────────────────────

async function sendEventReminder(
  eventId: number,
  label: string,
  emoji: string,
): Promise<void> {
  const event = await getEvent(eventId);
  if (!event) return;

  const guild = client.guilds.cache.get(event.guildId)
    ?? await client.guilds.fetch(event.guildId).catch(() => null);
  if (!guild) return;

  const participants = await getParticipants(event.id);
  const participantMentions = participants.map((id) => `<@${id}>`).join(" ");

  // Notify channel (if configured) — @role + participant mentions
  const settings = await getEventSettings(event.guildId);
  const notifyCh = settings?.notifyChannelId
    ? (guild.channels.cache.get(settings.notifyChannelId)
        ?? await guild.channels.fetch(settings.notifyChannelId).catch(() => null))
    : null;

  const ts = Math.floor(event.scheduledAt.getTime() / 1000);
  const reminderEmbed = new EmbedBuilder()
    .setTitle(`${emoji} リマインダー: ${event.title}`)
    .setColor(0xf5a623)
    .addFields(
      { name: "🕐 開催日時", value: `<t:${ts}:F>（<t:${ts}:R>）`, inline: false },
      { name: "👥 参加者", value: participants.length > 0 ? participantMentions : "（まだいません）", inline: false },
    );

  const roleMention = settings?.notifyRoleId ? `<@&${settings.notifyRoleId}> ` : "";

  if (notifyCh?.isTextBased()) {
    await notifyCh.send({
      content: `${roleMention}**${event.title}** の${label}リマインダーです！`,
      embeds: [reminderEmbed],
      allowedMentions: { roles: settings?.notifyRoleId ? [settings.notifyRoleId] : [], users: participants },
    });
  }

  // Also post in the event's own channel if different from notify channel
  const eventCh = guild.channels.cache.get(event.channelId)
    ?? await guild.channels.fetch(event.channelId).catch(() => null);
  if (eventCh?.isTextBased() && eventCh.id !== notifyCh?.id) {
    const content = participants.length > 0
      ? `${emoji} **${event.title}** の${label}リマインダー！\n${participantMentions}`
      : `${emoji} **${event.title}** の${label}リマインダー！（参加者なし）`;
    await eventCh.send({ content });
  }

  // Update the event panel embed
  if (event.messageId && eventCh?.isTextBased()) {
    try {
      const msg = await eventCh.messages.fetch(event.messageId).catch(() => null);
      if (msg) {
        const { embed, rows } = await buildEventEmbed(event.id);
        await msg.edit({ embeds: [embed], components: rows });
      }
    } catch { /* ignore */ }
  }
}

async function runEventReminderScheduler(): Promise<void> {
  // 30-minute reminder
  const soon = await getEventsNeedingReminder();
  for (const event of soon) {
    try {
      await sendEventReminder(event.id, "30分前", "🔔");
      await markReminderSent(event.id);
      logger.info(`[event] 30 min reminder sent for event ${event.id} (${event.title})`);
    } catch (err) {
      logger.error(`[event] Failed to send 30 min reminder for event ${event.id}`, err);
    }
  }

  // 24-hour reminder
  const tomorrow = await getEventsNeeding24hReminder();
  for (const event of tomorrow) {
    try {
      await sendEventReminder(event.id, "24時間前", "📅");
      await mark24hReminderSent(event.id);
      logger.info(`[event] 24 h reminder sent for event ${event.id} (${event.title})`);
    } catch (err) {
      logger.error(`[event] Failed to send 24 h reminder for event ${event.id}`, err);
    }
  }
}

// ─── ClientReady ─────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async (readyClient) => {
  logger.info(`Community Bot logged in as ${readyClient.user.tag}`);

  // ── Invite URL & per-guild permission check ───────────────────────────────
  // Permissions required for full functionality:
  //   VIEW_CHANNEL      (1024)   — see channels for reminders / ticket threads
  //   SEND_MESSAGES     (2048)   — send event reminders and ticket messages
  //   EMBED_LINKS       (16384)  — send rich embeds for events
  //   READ_MESSAGE_HISTORY (65536) — fetch posted event messages for edits
  //   MANAGE_CHANNELS   (16)     — create/delete temp VCs and ticket channels
  //   MOVE_MEMBERS      (16777216) — move users into the new temp VC
  const REQUIRED_PERMISSIONS = 16862224n; // bigint for PermissionsBitField
  const inviteUrl =
    `https://discord.com/api/oauth2/authorize` +
    `?client_id=${readyClient.user.id}` +
    `&permissions=${REQUIRED_PERMISSIONS}` +
    `&scope=bot%20applications.commands`;
  logger.info(`[invite] Invite URL (ManageChannels + MoveMembers + messaging): ${inviteUrl}`);

  if (readyClient.guilds.cache.size === 0) {
    logger.warn("[invite] Bot is not in any guild. Use the invite URL above to add it to your server.");
  } else {
    for (const guild of readyClient.guilds.cache.values()) {
      const me = guild.members.me;
      if (!me) {
        logger.warn(`[permissions] guild=${guild.name} (${guild.id}): could not fetch bot member`);
        continue;
      }
      const hasManageChannels = me.permissions.has("ManageChannels");
      const hasMoveMembers   = me.permissions.has("MoveMembers");
      if (hasManageChannels && hasMoveMembers) {
        logger.info(
          `[permissions] guild=${guild.name} (${guild.id}): ✓ ManageChannels ✓ MoveMembers — OK`,
        );
      } else {
        logger.warn(
          `[permissions] guild=${guild.name} (${guild.id}): ` +
          `ManageChannels=${hasManageChannels} MoveMembers=${hasMoveMembers} — ` +
          `MISSING PERMISSIONS. Grant them in Server Settings → Roles → Community Bot.`,
        );
      }
    }
  }

  // ── GuildMembers privileged intent check ─────────────────────────────────
  // The bot requests GuildMembers, but Discord only honours it when the toggle
  // is enabled in the Developer Portal.  We detect a silent failure by fetching
  // a small member batch from the first available guild: if the guild has more
  // than one member but the fetch returns only the bot itself, the intent is
  // almost certainly inactive.
  {
    const checkGuild = readyClient.guilds.cache.first();
    if (checkGuild) {
      try {
        const fetched = await checkGuild.members.fetch({ limit: 10 });
        // guild.memberCount is the authoritative Discord-reported count.
        // If it is > 1 but we can only see ≤ 1 member, the intent was ignored.
        const reportedCount = checkGuild.memberCount ?? 0;
        if (reportedCount > 1 && fetched.size <= 1) {
          logger.warn(
            "[intent] GuildMembers privileged intent does not appear to be active. " +
            "Member-related features (temp VC names, ticket attribution, leaderboard display) " +
            "will not work correctly. " +
            "Enable it at: Discord Developer Portal → Your App → Bot → Privileged Gateway Intents → Server Members Intent.",
          );
        } else {
          logger.info(
            `[intent] GuildMembers intent check passed (fetched ${fetched.size} member(s), guild reports ${reportedCount}).`,
          );
        }
      } catch (err) {
        logger.warn(
          "[intent] Could not verify GuildMembers intent — member fetch failed. " +
          "Ensure the Server Members Intent is enabled in the Discord Developer Portal.",
          err,
        );
      }
    } else {
      logger.info("[intent] Skipping GuildMembers intent check — bot is not in any guild yet.");
    }
  }

  // Close any VC sessions left open from a previous run.
  await closeAllOpenSessions().catch((err) =>
    logger.error("[vc] Failed to close stale sessions", err),
  );

  // Re-open sessions for users currently in VCs.
  for (const guild of readyClient.guilds.cache.values()) {
    for (const channel of guild.channels.cache.values()) {
      if (channel.type !== ChannelType.GuildVoice) continue;
      for (const [userId] of channel.members) {
        await openSession(guild.id, userId, channel.id).catch(() => {});
      }
    }
  }

  // ── Daily ranking post ────────────────────────────────────────────────────
  // Fires once a day at midnight JST (UTC+9 = 15:00 UTC).
  // On startup we schedule the first fire at the next 15:00 UTC, then repeat every 24 h.
  async function postDailyRankings(): Promise<void> {
    const configs = await getAllRankingSettings().catch(() => []);
    for (const config of configs) {
      if (!config.channelId) continue;
      try {
        const guild = readyClient.guilds.cache.find((g) =>
          g.id === config.guildId,
        ) ?? await readyClient.guilds.fetch(config.guildId).catch(() => null);
        if (!guild) continue;

        const channel = guild.channels.cache.get(config.channelId)
          ?? await guild.channels.fetch(config.channelId).catch(() => null);
        if (!channel?.isTextBased()) continue;

        const period = (config.period ?? "today") as RankingPeriod;
        const periodStart = buildRankingPeriodStart(period);
        const [ranking, activeCount] = await Promise.all([
          getVcRanking(guild.id, periodStart),
          getActiveSessionCount(guild.id),
        ]);

        if (ranking.length === 0) {
          logger.info(`[ranking] No VC records for guild ${guild.id} — skipping daily post`);
          continue;
        }

        const embed = buildRankingEmbed(ranking, activeCount, period);
        await channel.send({ embeds: [embed] });
        logger.info(`[ranking] Posted daily ranking to ${config.channelId} in guild ${config.guildId}`);
      } catch (err) {
        logger.error(`[ranking] Failed to post daily ranking for guild ${config.guildId}`, err);
      }
    }
  }

  // Schedule next midnight JST (= 15:00 UTC). If 15:00 UTC has already passed
  // today, schedule for tomorrow.
  function scheduleDailyRanking(): void {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(15, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const delay = next.getTime() - now.getTime();
    logger.info(`[ranking] Next daily post in ${Math.round(delay / 60000)} min (${next.toISOString()})`);
    setTimeout(() => {
      postDailyRankings().catch((err) => logger.error("[ranking] Daily post error", err));
      setInterval(() => {
        postDailyRankings().catch((err) => logger.error("[ranking] Daily post error", err));
      }, 24 * 60 * 60 * 1000);
    }, delay);
  }

  scheduleDailyRanking();

  // ── Daily role-tenure point batch ─────────────────────────────────────────
  // Runs once a day at the same time as the ranking post (midnight JST = 15:00 UTC).
  // Iterates all guilds, awards pointsPerDay to members holding tracked roles.
  async function runRoleTenureForAllGuilds(): Promise<void> {
    for (const guild of readyClient.guilds.cache.values()) {
      try {
        await guild.members.fetch(); // ensure cache is populated
        const members = guild.members.cache.map((m) => ({
          userId: m.id,
          roleIds: m.roles.cache.map((r) => r.id),
        }));
        const awarded = await runRoleTenureBatch(guild.id, members);
        if (awarded > 0) {
          logger.info(`[point/role] Awarded ${awarded} pts total for role tenure in guild ${guild.id}`);
        }
      } catch (err) {
        logger.error(`[point/role] Role tenure batch error in guild ${guild.id}`, err);
      }
    }
  }

  function scheduleRoleTenureBatch(): void {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(15, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const delay = next.getTime() - now.getTime();
    setTimeout(() => {
      runRoleTenureForAllGuilds().catch((err) => logger.error("[point/role] Batch error", err));
      setInterval(() => {
        runRoleTenureForAllGuilds().catch((err) => logger.error("[point/role] Batch error", err));
      }, 24 * 60 * 60 * 1000);
    }, delay);
  }

  scheduleRoleTenureBatch();

  // ── VC session pruning ────────────────────────────────────────────────────
  // Delete completed sessions older than the per-guild retention window
  // (defaulting to 180 days) immediately on startup, then repeat every 24 h
  // to keep the table from growing unbounded.
  //
  // Strategy:
  //   • For each guild the bot is currently in, fetch the guild's custom
  //     retention window (or 180 if unset) and prune only that guild's rows.
  //   • As a catch-all, also run a global prune at 180 days to clean up
  //     sessions belonging to guilds the bot has since left.
  async function runVcSessionPrune(): Promise<void> {
    // Per-guild prune using each guild's custom retention window.
    await runPerGuildVcPrune(
      [...readyClient.guilds.cache.keys()],
      getVcSessionRetentionDays,
      pruneGuildVcSessions,
    );

    // Catch-all: prune sessions from guilds the bot has left (orphans only).
    // Uses 180-day window. Scoped to guild IDs NOT in the current cache so
    // active guilds with a retention > 180 days are never touched here.
    try {
      const activeGuildIds = [...readyClient.guilds.cache.keys()];
      const deleted = await pruneOrphanedVcSessions(activeGuildIds, 180);
      if (deleted > 0) {
        logger.info(`[vc/prune] Pruned ${deleted} orphaned VC session(s) (>180 days, bot-left guilds only)`);
      }
    } catch (err) {
      logger.error("[vc/prune] Failed to run orphan VC session prune", err);
    }
  }

  runVcSessionPrune();
  setInterval(runVcSessionPrune, 24 * 60 * 60 * 1000);

  // Tick every 60 s.
  setInterval(() => {
    runEventReminderScheduler().catch((err) =>
      logger.error("[event] Reminder scheduler error", err),
    );
    // Award event participation points for events that have now passed.
    runEventParticipationAward().catch((err) =>
      logger.error("[point/event] Participation award error", err),
    );
  }, 60 * 1000);

  async function runEventParticipationAward(): Promise<void> {
    const events = await getEventsNeedingParticipationPoints();
    for (const event of events) {
      try {
        const participants = await getParticipants(event.id);
        if (participants.length > 0) {
          const count = await awardEventParticipation(
            event.guildId,
            participants,
            event.id,
            event.title,
          );
          if (count > 0) {
            logger.info(
              `[point/event] Awarded participation pts for event ${event.id} "${event.title}" to ${count} user(s) in guild ${event.guildId}`,
            );
          }
        }
        await markParticipationPointsAwarded(event.id);
      } catch (err) {
        logger.error(`[point/event] Failed for event ${event.id}`, err);
      }
    }
  }
});

// ─── GuildMemberAdd（事前BAN自動実行）────────────────────────────────────────

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    const preban = await getPreban(member.guild.id, member.id);
    if (!preban) return;

    const reason = preban.reason ?? "事前BANリストによる自動BAN";
    await member.ban({ reason });
    logger.info(`[preban] ✅ Auto-banned ${member.id} on join in guild ${member.guild.id} — ${reason}`);
  } catch (err) {
    logger.error(`[preban] Failed to auto-ban ${member.id} in guild ${member.guild.id}`, err);
  }
});

// ─── GuildMemberRemove ───────────────────────────────────────────────────────

client.on(Events.GuildMemberRemove, async (member) => {
  try {
    const channelId = await getLeaveLogChannel(member.guild.id);
    if (!channelId) return;

    const ch = member.guild.channels.cache.get(channelId)
      ?? await member.guild.channels.fetch(channelId).catch(() => null);
    if (!ch?.isTextBased()) return;

    const user = member.user;
    const joinedAt = member.joinedAt;
    const roles = member.roles.cache
      .filter((r) => r.id !== member.guild.id)
      .map((r) => `<@&${r.id}>`)
      .join(" ") || "なし";

    const embed = new EmbedBuilder()
      .setTitle("👋 メンバー退出")
      .setColor(0x95a5a6)
      .setThumbnail(user.displayAvatarURL())
      .addFields(
        { name: "ユーザー", value: `<@${user.id}> (${user.tag})`, inline: false },
        { name: "アカウント作成", value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`, inline: true },
        { name: "参加日", value: joinedAt ? `<t:${Math.floor(joinedAt.getTime() / 1000)}:R>` : "不明", inline: true },
        { name: "ロール", value: roles, inline: false },
      )
      .setFooter({ text: `ID: ${user.id}` })
      .setTimestamp();

    await ch.send({ embeds: [embed] });
  } catch (err) {
    logger.error(`[leavelog] Failed for guild ${member.guild.id}`, err);
  }
});

// ─── VoiceStateUpdate ────────────────────────────────────────────────────────

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guildId = newState.guild.id;
  const userId = newState.id;

  const oldChannelId = oldState.channelId;
  const newChannelId = newState.channelId;

  // Nothing VC-related changed (mute/deaf/etc.)
  if (oldChannelId === newChannelId) return;

  // ── VC Session tracking ───────────────────────────────────────────────────
  if (oldChannelId) {
    const duration = await closeSessionAndGetDuration(guildId, userId).catch((err) => {
      logger.error(`[vc] closeSession error user=${userId}`, err);
      return null;
    });
    if (duration !== null && duration > 0) {
      awardVcTime(guildId, userId, duration).catch((err) =>
        logger.error(`[point] awardVcTime error user=${userId}`, err),
      );
    }
  }

  if (newChannelId) {
    // Fail closed: if the tracked-category setting cannot be read we must not
    // assume "track everything" (null = no restriction).  An unreadable setting
    // could mean the admin configured a category restriction that we cannot
    // verify, so skip opening the session and log the error.
    let trackedCategoryId: string | null;
    try {
      trackedCategoryId = await getTrackedVcCategoryId(guildId);
    } catch (err) {
      logger.error(`[vc] getTrackedVcCategoryId error guildId=${guildId} user=${userId}`, err);
      return;
    }
    const channelParentId = newState.channel?.parentId ?? null;
    const isTracked = !trackedCategoryId || channelParentId === trackedCategoryId;
    if (isTracked) {
      await openSession(guildId, userId, newChannelId).catch((err) =>
        logger.error(`[vc] openSession error user=${userId}`, err),
      );
    }
  }
});

// ─── Nameboard self-intro lookup ─────────────────────────────────────────────

// ─── InteractionCreate ───────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = commandsByName.get(interaction.commandName);
      if (!command) {
        logger.warn(`Unknown command: ${interaction.commandName}`);
        return;
      }
      // 島民・追放者ロール制限: vc時間のみ許可（スタッフロールは免除）
      if (interaction.inGuild()) {
        const member = interaction.member as GuildMember;
        const EXEMPT_ROLES    = ["守門卿", "門番", "門番見習い", "航海士", "提督", "大提督"];
        const RESTRICTED_ROLES = ["島民", "追放者"];
        const RESTRICTED_ALLOWED = new Set(["vc時間", "vcランク"]);
        const isExempt = EXEMPT_ROLES.some((name) =>
          interaction.guild?.roles.cache.some((r) => r.name === name && member.roles.cache.has(r.id)),
        );
        const hasRestrictedRole = !isExempt && RESTRICTED_ROLES.some((name) =>
          interaction.guild?.roles.cache.some((r) => r.name === name && member.roles.cache.has(r.id)),
        );
        if (hasRestrictedRole && !RESTRICTED_ALLOWED.has(interaction.commandName)) {
          await interaction.reply({ content: "このロールでは `/vc時間` のみ使用できます。", ephemeral: true });
          return;
        }
      }
      await command.execute(interaction);
      return;
    }

    if (interaction.isButton()) {
      const id = interaction.customId;

      if (id.startsWith(COMM_EVENT_JOIN_PREFIX)) {
        await handleEventJoin(interaction);
        return;
      }
      if (id.startsWith(COMM_EVENT_CANCEL_PREFIX)) {
        await handleEventCancel(interaction);
        return;
      }
      if (id === COMM_TICKET_CREATE || id.startsWith(COMM_TICKET_PANEL_PREFIX)) {
        await handleTicketCreate(interaction);
        return;
      }
      if (id.startsWith(COMM_TICKET_CLOSE_PREFIX)) {
        await handleTicketClose(interaction);
        return;
      }
      if (id === COMM_BOTSTATUS_REFRESH) {
        await handleBotstatusRefresh(interaction);
        return;
      }
      if (id === COMM_PRIVACY_OPTOUT_KEEP) {
        await handlePrivacyOptoutKeep(interaction);
        return;
      }
      if (id === COMM_PRIVACY_OPTOUT_DELETE) {
        await handlePrivacyOptoutDelete(interaction);
        return;
      }
      if (id === COMM_PRIVACY_GLOBAL_OPTOUT_KEEP) {
        await handlePrivacyGlobalOptoutKeep(interaction);
        return;
      }
      if (id === COMM_PRIVACY_GLOBAL_OPTOUT_DELETE) {
        await handlePrivacyGlobalOptoutDelete(interaction);
        return;
      }
      if (id === COMM_PRIVACY_DELETE_CONFIRM) {
        await handlePrivacyDeleteConfirm(interaction);
        return;
      }
      if (id === COMM_PRIVACY_DELETE_CANCEL) {
        await handlePrivacyDeleteCancel(interaction);
        return;
      }
      if (id.startsWith(COMM_PRIVACY_ADMIN_DELETE_CONFIRM_PREFIX)) {
        await handlePrivacyAdminDeleteConfirm(interaction);
        return;
      }
      if (id.startsWith(COMM_PRIVACY_ADMIN_DELETE_CANCEL_PREFIX)) {
        await handlePrivacyAdminDeleteCancel(interaction);
        return;
      }
      if (id.startsWith(COMM_RETENTION_CONFIRM_PREFIX)) {
        await handleRetentionConfirm(interaction);
        return;
      }
      if (id.startsWith(COMM_RETENTION_CANCEL_PREFIX)) {
        await handleRetentionCancel(interaction);
        return;
      }
      if (id.startsWith(COMM_ROLEBUTTON_PREFIX)) {
        await handleRoleButton(interaction);
        return;
      }
    }
  } catch (err) {
    logger.error("Error handling interaction", err);
    const errorMsg = err instanceof Error ? err.message : "処理中にエラーが発生しました。";
    if (interaction.isRepliable()) {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: errorMsg, flags: MessageFlags.Ephemeral }).catch(() => {});
      } else {
        await interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  }
});

// ─── Login ───────────────────────────────────────────────────────────────────

// Required bot permissions (set in OAuth2 invite URL):
//   ManageChannels — create/delete temp VCs and ticket channels
//   MoveMembers    — move users to temp VC after creation
//   GuildMembers privileged intent must be enabled in Discord Developer Portal.

client.login(token).catch((err) => {
  logger.error("Failed to log in to Discord", err);
  process.exit(1);
});
