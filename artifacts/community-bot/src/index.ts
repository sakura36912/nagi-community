import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
} from "discord.js";
import { logger } from "./lib/logger.js";
import {
  addTempVc,
  closeAllOpenSessions,
  closeSession,
  createSheet,
  getAllTempVcs,
  getEventsNeedingReminder,
  getLobbyChannelId,
  getParticipants,
  getSheetSettings,
  getTempVcRecord,
  getVcTimeInPeriod,
  isTempVc,
  logTempVcDeletion,
  markReminderSent,
  openSession,
  pruneOldTempVcDeletionLogs,
  removeTempVc,
} from "./lib/community.js";
import {
  buildEventEmbed,
  buildSheetEmbed,
  commands,
  COMM_EVENT_JOIN_PREFIX,
  COMM_EVENT_CANCEL_PREFIX,
  COMM_TICKET_CREATE,
  COMM_TICKET_CLOSE_PREFIX,
  COMM_TEMPVC_CREATE,
  COMM_PRIVACY_DELETE_CONFIRM,
  COMM_PRIVACY_DELETE_CANCEL,
  COMM_PRIVACY_OPTOUT_KEEP,
  COMM_PRIVACY_OPTOUT_DELETE,
  COMM_BOTSTATUS_REFRESH,
  handleEventJoin,
  handleEventCancel,
  handleTicketCreate,
  handleTicketClose,
  handleTempVcCreate,
  handlePrivacyDeleteConfirm,
  handlePrivacyDeleteCancel,
  handlePrivacyOptoutKeep,
  handlePrivacyOptoutDelete,
  handleBotstatusRefresh,
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

async function runEventReminderScheduler(): Promise<void> {
  const events = await getEventsNeedingReminder();
  for (const event of events) {
    try {
      const guild = client.guilds.cache.get(event.guildId);
      if (!guild) continue;

      const channel = guild.channels.cache.get(event.channelId)
        ?? await guild.channels.fetch(event.channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) continue;

      const participants = await getParticipants(event.id);
      const mentions = participants.map((id) => `<@${id}>`).join(" ");

      const content =
        participants.length > 0
          ? `🔔 **${event.title}** が30分後に始まります！\n${mentions}`
          : `🔔 **${event.title}** が30分後に始まります！（参加者なし）`;

      await channel.send({ content });

      // Update the event panel message if it still exists.
      if (event.messageId) {
        try {
          const msg = await channel.messages.fetch(event.messageId);
          const { embed, rows } = await buildEventEmbed(event.id);
          await msg.edit({ embeds: [embed], components: rows });
        } catch {
          // message may have been deleted — ignore
        }
      }

      await markReminderSent(event.id);
      logger.info(`[event] Reminder sent for event ${event.id} (${event.title})`);
    } catch (err) {
      logger.error(`[event] Failed to send reminder for event ${event.id}`, err);
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

  // Close any VC sessions left open from a previous run.
  await closeAllOpenSessions().catch((err) =>
    logger.error("[vc] Failed to close stale sessions", err),
  );

  // Clean up stale temp VCs: delete any that no longer exist on Discord or are empty.
  try {
    const tempVcs = await getAllTempVcs();
    for (const record of tempVcs) {
      try {
        const guild =
          readyClient.guilds.cache.get(record.guildId) ??
          await readyClient.guilds.fetch(record.guildId).catch(() => null);
        if (!guild) {
          await logTempVcDeletion(record.guildId, record.channelId, record.channelId, record.ownerId, "stale_guild_gone").catch(() => {});
          await removeTempVc(record.channelId);
          logger.info(`[tempvc] Removed stale temp VC record ${record.channelId} (guild not found)`);
          continue;
        }

        const channel =
          guild.channels.cache.get(record.channelId) ??
          await guild.channels.fetch(record.channelId).catch(() => null);

        if (!channel) {
          // Channel was already deleted — just remove the DB record.
          await logTempVcDeletion(record.guildId, record.channelId, record.channelId, record.ownerId, "stale_channel_gone").catch(() => {});
          await removeTempVc(record.channelId);
          logger.info(`[tempvc] Removed stale temp VC record ${record.channelId} (channel not found)`);
          continue;
        }

        if (channel.type === ChannelType.GuildVoice && channel.members.size === 0) {
          await channel.delete("Bot再起動後の空一時VC削除");
          await logTempVcDeletion(record.guildId, record.channelId, channel.name, record.ownerId, "bot_restart").catch(() => {});
          await removeTempVc(record.channelId);
          logger.info(`[tempvc] Deleted empty temp VC ${record.channelId} on startup`);
        }
      } catch (err) {
        logger.error(`[tempvc] Failed to clean up temp VC ${record.channelId}`, err);
      }
    }
  } catch (err) {
    logger.error("[tempvc] Failed to fetch temp VC list for startup cleanup", err);
  }

  // Re-open sessions for users currently in VCs.
  for (const guild of readyClient.guilds.cache.values()) {
    const lobbyId = await getLobbyChannelId(guild.id).catch(() => null);
    for (const channel of guild.channels.cache.values()) {
      if (channel.type !== ChannelType.GuildVoice) continue;
      if (lobbyId && channel.id === lobbyId) continue; // skip lobby
      for (const [userId] of channel.members) {
        await openSession(guild.id, userId, channel.id).catch(() => {});
      }
    }
  }

  // ── Deletion-log pruning ──────────────────────────────────────────────────
  // Prune entries older than 90 days once on startup, then once every 24 h.
  const RETENTION_DAYS = 90;

  async function runDeletionLogPrune(): Promise<void> {
    try {
      const deleted = await pruneOldTempVcDeletionLogs(RETENTION_DAYS);
      if (deleted > 0) {
        logger.info(`[prune] Removed ${deleted} deletion-log entr${deleted === 1 ? "y" : "ies"} older than ${RETENTION_DAYS} days`);
      }
    } catch (err) {
      logger.error("[prune] Failed to prune deletion log", err);
    }
  }

  await runDeletionLogPrune();
  setInterval(runDeletionLogPrune, 24 * 60 * 60 * 1000);

  // Tick every 60 s.
  setInterval(() => {
    runEventReminderScheduler().catch((err) =>
      logger.error("[event] Reminder scheduler error", err),
    );
  }, 60 * 1000);
});

// ─── VoiceStateUpdate ────────────────────────────────────────────────────────

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guildId = newState.guild.id;
  const userId = newState.id;

  const oldChannelId = oldState.channelId;
  const newChannelId = newState.channelId;

  // Nothing VC-related changed (mute/deaf/etc.)
  if (oldChannelId === newChannelId) return;

  const lobbyId = await getLobbyChannelId(guildId).catch(() => null);

  // ── VC Session tracking ───────────────────────────────────────────────────
  if (oldChannelId && oldChannelId !== lobbyId) {
    await closeSession(guildId, userId).catch((err) =>
      logger.error(`[vc] closeSession error user=${userId}`, err),
    );
  }

  if (newChannelId && newChannelId !== lobbyId) {
    await openSession(guildId, userId, newChannelId).catch((err) =>
      logger.error(`[vc] openSession error user=${userId}`, err),
    );
  }

  // ── Temp VC creation (lobby join) ─────────────────────────────────────────
  if (newChannelId && newChannelId === lobbyId) {
    const guild = newState.guild;
    const me = guild.members.me;
    if (!me?.permissions.has("ManageChannels") || !me.permissions.has("MoveMembers")) {
      logger.warn(`[tempvc] Missing permissions in guild ${guildId}`);
      return;
    }

    const member = newState.member;
    if (!member || member.user.bot) return;

    try {
      const channelName = `🔊 ${member.displayName} の部屋`;
      const lobbyChannel = guild.channels.cache.get(lobbyId);
      const parentId = lobbyChannel?.parentId ?? undefined;

      const newVc = await guild.channels.create({
        name: channelName.slice(0, 100),
        type: ChannelType.GuildVoice,
        parent: parentId,
      });

      await addTempVc(guildId, newVc.id, userId);
      await member.voice.setChannel(newVc);
      logger.info(`[tempvc] Created ${newVc.id} for user ${userId}`);
      // Open a session for the moved user.
      await openSession(guildId, userId, newVc.id).catch(() => {});
    } catch (err) {
      logger.error(`[tempvc] Failed to create temp VC for ${userId}`, err);
    }
    return;
  }

  // ── Temp VC deletion (channel emptied) ───────────────────────────────────
  if (oldChannelId) {
    const isTemp = await isTempVc(oldChannelId).catch(() => false);
    if (!isTemp) return;

    // Fetch record now (before removal) to capture owner info for the audit log.
    const tempVcRecord = await getTempVcRecord(oldChannelId).catch(() => undefined);

    const guild = oldState.guild;
    const channel =
      guild.channels.cache.get(oldChannelId) ??
      (await guild.channels.fetch(oldChannelId).catch(() => null));

    if (!channel) {
      await logTempVcDeletion(
        guildId,
        oldChannelId,
        oldChannelId,
        tempVcRecord?.ownerId ?? "unknown",
        "stale_channel_gone",
      ).catch(() => {});
      await removeTempVc(oldChannelId).catch(() => {});
      return;
    }

    if (channel.type !== ChannelType.GuildVoice) return;
    if (channel.members.size > 0) return; // still occupied

    try {
      await channel.delete("一時VCが空になりました");
      await logTempVcDeletion(
        guildId,
        oldChannelId,
        channel.name,
        tempVcRecord?.ownerId ?? "unknown",
        "empty_leave",
      ).catch(() => {});
      await removeTempVc(oldChannelId);
      logger.info(`[tempvc] Deleted empty temp VC ${oldChannelId}`);
    } catch (err) {
      logger.error(`[tempvc] Failed to delete temp VC ${oldChannelId}`, err);
    }
  }
});

