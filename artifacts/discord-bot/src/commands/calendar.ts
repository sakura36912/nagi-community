import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type TextChannel,
} from "discord.js";
import {
  addCalendarParticipant,
  createCalendarEvent,
  deleteCalendarEvent,
  getCalendarEvent,
  getCalendarParticipantIds,
  getCalendarSettings,
  isCalendarParticipant,
  listCalendarEvents,
  listCalendarReminderCandidates,
  markCalendar24hReminderSent,
  markCalendarStartReminderSent,
  removeCalendarParticipant,
  setCalendarEventMessageId,
  upsertCalendarSettings,
} from "../lib/calendar.js";
import { logger } from "../lib/logger.js";

const JST = "Asia/Tokyo";
export const CALENDAR_BUTTON_PREFIX = "calendar:";
const CALENDAR_RSVP_PREFIX = `${CALENDAR_BUTTON_PREFIX}rsvp:`;
const CALENDAR_PARTICIPANTS_PREFIX = `${CALENDAR_BUTTON_PREFIX}participants:`;

export function parseJstDateTime(dateText: string, timeText: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText) || !/^\d{2}:\d{2}$/.test(timeText)) return null;
  const date = new Date(`${dateText}T${timeText}:00+09:00`);
  if (Number.isNaN(date.getTime())) return null;
  const roundTrip = new Intl.DateTimeFormat("sv-SE", {
    timeZone: JST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return roundTrip === `${dateText} ${timeText}` ? date : null;
}

export function getMonthRange(monthText?: string): { from: Date; to: Date; label: string } | null {
  const now = new Date();
  const jstNow = new Intl.DateTimeFormat("sv-SE", {
    timeZone: JST,
    year: "numeric",
    month: "2-digit",
  }).format(now);
  const match = (monthText ?? jstNow).match(/^(\d{4})-(\d{1,2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;

  // JST midnight represented as a UTC timestamp.
  const from = new Date(Date.UTC(year, month - 1, 1) - 9 * 60 * 60 * 1000);
  const to = new Date(Date.UTC(year, month, 1) - 9 * 60 * 60 * 1000 - 1);
  return { from, to, label: `${year}年${month}月` };
}

function formatJstDateTime(date: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: JST,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function formatJstDay(date: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: JST,
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(date);
}

function isManageGuild(interaction: ChatInputCommandInteraction): boolean {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

function buildCalendarButtons(eventId: number): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${CALENDAR_RSVP_PREFIX}${eventId}`)
        .setLabel("✅ 参加する / 取り消す")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${CALENDAR_PARTICIPANTS_PREFIX}${eventId}`)
        .setLabel("👥 参加者を見る")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

export function buildEventEmbed(
  event: { id: number; title: string; description: string | null; scheduledAt: Date },
  participantIds: string[],
): EmbedBuilder {
  const timestamp = Math.floor(event.scheduledAt.getTime() / 1000);
  const participantText = participantIds.length > 0
    ? `${participantIds.length}名`
    : "まだいません";
  return new EmbedBuilder()
    .setTitle(`📅 ${event.title}`)
    .setColor(0x5865f2)
    .setDescription(event.description || "説明はありません。")
    .addFields(
      { name: "日時", value: `<t:${timestamp}:F>（${formatJstDateTime(event.scheduledAt)}）`, inline: false },
      { name: "参加予定", value: participantText, inline: true },
      { name: "予定ID", value: `#${event.id}`, inline: true },
    )
    .setFooter({ text: "参加するボタンで参加表明、もう一度押すと取り消しできます" });
}

export function buildMonthEmbed(
  label: string,
  events: Array<{ id: number; title: string; scheduledAt: Date }>,
): EmbedBuilder {
  const byDay = new Map<string, Array<{ id: number; title: string; scheduledAt: Date }>>();
  for (const event of events) {
    const key = new Intl.DateTimeFormat("sv-SE", { timeZone: JST }).format(event.scheduledAt);
    const dayEvents = byDay.get(key) ?? [];
    dayEvents.push(event);
    byDay.set(key, dayEvents);
  }

  const lines = events.length === 0
    ? ["この月に登録された予定はありません。"]
    : [...byDay.entries()].map(([day, dayEvents]) => {
      const date = new Date(`${day}T00:00:00+09:00`);
      const entries = dayEvents
        .map((event) => {
          const timestamp = Math.floor(event.scheduledAt.getTime() / 1000);
          return `• **#${event.id} ${event.title}** — <t:${timestamp}:t>`;
        })
        .join("\n");
      return `**${formatJstDay(date)}**\n${entries}`;
    });

  return new EmbedBuilder()
    .setTitle(`📅 ${label}のカレンダー`)
    .setColor(0x5865f2)
    .setDescription(lines.join("\n\n").slice(0, 4096))
    .setFooter({ text: "詳細は /calendar show 予定ID" });
}

async function getTextChannel(client: Client, guildId: string, channelId: string): Promise<TextChannel | null> {
  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return null;
  const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return null;
  return channel;
}

export async function refreshCalendarEventMessage(client: Client, event: Awaited<ReturnType<typeof getCalendarEvent>>): Promise<boolean> {
  if (!event?.messageId) return false;
  const channel = await getTextChannel(client, event.guildId, event.channelId);
  if (!channel) return false;
  const message = await channel.messages.fetch(event.messageId).catch(() => null);
  if (!message) return false;
  const participantIds = await getCalendarParticipantIds(event.id);
  await message.edit({
    embeds: [buildEventEmbed(event, participantIds)],
    components: buildCalendarButtons(event.id),
    allowedMentions: { parse: [] },
  });
  return true;
}

async function replyNotConfigured(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({
    content: "先に `/calendar setup` で通知チャンネルを設定してください。",
    flags: MessageFlags.Ephemeral,
  });
}

export const calendarCommand = {
  data: new SlashCommandBuilder()
    .setName("calendar")
    .setDescription("gathapin36912の予定・イベントカレンダー")
    .addSubcommand((sub) =>
      sub
        .setName("setup")
        .setDescription("カレンダーの通知先を設定します（管理者）")
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("予定を投稿するテキストチャンネル")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        )
        .addRoleOption((option) =>
          option
            .setName("role")
            .setDescription("通知時にメンションするロール（任意）"),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("create")
        .setDescription("予定を登録します（管理者）")
        .addStringOption((option) =>
          option.setName("title").setDescription("予定名").setMaxLength(100).setRequired(true),
        )
        .addStringOption((option) =>
          option.setName("date").setDescription("JSTの日付（YYYY-MM-DD）").setRequired(true),
        )
        .addStringOption((option) =>
          option.setName("time").setDescription("JSTの時刻（HH:MM）").setRequired(true),
        )
        .addStringOption((option) =>
          option.setName("description").setDescription("予定の内容（任意）").setMaxLength(1000),
        )
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("告知先（未指定ならsetupのチャンネル）")
            .addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("list")
        .setDescription("指定月の予定を表示します")
        .addStringOption((option) =>
          option.setName("month").setDescription("年月（YYYY-MM、省略時は今月）"),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("show")
        .setDescription("予定の詳細を表示します")
        .addIntegerOption((option) =>
          option.setName("id").setDescription("予定ID").setMinValue(1).setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("delete")
        .setDescription("予定を削除します（管理者）")
        .addIntegerOption((option) =>
          option.setName("id").setDescription("予定ID").setMinValue(1).setRequired(true),
        ),
    ),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId || !interaction.guild) {
      await interaction.reply({ content: "このコマンドはサーバー内で使用してください。", flags: MessageFlags.Ephemeral });
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "setup") {
      if (!isManageGuild(interaction)) {
        await interaction.reply({ content: "カレンダー設定はサーバー管理者のみ変更できます。", flags: MessageFlags.Ephemeral });
        return;
      }
      const channel = interaction.options.getChannel("channel", true);
      const role = interaction.options.getRole("role", false);
      await upsertCalendarSettings(interaction.guildId, channel.id, role?.id ?? null);
      await interaction.reply(
        `✅ カレンダー通知先を <#${channel.id}> に設定しました。`
        + (role ? `\n通知時は <@&${role.id}> をメンションします。` : ""),
      );
      return;
    }

    if (subcommand === "create") {
      if (!isManageGuild(interaction)) {
        await interaction.reply({ content: "予定の登録はサーバー管理者のみ実行できます。", flags: MessageFlags.Ephemeral });
        return;
      }
      const dateText = interaction.options.getString("date", true);
      const timeText = interaction.options.getString("time", true);
      const scheduledAt = parseJstDateTime(dateText, timeText);
      if (!scheduledAt) {
        await interaction.reply({
          content: "日時の形式が正しくありません。日付は `YYYY-MM-DD`、時刻は `HH:MM`（日本時間）で入力してください。",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (scheduledAt.getTime() <= Date.now()) {
        await interaction.reply({ content: "過去の日時は登録できません。", flags: MessageFlags.Ephemeral });
        return;
      }

      const configured = await getCalendarSettings(interaction.guildId);
      const selectedChannel = interaction.options.getChannel("channel", false);
      const channelId = selectedChannel?.id ?? configured?.notifyChannelId ?? interaction.channelId;
      if (!channelId) {
        await replyNotConfigured(interaction);
        return;
      }
      const channel = await getTextChannel(interaction.client, interaction.guildId, channelId);
      if (!channel) {
        await interaction.reply({ content: "告知先チャンネルを取得できませんでした。設定を確認してください。", flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const event = await createCalendarEvent({
        guildId: interaction.guildId,
        channelId,
        title: interaction.options.getString("title", true),
        description: interaction.options.getString("description", false),
        scheduledAt,
      });
      try {
        const message = await channel.send({
          embeds: [buildEventEmbed(event, [])],
          components: buildCalendarButtons(event.id),
          allowedMentions: { parse: [] },
        });
        await setCalendarEventMessageId(event.id, message.id);
        await interaction.editReply(`✅ 予定を登録しました（ID: **#${event.id}**）。\n${message.url}`);
      } catch (err) {
        await deleteCalendarEvent(event.id).catch(() => {});
        throw err;
      }
      return;
    }

    if (subcommand === "list") {
      const range = getMonthRange(interaction.options.getString("month", false) ?? undefined);
      if (!range) {
        await interaction.reply({ content: "年月は `YYYY-MM` 形式で指定してください。", flags: MessageFlags.Ephemeral });
        return;
      }
      const events = await listCalendarEvents(interaction.guildId, range.from, range.to);
      await interaction.reply({
        embeds: [buildMonthEmbed(range.label, events)],
        allowedMentions: { parse: [] },
      });
      return;
    }

    const eventId = interaction.options.getInteger("id", true);
    const event = await getCalendarEvent(eventId);
    if (!event || event.guildId !== interaction.guildId) {
      await interaction.reply({ content: "その予定は見つかりません。", flags: MessageFlags.Ephemeral });
      return;
    }

    if (subcommand === "show") {
      const participantIds = await getCalendarParticipantIds(event.id);
      await interaction.reply({
        embeds: [buildEventEmbed(event, participantIds)],
        components: buildCalendarButtons(event.id),
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (subcommand === "delete") {
      if (!isManageGuild(interaction)) {
        await interaction.reply({ content: "予定の削除はサーバー管理者のみ実行できます。", flags: MessageFlags.Ephemeral });
        return;
      }
      if (event.messageId) {
        const channel = await getTextChannel(interaction.client, event.guildId, event.channelId);
        await channel?.messages.delete(event.messageId).catch(() => {});
      }
      await deleteCalendarEvent(event.id);
      await interaction.reply(`✅ 予定 **#${event.id} ${event.title}** を削除しました。`);
    }
  },
};

export async function handleCalendarButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.customId.startsWith(CALENDAR_BUTTON_PREFIX)) return;
  const parts = interaction.customId.split(":");
  const action = parts[1];
  const eventId = Number(parts[2]);
  if (!Number.isInteger(eventId) || eventId < 1) {
    await interaction.reply({ content: "予定IDが正しくありません。", flags: MessageFlags.Ephemeral });
    return;
  }

  const event = await getCalendarEvent(eventId);
  if (!event || event.guildId !== interaction.guildId) {
    await interaction.reply({ content: "この予定は終了または削除されています。", flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === "rsvp") {
    const joined = await isCalendarParticipant(eventId, interaction.user.id);
    if (joined) {
      await removeCalendarParticipant(eventId, interaction.user.id);
      await interaction.reply({ content: "参加表明を取り消しました。", flags: MessageFlags.Ephemeral });
    } else {
      await addCalendarParticipant(eventId, interaction.user.id);
      await interaction.reply({ content: "参加予定に登録しました。", flags: MessageFlags.Ephemeral });
    }
    await refreshCalendarEventMessage(interaction.client, event);
    return;
  }

  if (action === "participants") {
    const participantIds = await getCalendarParticipantIds(eventId);
    const content = participantIds.length === 0
      ? "参加予定者はまだいません。"
      : `参加予定者（${participantIds.length}名）:\n${participantIds.slice(0, 50).map((id) => `<@${id}>`).join("\n")}`;
    await interaction.reply({
      content,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { users: participantIds.slice(0, 50) },
    });
  }
}

export async function runCalendarReminderScheduler(client: Client): Promise<void> {
  const now = new Date();
  const candidates = await listCalendarReminderCandidates(now);
  for (const event of candidates) {
    try {
      const settings = await getCalendarSettings(event.guildId);
      const channelId = settings?.notifyChannelId ?? event.channelId;
      const channel = await getTextChannel(client, event.guildId, channelId);
      if (!channel) continue;

      const eventTime = event.scheduledAt.getTime();
      if (
        eventTime > now.getTime()
        && eventTime - now.getTime() <= 24 * 60 * 60 * 1000 + 60 * 1000
        && !event.reminder24hSentAt
      ) {
        const roleMention = settings?.notifyRoleId ? `<@&${settings.notifyRoleId}> ` : "";
        await channel.send({
          content: `${roleMention}🔔 **${event.title}** は24時間以内です。\n日時: <t:${Math.floor(eventTime / 1000)}:F>`,
          allowedMentions: settings?.notifyRoleId ? { roles: [settings.notifyRoleId] } : { parse: [] },
        });
        await markCalendar24hReminderSent(event.id, now);
        logger.info(`[calendar] Sent 24h reminder for event #${event.id}`);
      } else if (eventTime <= now.getTime() && !event.reminderSentAt) {
        const roleMention = settings?.notifyRoleId ? `<@&${settings.notifyRoleId}> ` : "";
        await channel.send({
          content: `${roleMention}🔔 **${event.title}** の開始時刻です。`,
          allowedMentions: settings?.notifyRoleId ? { roles: [settings.notifyRoleId] } : { parse: [] },
        });
        await markCalendarStartReminderSent(event.id, now);
        logger.info(`[calendar] Sent start reminder for event #${event.id}`);
      }
    } catch (err) {
      logger.error(`[calendar] Failed to process reminder for event #${event.id}`, err);
    }
  }
}