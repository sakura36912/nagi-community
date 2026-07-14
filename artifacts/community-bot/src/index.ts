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
  getEventsNeedingReminder,
  getLobbyChannelId,
  getParticipants,
  isTempVc,
  markReminderSent,
  openSession,
  removeTempVc,
} from "./lib/community.js";
import {
  buildEventEmbed,
  commands,
  COMM_EVENT_JOIN_PREFIX,
  COMM_EVENT_CANCEL_PREFIX,
  COMM_TICKET_CREATE,
  COMM_TICKET_CLOSE_PREFIX,
  COMM_TEMPVC_CREATE,
  handleEventJoin,
  handleEventCancel,
  handleTicketCreate,
  handleTicketClose,
  handleTempVcCreate,
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

  // Close any VC sessions left open from a previous run.
  await closeAllOpenSessions().catch((err) =>
    logger.error("[vc] Failed to close stale sessions", err),
  );

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

    const guild = oldState.guild;
    const channel =
      guild.channels.cache.get(oldChannelId) ??
      (await guild.channels.fetch(oldChannelId).catch(() => null));

    if (!channel) {
      await removeTempVc(oldChannelId).catch(() => {});
      return;
    }

    if (channel.type !== ChannelType.GuildVoice) return;
    if (channel.members.size > 0) return; // still occupied

    try {
      await channel.delete("一時VCが空になりました");
      await removeTempVc(oldChannelId);
      logger.info(`[tempvc] Deleted empty temp VC ${oldChannelId}`);
    } catch (err) {
      logger.error(`[tempvc] Failed to delete temp VC ${oldChannelId}`, err);
    }
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