// ─── Nameboard self-intro lookup ─────────────────────────────────────────────

/**
 * Searches every text channel whose name contains "名簿" for the most recent
 * message posted by the given user (up to 500 messages back per channel).
 * Returns the message content, or null if none found.
 */
async function findNameboSelfIntro(
  guild: import("discord.js").Guild,
  userId: string,
): Promise<string | null> {
  const candidates = [...guild.channels.cache.values()].filter(
    (c) => c.name.includes("名簿") && c.isTextBased(),
  );

  for (const channel of candidates) {
    if (!channel.isTextBased()) continue;
    let before: string | undefined;
    for (let page = 0; page < 5; page++) {
      const messages = await channel.messages.fetch({ limit: 100, before }).catch(() => null);
      if (!messages || messages.size === 0) break;
      const found = messages.find((m) => m.author.id === userId && m.content.trim().length > 0);
      if (found) return found.content;
      before = messages.last()?.id;
    }
  }
  return null;
}

// ─── GuildMemberUpdate — auto eval sheet on role assign ─────────────────────

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const guildId = newMember.guild.id;
  logger.info(`[sheet] GuildMemberUpdate user=${newMember.id} guild=${guildId} partial=${oldMember.partial}`);

  // When oldMember is partial its role cache is empty — treat all current roles
  // as candidates and rely on settings check to filter. This matches Discord.js
  // recommended practice for privileged GuildMembers intent events.
  const addedRoleIds = oldMember.partial
    ? [...newMember.roles.cache.keys()]
    : [...newMember.roles.cache.keys()].filter((id) => !oldMember.roles.cache.has(id));

  if (addedRoleIds.length === 0) {
    logger.info(`[sheet] no added roles — skipping`);
    return;
  }

  // Fetch settings and check if forum auto-post is configured
  const settings = await getSheetSettings(guildId).catch(() => undefined);
  if (!settings?.forumChannelId || !settings.triggerRoleIds) {
    logger.info(`[sheet] no forum/role config for guild ${guildId} — skipping`);
    return;
  }

  const triggerIds = settings.triggerRoleIds.split(",").filter(Boolean);
  logger.info(`[sheet] triggerIds=${triggerIds.join(",")} addedRoles=${addedRoleIds.join(",")}`);

  const matchedRole = addedRoleIds.find((id) => triggerIds.includes(id));
  if (!matchedRole) {
    logger.info(`[sheet] no trigger role matched — skipping`);
    return;
  }

  // Find the forum channel — fetch if not cached
  const forum =
    newMember.guild.channels.cache.get(settings.forumChannelId) ??
    await newMember.guild.channels.fetch(settings.forumChannelId).catch(() => null);

  if (!forum) {
    logger.error(`[sheet] forum channel ${settings.forumChannelId} not found`);
    return;
  }
  if (forum.type !== ChannelType.GuildForum) {
    logger.error(`[sheet] channel ${settings.forumChannelId} is type ${forum.type}, expected GuildForum`);
    return;
  }

  // Calculate eval period: start = today (role assigned), end = today + evalDays
  const evalDays = settings.evalPeriodDays ?? 14;
  const startDate = new Date();
  const endDate = new Date(startDate.getTime() + evalDays * 24 * 60 * 60 * 1000);

  // Fetch the Discord User object (needed for avatar URL etc.)
  let targetUser;
  try {
    targetUser = await newMember.client.users.fetch(newMember.id);
  } catch {
    logger.warn(`[sheet] Could not fetch user ${newMember.id}`);
    return;
  }

  const displayName = newMember.displayName;
  const roleName = newMember.guild.roles.cache.get(matchedRole)?.name ?? matchedRole;
  logger.info(`[sheet] Creating sheet for ${displayName} (${newMember.id}), role=${roleName}`);

  const [vcSeconds, selfIntro] = await Promise.all([
    getVcTimeInPeriod(guildId, newMember.id, startDate, endDate).catch(() => 0),
    findNameboSelfIntro(newMember.guild, newMember.id).catch(() => null),
  ]);

  logger.info(`[sheet] selfIntro found=${!!selfIntro} vcSeconds=${vcSeconds}`);

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
      name: `${displayName} — 評価シート`.slice(0, 100),
      message: { embeds: [embed] },
    });
    await createSheet(guildId, newMember.id, startDate, endDate, forum.id, thread.id);
    logger.info(`[sheet] ✅ Created thread ${thread.id} for user ${newMember.id} on role ${roleName}`);
  } catch (err) {
    logger.error(`[sheet] Failed to create forum thread for user ${newMember.id}`, err);
  }
});

// ─── InteractionCreate ───────────────────────────────────────────────────────

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
      if (id === COMM_TICKET_CREATE) {
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
      if (id === COMM_PRIVACY_DELETE_CONFIRM) {
        await handlePrivacyDeleteConfirm(interaction);
        return;
      }
      if (id === COMM_PRIVACY_DELETE_CANCEL) {
        await handlePrivacyDeleteCancel(interaction);
        return;
      }
      if (id === COMM_TEMPVC_CREATE) {
        await handleTempVcCreate(interaction);
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
