import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type OverwriteResolvable,
  type User,
} from "discord.js";
import { logger } from "../lib/logger.js";
import {
  addParticipant,
  createEvent,
  deleteEvent,
  editEvent,
  createRoleButton,
  createSheet,
  createTicket,
  deleteRoleButtonsByMessage,
  getEvent,
  getParticipants,
  deleteUserVcSessions,
  getActiveSession,
  getActiveSessionCount,
  getRoleButtonById,
  getRoleButtonsByMessage,
  getEventSettings,
  getSheetSettings,
  getTicketByChannel,
  getTicketSettings,
  getUserVcRank,
  getVcRanking,
  getVcTimeInPeriod,
  isVcTrackingOptedOut,
  listRoleButtonPanels,
  listSheets,
  listUpcomingEvents,
  setEventSettings,
  removeParticipant,
  removeTicket,
  setNameboardUrl,
  setRankingSettings,
  setSheetForumConfig,
  setStaffRole,
  setTicketMessages,
  setTicketRenameRole,
  setVcPrivacyOptOut,
  updateEventMessageId,
} from "../lib/community.js";

// ─── Prefix constants ────────────────────────────────────────────────────────

export const COMM_EVENT_JOIN_PREFIX = "comm:event:join:";
export const COMM_EVENT_CANCEL_PREFIX = "comm:event:cancel:";
export const COMM_TICKET_CREATE = "comm:ticket:create";
export const COMM_TICKET_CLOSE_PREFIX = "comm:ticket:close:";
export const COMM_PRIVACY_DELETE_CONFIRM = "comm:privacy:delete:confirm";
export const COMM_PRIVACY_DELETE_CANCEL = "comm:privacy:delete:cancel";
export const COMM_PRIVACY_OPTOUT_KEEP = "comm:privacy:optout:keep";
export const COMM_PRIVACY_OPTOUT_DELETE = "comm:privacy:optout:delete";
export const COMM_BOTSTATUS_REFRESH = "comm:botstatus:refresh";

// ─── Helpers ────────────────────────────────────────────────────────────────

interface Command {
  data: { name: string; toJSON: () => unknown };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

function requireGuild(interaction: ChatInputCommandInteraction): string {
  if (!interaction.guildId) throw new Error("このコマンドはサーバー内でのみ使用できます。");
  return interaction.guildId;
}

function requireAdmin(interaction: ChatInputCommandInteraction): boolean {
  return !!interaction.memberPermissions?.has("Administrator");
}

function formatSeconds(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}時間${m}分`;
}

function parseDate(str: string): Date | null {
  // Accept "YYYY-MM-DD" or "YYYY-MM-DD HH:MM"
  const match = str.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}))?$/);
  if (!match) return null;
  const [, y, mo, d, h = "00", mi = "00"] = match;
  const dt = new Date(`${y}-${mo}-${d}T${h}:${mi}:00+09:00`);
  return isNaN(dt.getTime()) ? null : dt;
}

// ─── Event embed builder ─────────────────────────────────────────────────────

export async function buildEventEmbed(eventId: number, guild?: Guild): Promise<{ embed: EmbedBuilder; rows: ActionRowBuilder<ButtonBuilder>[] }> {
  const event = await getEvent(eventId);
  if (!event) throw new Error("イベントが見つかりません");
  const participants = await getParticipants(eventId);
  const ts = Math.floor(event.scheduledAt.getTime() / 1000);
  const mentionList =
    participants.length > 0
      ? participants.slice(0, 20).map((id) => `<@${id}>`).join(" ") +
        (participants.length > 20 ? ` 他 ${participants.length - 20}名` : "")
      : "（まだいません）";

  const embed = new EmbedBuilder()
    .setTitle(`📅 ${event.title}`)
    .setColor(0x5865f2)
    .addFields(
      { name: "📝 説明", value: event.description ?? "なし", inline: false },
      { name: "🕐 日時", value: `<t:${ts}:F>（<t:${ts}:R>）`, inline: false },
      { name: `👥 参加者 (${participants.length}名)`, value: mentionList, inline: false },
    )
    .setFooter({ text: `イベントID: ${event.id}` });

  const rows = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${COMM_EVENT_JOIN_PREFIX}${eventId}`)
        .setLabel("参加する ✅")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${COMM_EVENT_CANCEL_PREFIX}${eventId}`)
        .setLabel("キャンセル ❌")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];

  return { embed, rows };
}

// ─── /ranking ────────────────────────────────────────────────────────────────

const RANKING_PERIOD_CHOICES = [
  { name: "今日", value: "today" },
  { name: "今週", value: "week" },
  { name: "今月", value: "month" },
  { name: "全期間", value: "all" },
] as const;

export type RankingPeriod = "today" | "week" | "month" | "all";

export function buildRankingPeriodStart(period: RankingPeriod): Date | undefined {
  const now = new Date();
  if (period === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (period === "week") {
    const d = new Date(now);
    d.setDate(d.getDate() - d.getDay());
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (period === "month") {
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }
  return undefined; // "all"
}

export const RANKING_PERIOD_LABELS: Record<RankingPeriod, string> = {
  today: "今日",
  week: "今週",
  month: "今月",
  all: "全期間",
};

export function buildRankingEmbed(
  ranking: { userId: string; totalSeconds: number }[],
  activeCount: number,
  period: RankingPeriod,
): EmbedBuilder {
  const medals = ["🥇", "🥈", "🥉"];
  const lines = ranking.map((entry, i) => {
    const prefix = medals[i] ?? `**${i + 1}.**`;
    return `${prefix} <@${entry.userId}> — ${formatSeconds(entry.totalSeconds)}`;
  });
  const liveIndicator = activeCount > 0
    ? `🔴 現在 ${activeCount}名 がVC参加中（スコアはリアルタイム集計）`
    : "（現在VC参加者なし）";

  return new EmbedBuilder()
    .setTitle(`🎙️ VC滞在時間ランキング（${RANKING_PERIOD_LABELS[period]}）`)
    .setColor(0xf5a623)
    .setDescription(lines.join("\n"))
    .setFooter({ text: liveIndicator })
    .setTimestamp();
}

const rankingCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("ranking")
    .setDescription("VC滞在時間のランキングを表示・設定します")
    .addSubcommand((sub) =>
      sub
        .setName("show")
        .setDescription("VC滞在時間のランキングを表示します")
        .addStringOption((opt) =>
          opt
            .setName("period")
            .setDescription("集計期間")
            .setRequired(false)
            .addChoices(...RANKING_PERIOD_CHOICES),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("setup")
        .setDescription("毎日0時に自動投稿するチャンネルと集計期間を設定します（管理者用）")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("投稿先チャンネル")
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText),
        )
        .addStringOption((opt) =>
          opt
            .setName("period")
            .setDescription("集計期間（デフォルト: 今日）")
            .setRequired(false)
            .addChoices(...RANKING_PERIOD_CHOICES),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("disable").setDescription("毎日の自動投稿を停止します（管理者用）"),
    ),

  async execute(interaction) {
    const guildId = requireGuild(interaction);
    const sub = interaction.options.getSubcommand();

    // ── show ──────────────────────────────────────────────────────────────────
    if (sub === "show") {
      await interaction.deferReply();
      const period = (interaction.options.getString("period") ?? "all") as RankingPeriod;
      const periodStart = buildRankingPeriodStart(period);

      const [ranking, activeCount] = await Promise.all([
        getVcRanking(guildId, periodStart),
        getActiveSessionCount(guildId),
      ]);

      if (ranking.length === 0) {
        await interaction.editReply("まだVC滞在記録がありません。");
        return;
      }

      await interaction.editReply({ embeds: [buildRankingEmbed(ranking, activeCount, period)] });
      return;
    }

    // ── setup / disable — admin only ──────────────────────────────────────────
    if (!requireAdmin(interaction)) {
      await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
      return;
    }

    if (sub === "setup") {
      const channel = interaction.options.getChannel("channel", true);
      const period = (interaction.options.getString("period") ?? "today") as RankingPeriod;
      await setRankingSettings(guildId, channel.id, period);
      await interaction.reply({
        content: `毎日0時（JST）に <#${channel.id}> へ **${RANKING_PERIOD_LABELS[period]}** のランキングを投稿します。`,
        ephemeral: true,
      });
      return;
    }

    if (sub === "disable") {
      await setRankingSettings(guildId, null, "today");
      await interaction.reply({ content: "毎日のランキング自動投稿を停止しました。", ephemeral: true });
      return;
    }
  },
};

// ─── /event ──────────────────────────────────────────────────────────────────

const eventCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("event")
    .setDescription("イベントの管理")
    .addSubcommand((sub) =>
      sub
        .setName("create")
        .setDescription("新しいイベントを作成します（管理者）")
        .addStringOption((opt) =>
          opt.setName("title").setDescription("イベントタイトル").setRequired(true).setMaxLength(100),
        )
        .addStringOption((opt) =>
          opt.setName("datetime").setDescription("開催日時（YYYY-MM-DD HH:MM 形式、日本時間）").setRequired(true),
        )
        .addStringOption((opt) =>
          opt.setName("description").setDescription("イベントの説明").setRequired(false).setMaxLength(1000),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("edit")
        .setDescription("イベントを編集します（管理者）")
        .addIntegerOption((opt) =>
          opt.setName("id").setDescription("イベントID（/event list で確認）").setRequired(true),
        )
        .addStringOption((opt) =>
          opt.setName("title").setDescription("新しいタイトル").setRequired(false).setMaxLength(100),
        )
        .addStringOption((opt) =>
          opt.setName("datetime").setDescription("新しい日時（YYYY-MM-DD HH:MM、日本時間）").setRequired(false),
        )
        .addStringOption((opt) =>
          opt.setName("description").setDescription("新しい説明").setRequired(false).setMaxLength(1000),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("delete")
        .setDescription("イベントを削除します（管理者）")
        .addIntegerOption((opt) =>
          opt.setName("id").setDescription("イベントID（/event list で確認）").setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName("list").setDescription("予定イベントの一覧を表示します"))
    .addSubcommand((sub) =>
      sub
        .setName("notify")
        .setDescription("イベント告知チャンネルとメンションロールを設定します（管理者）")
        .addChannelOption((opt) =>
          opt.setName("channel").setDescription("告知先チャンネル").setRequired(false)
            .addChannelTypes(ChannelType.GuildText),
        )
        .addRoleOption((opt) =>
          opt.setName("role").setDescription("告知時にメンションするロール").setRequired(false),
        ),
    ),

  async execute(interaction) {
    const guildId = requireGuild(interaction);
    const sub = interaction.options.getSubcommand();

    // ── list（誰でも可）──────────────────────────────────────────────────────
    if (sub === "list") {
      await interaction.deferReply({ ephemeral: true });
      const events = await listUpcomingEvents(guildId);
      if (events.length === 0) {
        await interaction.editReply("予定されているイベントはありません。");
        return;
      }
      const lines = events.map((e) => {
        const ts = Math.floor(e.scheduledAt.getTime() / 1000);
        return `• **[ID:${e.id}] ${e.title}** — <t:${ts}:F>（<t:${ts}:R>）`;
      });
      const embed = new EmbedBuilder()
        .setTitle("📅 予定イベント一覧")
        .setColor(0x5865f2)
        .setDescription(lines.join("\n"));
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // 以降は管理者のみ
    if (!requireAdmin(interaction)) {
      await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
      return;
    }

    // ── notify ───────────────────────────────────────────────────────────────
    if (sub === "notify") {
      const channel = interaction.options.getChannel("channel");
      const role    = interaction.options.getRole("role");

      if (!channel && !role) {
        const s = await getEventSettings(guildId);
        const embed = new EmbedBuilder()
          .setTitle("📣 イベント通知設定")
          .setColor(0x5865f2)
          .addFields(
            { name: "告知チャンネル", value: s?.notifyChannelId ? `<#${s.notifyChannelId}>` : "未設定", inline: true },
            { name: "メンションロール", value: s?.notifyRoleId ? `<@&${s.notifyRoleId}>` : "未設定", inline: true },
          )
          .setFooter({ text: "channel / role を指定して再実行すると上書きされます。" });
        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      await setEventSettings(guildId, {
        notifyChannelId: channel?.id ?? undefined,
        notifyRoleId:    role?.id    ?? undefined,
      });
      const parts = [
        channel && `告知チャンネル: <#${channel.id}>`,
        role    && `メンションロール: <@&${role.id}>`,
      ].filter(Boolean).join("、");
      await interaction.reply({ content: `✅ ${parts} に設定しました。`, ephemeral: true, allowedMentions: { parse: [] } });
      return;
    }

    // ── create ───────────────────────────────────────────────────────────────
    if (sub === "create") {
      await interaction.deferReply({ ephemeral: true });

      const title       = interaction.options.getString("title", true);
      const datetimeStr = interaction.options.getString("datetime", true);
      const description = interaction.options.getString("description");

      const scheduledAt = parseDate(datetimeStr);
      if (!scheduledAt) {
        await interaction.editReply("日時の形式が正しくありません。例: `2025-01-15 19:00`");
        return;
      }
      if (scheduledAt <= new Date()) {
        await interaction.editReply("過去の日時は設定できません。");
        return;
      }
      if (!interaction.channelId) {
        await interaction.editReply("チャンネルが特定できません。");
        return;
      }

      const event = await createEvent(guildId, interaction.channelId, title, description, scheduledAt);
      const { embed, rows } = await buildEventEmbed(event.id);

      // パネルをコマンド実行チャンネルに投稿
      const msg = interaction.channel?.isSendable()
        ? await interaction.channel.send({ embeds: [embed], components: rows })
        : null;
      if (msg) await updateEventMessageId(event.id, msg.id);

      // 告知チャンネルへのアナウンス
      const settings = await getEventSettings(guildId);
      if (settings?.notifyChannelId) {
        const notifyCh = interaction.guild?.channels.cache.get(settings.notifyChannelId)
          ?? await interaction.guild?.channels.fetch(settings.notifyChannelId).catch(() => null);
        if (notifyCh?.isTextBased()) {
          const ts = Math.floor(scheduledAt.getTime() / 1000);
          const roleMention = settings.notifyRoleId ? `<@&${settings.notifyRoleId}> ` : "";
          const announceEmbed = new EmbedBuilder()
            .setTitle(`📣 新しいイベント: ${title}`)
            .setColor(0x5865f2)
            .addFields(
              { name: "📝 説明", value: description ?? "なし", inline: false },
              { name: "🕐 開催日時", value: `<t:${ts}:F>（<t:${ts}:R>）`, inline: false },
            )
            .setFooter({ text: msg ? `参加はイベントパネルのボタンから` : `イベントID: ${event.id}` });
          await notifyCh.send({
            content: `${roleMention}新しいイベントが作成されました！`,
            embeds: [announceEmbed],
            allowedMentions: { roles: settings.notifyRoleId ? [settings.notifyRoleId] : [] },
          });
        }
      }

      await interaction.editReply(`✅ イベント「${title}」を作成しました。`);
      return;
    }

    // ── edit ────────────────────────────────────────────────────────────────
    if (sub === "edit") {
      await interaction.deferReply({ ephemeral: true });
      const eventId     = interaction.options.getInteger("id", true);
      const title       = interaction.options.getString("title");
      const datetimeStr = interaction.options.getString("datetime");
      const description = interaction.options.getString("description");

      const event = await getEvent(eventId);
      if (!event || event.guildId !== guildId) {
        await interaction.editReply("イベントが見つかりません。");
        return;
      }

      let scheduledAt: Date | undefined;
      if (datetimeStr) {
        scheduledAt = parseDate(datetimeStr) ?? undefined;
        if (!scheduledAt) {
          await interaction.editReply("日時の形式が正しくありません。例: `2025-01-15 19:00`");
          return;
        }
        if (scheduledAt <= new Date()) {
          await interaction.editReply("過去の日時は設定できません。");
          return;
        }
      }

      await editEvent(eventId, { title: title ?? undefined, description, scheduledAt });

      // パネルメッセージを更新
      if (event.messageId) {
        try {
          const ch = interaction.guild?.channels.cache.get(event.channelId)
            ?? await interaction.guild?.channels.fetch(event.channelId).catch(() => null);
          if (ch?.isTextBased()) {
            const panelMsg = await ch.messages.fetch(event.messageId).catch(() => null);
            if (panelMsg) {
              const { embed: updatedEmbed, rows: updatedRows } = await buildEventEmbed(eventId);
              await panelMsg.edit({ embeds: [updatedEmbed], components: updatedRows });
            }
          }
        } catch { /* ignore */ }
      }

      await interaction.editReply(`✅ イベント「${title ?? event.title}」を更新しました。`);
      return;
    }

    // ── delete ───────────────────────────────────────────────────────────────
    if (sub === "delete") {
      await interaction.deferReply({ ephemeral: true });
      const eventId = interaction.options.getInteger("id", true);

      const event = await getEvent(eventId);
      if (!event || event.guildId !== guildId) {
        await interaction.editReply("イベントが見つかりません。");
        return;
      }

      // パネルメッセージを削除
      if (event.messageId) {
        try {
          const ch = interaction.guild?.channels.cache.get(event.channelId)
            ?? await interaction.guild?.channels.fetch(event.channelId).catch(() => null);
          if (ch?.isTextBased()) {
            const panelMsg = await ch.messages.fetch(event.messageId).catch(() => null);
            await panelMsg?.delete();
          }
        } catch { /* ignore */ }
      }

      await deleteEvent(eventId);
      await interaction.editReply(`✅ イベント「${event.title}」を削除しました。`);
      return;
    }
  },
};

// ─── /ticket ─────────────────────────────────────────────────────────────────

// Defaults used when no custom message is configured
const TICKET_DEFAULTS = {
  panelTitle: "🎫 サポートチケット",
  panelDescription: "ボタンを押すと、スタッフとのプライベートチャンネルが作成されます。",
  panelButtonLabel: "チケットを作成 🎫",
  welcomeMessage: "用件をお書きください。スタッフが対応します。",
} as const;

const ticketCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("チケットシステムの管理")
    .addSubcommand((sub) =>
      sub
        .setName("panel")
        .setDescription("チケット作成パネルをこのチャンネルに設置します（管理者）"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("settings")
        .setDescription("スタッフロールと権限ロールを設定します（管理者）")
        .addRoleOption((opt) =>
          opt.setName("staff_role").setDescription("チケット対応スタッフのロール").setRequired(false),
        )
        .addRoleOption((opt) =>
          opt.setName("rename_role").setDescription("チャンネル名を変更できるロール").setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("message")
        .setDescription("チケットパネル・チャンネルのメッセージを変更します（管理者）")
        .addStringOption((opt) =>
          opt.setName("panel_title").setDescription(`パネルのタイトル（デフォルト: ${TICKET_DEFAULTS.panelTitle}）`).setRequired(false).setMaxLength(256),
        )
        .addStringOption((opt) =>
          opt.setName("panel_description").setDescription("パネルの説明文").setRequired(false).setMaxLength(4096),
        )
        .addStringOption((opt) =>
          opt.setName("panel_button").setDescription(`ボタンのラベル（デフォルト: ${TICKET_DEFAULTS.panelButtonLabel}）`).setRequired(false).setMaxLength(80),
        )
        .addStringOption((opt) =>
          opt.setName("welcome_message").setDescription("チケット作成時にチャンネルへ送るメッセージ").setRequired(false).setMaxLength(2000),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("rename")
        .setDescription("チケットチャンネルの名前を変更します")
        .addStringOption((opt) =>
          opt
            .setName("name")
            .setDescription("新しいチャンネル名（英数字・ハイフン・日本語）")
            .setRequired(true)
            .setMaxLength(100),
        ),
    ),

  async execute(interaction) {
    const guildId = requireGuild(interaction);
    const sub = interaction.options.getSubcommand();

    // ── rename — ticket channel only, admin or rename_role ────────────────────
    if (sub === "rename") {
      if (!interaction.channelId) {
        await interaction.reply({ content: "チャンネル内でのみ使用できます。", ephemeral: true });
        return;
      }

      const ticket = await getTicketByChannel(interaction.channelId);
      if (!ticket) {
        await interaction.reply({ content: "このチャンネルはチケットではありません。", ephemeral: true });
        return;
      }

      const settings = await getTicketSettings(guildId);
      const member = interaction.member as import("discord.js").GuildMember | null;
      const isAdmin = requireAdmin(interaction);
      const hasRenameRole = settings?.renameRoleId
        ? member?.roles.cache.has(settings.renameRoleId) ?? false
        : false;

      if (!isAdmin && !hasRenameRole) {
        const mention = settings?.renameRoleId ? ` または <@&${settings.renameRoleId}>` : "";
        await interaction.reply({
          content: `チャンネル名の変更は管理者${mention} のみ可能です。`,
          ephemeral: true,
          allowedMentions: { parse: [] },
        });
        return;
      }

      const newName = interaction.options.getString("name", true).slice(0, 100);
      try {
        const ch = interaction.channel;
        if (ch && "edit" in ch) await (ch as import("discord.js").TextChannel).edit({ name: newName });
        await interaction.reply({ content: `✅ チャンネル名を **${newName}** に変更しました。`, ephemeral: true });
      } catch {
        await interaction.reply({ content: "チャンネル名の変更に失敗しました。Botに権限があるか確認してください。", ephemeral: true });
      }
      return;
    }

    // 以下は管理者専用
    if (!requireAdmin(interaction)) {
      await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
      return;
    }

    if (sub === "settings") {
      const staffRole  = interaction.options.getRole("staff_role");
      const renameRole = interaction.options.getRole("rename_role");

      if (!staffRole && !renameRole) {
        const settings = await getTicketSettings(guildId);
        const embed = new EmbedBuilder()
          .setTitle("🎫 チケット設定")
          .setColor(0xfee75c)
          .addFields(
            { name: "スタッフロール", value: settings?.staffRoleId ? `<@&${settings.staffRoleId}>` : "未設定", inline: true },
            { name: "名前変更可能ロール", value: settings?.renameRoleId ? `<@&${settings.renameRoleId}>` : "未設定（管理者のみ）", inline: true },
          );
        await interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
        return;
      }

      const replies: string[] = [];
      if (staffRole) {
        await setStaffRole(guildId, staffRole.id);
        replies.push(`スタッフロール: <@&${staffRole.id}>`);
      }
      if (renameRole) {
        await setTicketRenameRole(guildId, renameRole.id);
        replies.push(`名前変更可能ロール: <@&${renameRole.id}>`);
      }
      await interaction.reply({
        content: `✅ 設定しました。\n${replies.join("\n")}`,
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (sub === "message") {
      const panelTitle       = interaction.options.getString("panel_title");
      const panelDescription = interaction.options.getString("panel_description");
      const panelButtonLabel = interaction.options.getString("panel_button");
      const welcomeMessage   = interaction.options.getString("welcome_message");

      if (!panelTitle && !panelDescription && !panelButtonLabel && !welcomeMessage) {
        // Show current settings
        const settings = await getTicketSettings(guildId);
        const embed = new EmbedBuilder()
          .setTitle("🎫 チケットメッセージ設定")
          .setColor(0xfee75c)
          .addFields(
            { name: "パネルタイトル", value: settings?.panelTitle ?? `（デフォルト）${TICKET_DEFAULTS.panelTitle}`, inline: false },
            { name: "パネル説明文",   value: settings?.panelDescription ?? `（デフォルト）${TICKET_DEFAULTS.panelDescription}`, inline: false },
            { name: "ボタンラベル",   value: settings?.panelButtonLabel ?? `（デフォルト）${TICKET_DEFAULTS.panelButtonLabel}`, inline: false },
            { name: "ウェルカムメッセージ", value: settings?.welcomeMessage ?? `（デフォルト）${TICKET_DEFAULTS.welcomeMessage}`, inline: false },
          )
          .setFooter({ text: "各オプションを指定して再実行すると上書きされます。" });
        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      await setTicketMessages(guildId, {
        panelTitle:       panelTitle       ?? undefined,
        panelDescription: panelDescription ?? undefined,
        panelButtonLabel: panelButtonLabel ?? undefined,
        welcomeMessage:   welcomeMessage   ?? undefined,
      });

      const changed = [
        panelTitle       && `パネルタイトル: **${panelTitle}**`,
        panelDescription && `パネル説明文: **${panelDescription}**`,
        panelButtonLabel && `ボタンラベル: **${panelButtonLabel}**`,
        welcomeMessage   && `ウェルカムメッセージ: **${welcomeMessage}**`,
      ].filter(Boolean).join("\n");

      await interaction.reply({ content: `✅ メッセージを更新しました。\n${changed}\n\n次回 \`/ticket panel\` を実行するとパネルに反映されます。`, ephemeral: true });
      return;
    }

    if (sub === "panel") {
      const settings = await getTicketSettings(guildId);
      const embed = new EmbedBuilder()
        .setTitle(settings?.panelTitle ?? TICKET_DEFAULTS.panelTitle)
        .setColor(0xfee75c)
        .setDescription(settings?.panelDescription ?? TICKET_DEFAULTS.panelDescription);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(COMM_TICKET_CREATE)
          .setLabel(settings?.panelButtonLabel ?? TICKET_DEFAULTS.panelButtonLabel)
          .setStyle(ButtonStyle.Primary),
      );
      await interaction.reply({ content: "パネルを設置しました。", ephemeral: true });
      if (interaction.channel?.isSendable()) await interaction.channel.send({ embeds: [embed], components: [row] });
      return;
    }
  },
};

// ─── /sheet ──────────────────────────────────────────────────────────────────

/**
 * Build the eval-sheet embed. Pure function — callers handle async fetching.
 */
export function buildSheetEmbed(opts: {
  targetUser: User;
  displayName: string;
  startDate: Date;
  endDate: Date;
  vcSeconds: number;
  nameboardUrl: string | null | undefined;
  selfIntro: string | null | undefined;
  createdByLabel: string;
}): EmbedBuilder {
  const { targetUser, displayName, startDate, endDate, vcSeconds, nameboardUrl, selfIntro, createdByLabel } = opts;
  const startTs = Math.floor(startDate.getTime() / 1000);
  const endTs = Math.floor(endDate.getTime() / 1000);
  const nameboardValue = nameboardUrl ? `[名簿を見る](${nameboardUrl})` : "未設定";

  const embed = new EmbedBuilder()
    .setTitle(`📋 評価シート — ${displayName}`)
    .setColor(0x2ecc71)
    .setThumbnail(targetUser.displayAvatarURL())
    .addFields(
      { name: "👤 メンバー", value: `${displayName}（<@${targetUser.id}>）`, inline: false },
      { name: "📋 名簿", value: nameboardValue, inline: false },
    );

  if (selfIntro) {
    embed.addFields({
      name: "📝 自己紹介",
      value: selfIntro.slice(0, 1024),
      inline: false,
    });
  }

  embed.addFields(
    { name: "📅 評価開始", value: `<t:${startTs}:D>`, inline: true },
    { name: "⏰ 評価終了", value: `<t:${endTs}:D>`, inline: true },
    { name: "🎙️ 期間中のVC滞在時間", value: formatSeconds(vcSeconds), inline: false },
  )
  .setFooter({ text: createdByLabel })
  .setTimestamp();

  return embed;
}

const sheetCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("sheet")
    .setDescription("評価シートの管理")
    .addSubcommand((sub) =>
      sub
        .setName("settings")
        .setDescription("評価シートの設定を変更します（管理者）")
        .addStringOption((opt) =>
          opt.setName("url").setDescription("名簿のURL（省略で変更なし、クリアするには '-' を入力）").setRequired(false),
        )
        .addChannelOption((opt) =>
          opt
            .setName("forum")
            .setDescription("自動投稿先のフォーラムチャンネル（省略で変更なし）")
            .addChannelTypes(ChannelType.GuildForum)
            .setRequired(false),
        )
        .addRoleOption((opt) =>
          opt.setName("trigger_role_1").setDescription("自動作成を起動するロール①").setRequired(false),
        )
        .addRoleOption((opt) =>
          opt.setName("trigger_role_2").setDescription("自動作成を起動するロール②").setRequired(false),
        )
        .addRoleOption((opt) =>
          opt.setName("trigger_role_3").setDescription("自動作成を起動するロール③").setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("eval_days")
            .setDescription("評価期間（日数・デフォルト14）")
            .setMinValue(1)
            .setMaxValue(90)
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("create")
        .setDescription("評価シートを作成します")
        .addUserOption((opt) =>
          opt.setName("member").setDescription("評価対象のメンバー").setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("start")
            .setDescription("評価開始日（YYYY-MM-DD）")
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("end")
            .setDescription("評価終了日（YYYY-MM-DD）")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName("list").setDescription("評価シートの一覧を表示します")),
  async execute(interaction) {
    const guildId = requireGuild(interaction);
    const sub = interaction.options.getSubcommand();

    if (sub === "settings") {
      if (!requireAdmin(interaction)) {
        await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
        return;
      }
      await interaction.deferReply({ ephemeral: true });

      const current = await getSheetSettings(guildId);
      const lines: string[] = [];

      // ── Nameboard URL ──────────────────────────────────────────────────────
      const urlInput = interaction.options.getString("url");
      if (urlInput !== null) {
        const newUrl = urlInput === "-" ? null : urlInput;
        await setNameboardUrl(guildId, newUrl);
        lines.push(newUrl ? `✅ 名簿URL: ${newUrl}` : "✅ 名簿URLを削除しました。");
      }

      // ── Forum / Roles / Eval days ──────────────────────────────────────────
      const forumChannel = interaction.options.getChannel("forum");
      const role1 = interaction.options.getRole("trigger_role_1");
      const role2 = interaction.options.getRole("trigger_role_2");
      const role3 = interaction.options.getRole("trigger_role_3");
      const evalDaysInput = interaction.options.getInteger("eval_days");

      const hasForumUpdate = forumChannel !== null || role1 !== null || role2 !== null || role3 !== null || evalDaysInput !== null;
      if (hasForumUpdate) {
        const newForumId = forumChannel ? forumChannel.id : (current?.forumChannelId ?? null);
        const newRoles: string[] = role1 || role2 || role3
          ? [role1?.id, role2?.id, role3?.id].filter((id): id is string => !!id)
          : (current?.triggerRoleIds?.split(",").filter(Boolean) ?? []);
        const newDays = evalDaysInput ?? current?.evalPeriodDays ?? 14;
        await setSheetForumConfig(guildId, newForumId, newRoles.length ? newRoles : null, newDays);

        if (forumChannel) lines.push(`✅ 投稿フォーラム: <#${forumChannel.id}>`);
        if (role1 || role2 || role3) {
          const mentions = newRoles.map((id) => `<@&${id}>`).join("、");
          lines.push(`✅ トリガーロール: ${mentions}`);
        }
        if (evalDaysInput !== null) lines.push(`✅ 評価期間: ${evalDaysInput}日`);
      }

      if (lines.length === 0) {
        // Show current settings
        const s = current;
        const roleList = s?.triggerRoleIds
          ? s.triggerRoleIds.split(",").filter(Boolean).map((id) => `<@&${id}>`).join("、")
          : "未設定";
        const embed = new EmbedBuilder()
          .setTitle("📋 評価シート設定")
          .setColor(0x2ecc71)
          .addFields(
            { name: "📋 名簿URL", value: s?.nameboardUrl ?? "未設定", inline: false },
            { name: "📢 投稿フォーラム", value: s?.forumChannelId ? `<#${s.forumChannelId}>` : "未設定", inline: true },
            { name: "🔔 トリガーロール", value: roleList, inline: true },
            { name: "📅 評価期間", value: `${s?.evalPeriodDays ?? 14}日`, inline: true },
          );
        await interaction.editReply({ embeds: [embed] });
      } else {
        await interaction.editReply({ content: lines.join("\n") });
      }
      return;
    }

    if (sub === "create") {
      await interaction.deferReply();
      const targetUser = interaction.options.getUser("member", true);
      const startStr = interaction.options.getString("start", true);
      const endStr = interaction.options.getString("end", true);

      const startDate = parseDate(startStr);
      const endDate = parseDate(endStr);
      if (!startDate || !endDate) {
        await interaction.editReply("日付の形式が正しくありません。例: `2025-01-01`");
        return;
      }
      if (endDate <= startDate) {
        await interaction.editReply("終了日は開始日より後にしてください。");
        return;
      }

      // Fetch member for display name
      let member: GuildMember | null = null;
      try {
        member = await interaction.guild!.members.fetch(targetUser.id);
      } catch {
        // ignore — use User fallback
      }
      const displayName = member?.displayName ?? targetUser.displayName;

      const [settings, vcSeconds] = await Promise.all([
        getSheetSettings(guildId),
        getVcTimeInPeriod(guildId, targetUser.id, startDate, endDate),
      ]);

      const embed = buildSheetEmbed({
        targetUser,
        displayName,
        startDate,
        endDate,
        vcSeconds,
        nameboardUrl: settings?.nameboardUrl,
        selfIntro: null,
        createdByLabel: `作成者: ${interaction.user.displayName}`,
      });

      const msg = await interaction.editReply({ embeds: [embed] });
      const msgId = "id" in msg ? (msg as { id: string }).id : undefined;
      await createSheet(
        guildId,
        targetUser.id,
        startDate,
        endDate,
        interaction.channelId ?? undefined,
        msgId,
      );
      return;
    }

    if (sub === "list") {
      await interaction.deferReply({ ephemeral: true });
      const sheets = await listSheets(guildId);
      if (sheets.length === 0) {
        await interaction.editReply("評価シートがまだありません。");
        return;
      }
      const lines = sheets.map((s) => {
        const startTs = Math.floor(s.startDate.getTime() / 1000);
        const endTs = Math.floor(s.endDate.getTime() / 1000);
        const link = s.channelId && s.messageId ? ` [→](https://discord.com/channels/${guildId}/${s.channelId}/${s.messageId})` : "";
        return `• <@${s.userId}> <t:${startTs}:D> 〜 <t:${endTs}:D>${link}`;
      });
      const embed = new EmbedBuilder()
        .setTitle("📋 評価シート一覧")
        .setColor(0x2ecc71)
        .setDescription(lines.join("\n").slice(0, 4000));
      await interaction.editReply({ embeds: [embed] });
      return;
    }
  },
};

// ─── /mystats ────────────────────────────────────────────────────────────────

const mystatsCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("mystats")
    .setDescription("自分（または指定メンバー）のVC滞在時間を確認します")
    .addUserOption((opt) =>
      opt
        .setName("user")
        .setDescription("確認するメンバー（管理者のみ）")
        .setRequired(false),
    ),
  async execute(interaction) {
    const guildId = requireGuild(interaction);
    await interaction.deferReply({ ephemeral: true });

    const targetOption = interaction.options.getUser("user");

    // Non-admins cannot look up other users
    if (targetOption && targetOption.id !== interaction.user.id && !requireAdmin(interaction)) {
      await interaction.editReply("他のメンバーの統計を確認するには管理者権限が必要です。");
      return;
    }

    const target = targetOption ?? interaction.user;

    // Check if this user has opted out of tracking
    const optedOut = await isVcTrackingOptedOut(guildId, target.id);
    if (optedOut) {
      const isSelf = target.id === interaction.user.id;
      await interaction.editReply({
        content: isSelf
          ? "🔒 あなたはVCトラッキングをオフにしています。`/privacy optin` で再開できます。"
          : "🔒 このユーザーはVCトラッキングをオフにしています。",
      });
      return;
    }

    const now = new Date();

    // Period start dates
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    weekStart.setHours(0, 0, 0, 0);

    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // Fetch all periods in parallel, along with any active session
    const [todaySeconds, weekSeconds, monthSeconds, allSeconds, allRank, activeSession] = await Promise.all([
      getVcTimeInPeriod(guildId, target.id, todayStart, now),
      getVcTimeInPeriod(guildId, target.id, weekStart, now),
      getVcTimeInPeriod(guildId, target.id, monthStart, now),
      getVcTimeInPeriod(guildId, target.id, new Date(0), now),
      getUserVcRank(guildId, target.id),
      getActiveSession(guildId, target.id),
    ]);

    let member: GuildMember | null = null;
    try {
      member = await interaction.guild!.members.fetch(target.id);
    } catch {
      // ignore
    }
    const displayName = member?.displayName ?? target.displayName;

    const rankText = allRank != null ? `第 **${allRank}** 位` : "記録なし";

    // Calculate live in-progress seconds for display note
    const liveSeconds = activeSession
      ? Math.floor((now.getTime() - activeSession.joinedAt.getTime()) / 1000)
      : 0;

    const embed = new EmbedBuilder()
      .setTitle(`🎙️ VCスタッツ — ${displayName}`)
      .setColor(activeSession ? 0xed4245 : 0x5865f2)
      .setThumbnail(target.displayAvatarURL())
      .addFields(
        { name: "📅 今日", value: formatSeconds(todaySeconds), inline: true },
        { name: "📆 今週", value: formatSeconds(weekSeconds), inline: true },
        { name: "🗓️ 今月", value: formatSeconds(monthSeconds), inline: true },
        { name: "🏆 全期間", value: formatSeconds(allSeconds), inline: true },
        { name: "📊 ランキング順位", value: rankText, inline: true },
      )
      .setTimestamp();

    if (activeSession) {
      embed.addFields({
        name: "現在VC中 🔴",
        value: `セッション開始から **${formatSeconds(liveSeconds)}** 経過中（<#${activeSession.channelId}>）`,
        inline: false,
      });
    }

    await interaction.editReply({ embeds: [embed] });
  },
};

// ─── /privacy ────────────────────────────────────────────────────────────────

const privacyCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("privacy")
    .setDescription("VCトラッキングのプライバシー設定を管理します")
    .addSubcommand((sub) =>
      sub
        .setName("optout")
        .setDescription("VCの滞在時間の記録を停止します（ランキングや統計から除外されます）"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("optin")
        .setDescription("VCの滞在時間の記録を再開します"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("status")
        .setDescription("現在のトラッキング設定を確認します"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("delete")
        .setDescription("過去のVC滞在記録をすべて削除します（取り消し不可）"),
    ),
  async execute(interaction) {
    const guildId = requireGuild(interaction);
    const userId = interaction.user.id;
    const sub = interaction.options.getSubcommand();

    await interaction.deferReply({ ephemeral: true });

    if (sub === "optout") {
      const embed = new EmbedBuilder()
        .setTitle("🔒 VCトラッキングを停止しますか？")
        .setColor(0xfee75c)
        .setDescription(
          "**このサーバー**でのVCの滞在時間の記録を停止します。\n" +
          "⚠️ この設定は**サーバーごと**に管理されます。他のサーバーでも停止したい場合は、そのサーバーで個別に `/privacy optout` を実行してください。\n\n" +
          "過去のデータをどうするか選択してください。\n\n" +
          "**🗄️ 停止のみ（データを保持）**\n" +
          "• 新しい記録は残りません\n" +
          "• 既存のランキングや統計データはそのまま残ります\n\n" +
          "**🗑️ 停止＋過去データを削除（取り消し不可）**\n" +
          "• 新しい記録は残りません\n" +
          "• このサーバーでの全VC記録が完全に削除されます",
        )
        .setTimestamp();
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(COMM_PRIVACY_OPTOUT_KEEP)
          .setLabel("停止のみ（データを保持）")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(COMM_PRIVACY_OPTOUT_DELETE)
          .setLabel("停止＋過去データを削除 🗑️")
          .setStyle(ButtonStyle.Danger),
      );
      await interaction.editReply({ embeds: [embed], components: [row] });
      return;
    }

    if (sub === "delete") {
      const embed = new EmbedBuilder()
        .setTitle("⚠️ 過去のVC記録を削除しますか？")
        .setColor(0xfee75c)
        .setDescription(
          "このサーバーにおけるあなたの**すべてのVC滞在記録**を削除します。\n\n" +
          "• ランキングや `/mystats` から完全に除外されます\n" +
          "• この操作は**取り消せません**\n" +
          "• 同時にトラッキングも停止します\n\n" +
          "本当に削除しますか？",
        )
        .setTimestamp();
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(COMM_PRIVACY_DELETE_CONFIRM)
          .setLabel("削除する 🗑️")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(COMM_PRIVACY_DELETE_CANCEL)
          .setLabel("キャンセル")
          .setStyle(ButtonStyle.Secondary),
      );
      await interaction.editReply({ embeds: [embed], components: [row] });
      return;
    }

    if (sub === "optin") {
      await setVcPrivacyOptOut(guildId, userId, false);
      const embed = new EmbedBuilder()
        .setTitle("🔓 トラッキングを再開しました")
        .setColor(0x57f287)
        .setDescription(
          "**このサーバー**でのVCの滞在時間の記録を**再開**しました。\n\n" +
          "• これ以降のVCセッションが記録されます\n" +
          "• `/ranking` や `/mystats` にあなたのデータが表示されます\n\n" +
          "ℹ️ この設定は**サーバーごと**に管理されます。\n" +
          "停止するには `/privacy optout` を使用してください。",
        )
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === "status") {
      const optedOut = await isVcTrackingOptedOut(guildId, userId);
      const embed = new EmbedBuilder()
        .setTitle("🔎 プライバシー設定（このサーバー）")
        .setColor(optedOut ? 0xed4245 : 0x57f287)
        .addFields(
          {
            name: "VCトラッキング",
            value: optedOut
              ? "🔴 **停止中** — `/privacy optin` で再開できます"
              : "🟢 **有効** — `/privacy optout` で停止できます",
            inline: false,
          },
          {
            name: "ℹ️ 設定の範囲",
            value: "この設定は**このサーバー専用**です。他のサーバーで設定を変更したい場合は、そのサーバーで個別にコマンドを実行してください。サーバーを退出・再参加しても、設定はそのまま保持されます。",
            inline: false,
          },
        )
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
      return;
    }
  },
};

// ─── /botstatus ──────────────────────────────────────────────────────────────

import type { Client, Guild as DjsGuild } from "discord.js";

/** Builds the botstatus embed + refresh button row for a guild. */
async function buildBotstatusContent(
  guild: DjsGuild,
  client: Client,
): Promise<{ embed: EmbedBuilder; row: ActionRowBuilder<ButtonBuilder> }> {
  const me = guild.members.me;

  // ── Permissions ─────────────────────────────────────────────────────────────
  const hasManageChannels = me?.permissions.has("ManageChannels") ?? false;
  const hasMoveMembers    = me?.permissions.has("MoveMembers")    ?? false;

  const manageChannelsLine = hasManageChannels
    ? "✅ ManageChannels — 付与済み"
    : "❌ ManageChannels — **未付与** (Server Settings → Roles → Community Bot で付与してください)";

  const moveMembersLine = hasMoveMembers
    ? "✅ MoveMembers — 付与済み"
    : "❌ MoveMembers — **未付与** (Server Settings → Roles → Community Bot で付与してください)";

  // ── GuildMembers privileged intent ──────────────────────────────────────────
  const guildMembersIntentBit = 1 << 1; // GatewayIntentBits.GuildMembers = 2
  const intents = client.options.intents;
  let hasGuildMembersIntent = false;
  if (typeof (intents as { has?: (bit: number) => boolean }).has === "function") {
    hasGuildMembersIntent = (intents as { has: (bit: number) => boolean }).has(guildMembersIntentBit);
  } else if (typeof intents === "number" || typeof intents === "bigint") {
    hasGuildMembersIntent = Boolean(BigInt(intents as number) & BigInt(guildMembersIntentBit));
  }

  const guildMembersLine = hasGuildMembersIntent
    ? "✅ GuildMembers intent — 有効"
    : "❌ GuildMembers intent — **無効** (Discord Developer Portal → Bot → Privileged Gateway Intents で有効化してください)";

  // ── Overall status ───────────────────────────────────────────────────────────
  const allGood = hasManageChannels && hasMoveMembers && hasGuildMembersIntent;
  const statusLine = allGood
    ? "🟢 **すべて正常です**"
    : "🔴 **設定に問題があります** — 上記の項目を確認してください";

  const embed = new EmbedBuilder()
    .setTitle("🤖 Bot セットアップ状況")
    .setColor(allGood ? 0x57f287 : 0xed4245)
    .setDescription(
      [statusLine, "", manageChannelsLine, moveMembersLine, guildMembersLine].join("\n"),
    )
    .setFooter({ text: `サーバー: ${guild.name}` })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(COMM_BOTSTATUS_REFRESH)
      .setLabel("再チェック 🔄")
      .setStyle(ButtonStyle.Secondary),
  );

  return { embed, row };
}

const botstatusCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("botstatus")
    .setDescription("Botのセットアップ状況を確認します（管理者）"),
  async execute(interaction) {
    requireGuild(interaction);

    if (!requireAdmin(interaction)) {
      await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const { embed, row } = await buildBotstatusContent(interaction.guild!, interaction.client);
    await interaction.editReply({ embeds: [embed], components: [row] });
  },
};

// ─── Button handlers ─────────────────────────────────────────────────────────

export async function handleEventJoin(interaction: ButtonInteraction): Promise<void> {
  const eventId = Number(interaction.customId.slice(COMM_EVENT_JOIN_PREFIX.length));
  await interaction.deferUpdate();
  const added = await addParticipant(eventId, interaction.user.id);
  const { embed, rows } = await buildEventEmbed(eventId);
  await interaction.editReply({ embeds: [embed], components: rows });
  if (added) {
    await interaction.followUp({ content: "✅ 参加登録しました！", ephemeral: true });
  } else {
    await interaction.followUp({ content: "すでに参加登録済みです。", ephemeral: true });
  }
}

export async function handleEventCancel(interaction: ButtonInteraction): Promise<void> {
  const eventId = Number(interaction.customId.slice(COMM_EVENT_CANCEL_PREFIX.length));
  await interaction.deferUpdate();
  const removed = await removeParticipant(eventId, interaction.user.id);
  const { embed, rows } = await buildEventEmbed(eventId);
  await interaction.editReply({ embeds: [embed], components: rows });
  if (removed) {
    await interaction.followUp({ content: "❌ 参加をキャンセルしました。", ephemeral: true });
  } else {
    await interaction.followUp({ content: "参加登録されていませんでした。", ephemeral: true });
  }
}

export async function handleTicketCreate(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({ content: "サーバー内でのみ使用できます。", ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });

  const guildId = interaction.guildId;
  const settings = await getTicketSettings(guildId);
  const me = interaction.guild.members.me;
  if (!me?.permissions.has("ManageChannels")) {
    await interaction.editReply("BotにManageChannels権限がありません。");
    return;
  }

  // Unique channel name
  const suffix = Date.now().toString(36).slice(-4);
  const channelName = `ticket-${interaction.user.username.slice(0, 20)}-${suffix}`;

  const overwrites: OverwriteResolvable[] = [
    { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    { id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
  ];
  if (settings?.staffRoleId) {
    overwrites.push({
      id: settings.staffRoleId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    });
  }

  let channel;
  try {
    channel = await interaction.guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      permissionOverwrites: overwrites,
    });
  } catch (err) {
    logger.error("[ticket] Failed to create channel", err);
    await interaction.editReply("チャンネルの作成に失敗しました。");
    return;
  }

  const ticket = await createTicket(guildId, channel.id, interaction.user.id);

  const welcome = settings?.welcomeMessage ?? TICKET_DEFAULTS.welcomeMessage;
  const embed = new EmbedBuilder()
    .setTitle("🎫 サポートチケット")
    .setColor(0xfee75c)
    .setDescription(`<@${interaction.user.id}> からのチケットです。\n${welcome}`)
    .setTimestamp();
  const closeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${COMM_TICKET_CLOSE_PREFIX}${ticket.id}`)
      .setLabel("チケットを閉じる 🔒")
      .setStyle(ButtonStyle.Danger),
  );
  await channel.send({ content: `<@${interaction.user.id}>${settings?.staffRoleId ? ` <@&${settings.staffRoleId}>` : ""}`, embeds: [embed], components: [closeRow] });
  await interaction.editReply(`✅ チケットを作成しました: <#${channel.id}>`);
}

export async function handleTicketClose(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.channelId) return;
  await interaction.deferReply({ ephemeral: true });

  const ticket = await getTicketByChannel(interaction.channelId);
  if (!ticket) {
    await interaction.editReply("このチャンネルはチケットではないか、すでに閉じられています。");
    return;
  }

  await removeTicket(interaction.channelId);
  await interaction.editReply("チケットを閉じます…");

  try {
    await interaction.channel?.delete("チケットのクローズ");
  } catch (err) {
    logger.error("[ticket] Failed to delete channel", err);
  }
}

export async function handleBotstatusRefresh(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: "サーバー内でのみ使用できます。", ephemeral: true });
    return;
  }
  await interaction.deferUpdate();
  const { embed, row } = await buildBotstatusContent(interaction.guild, interaction.client);
  await interaction.editReply({ embeds: [embed], components: [row] });
}

export async function handlePrivacyOptoutKeep(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guildId) return;
  await interaction.deferUpdate();
  await setVcPrivacyOptOut(interaction.guildId, interaction.user.id, true);
  const embed = new EmbedBuilder()
    .setTitle("🔒 トラッキングを停止しました")
    .setColor(0xed4245)
    .setDescription(
      "VCの滞在時間の記録を**停止**しました。\n\n" +
      "• 新しいセッションは記録されません\n" +
      "• 過去のデータはそのまま残ります\n\n" +
      "再開するには `/privacy optin` を使用してください。",
    )
    .setTimestamp();
  await interaction.editReply({ embeds: [embed], components: [] });
}

export async function handlePrivacyOptoutDelete(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guildId) return;
  await interaction.deferUpdate();
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const [deleted] = await Promise.all([
    deleteUserVcSessions(guildId, userId),
    setVcPrivacyOptOut(guildId, userId, true),
  ]);
  const embed = new EmbedBuilder()
    .setTitle("🗑️ トラッキングを停止し、過去データを削除しました")
    .setColor(0xed4245)
    .setDescription(
      `VCの滞在記録 **${deleted}件** を削除し、トラッキングを停止しました。\n\n` +
      "• ランキングや統計からあなたのデータは除外されます\n" +
      "• 再開するには `/privacy optin` を使用してください",
    )
    .setTimestamp();
  await interaction.editReply({ embeds: [embed], components: [] });
}

export async function handlePrivacyDeleteConfirm(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "サーバー内でのみ使用できます。", ephemeral: true });
    return;
  }
  await interaction.deferUpdate();
  const guildId = interaction.guildId;
  const userId = interaction.user.id;

  const [deleted] = await Promise.all([
    deleteUserVcSessions(guildId, userId),
    setVcPrivacyOptOut(guildId, userId, true),
  ]);

  const embed = new EmbedBuilder()
    .setTitle("🗑️ VC記録を削除しました")
    .setColor(0xed4245)
    .setDescription(
      `このサーバーでのVC滞在記録 **${deleted}件** を削除し、トラッキングを停止しました。\n\n` +
      "• ランキングや統計からあなたのデータは除外されます\n" +
      "• トラッキングを再開するには `/privacy optin` を使用してください",
    )
    .setTimestamp();
  await interaction.editReply({ embeds: [embed], components: [] });
}

export async function handlePrivacyDeleteCancel(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferUpdate();
  const embed = new EmbedBuilder()
    .setTitle("✅ キャンセルしました")
    .setColor(0x57f287)
    .setDescription("VC記録の削除をキャンセルしました。データはそのまま保持されます。")
    .setTimestamp();
  await interaction.editReply({ embeds: [embed], components: [] });
}

// ─── /rolebutton ─────────────────────────────────────────────────────────────

export const COMM_ROLEBUTTON_PREFIX = "comm:rolebutton:";

const BUTTON_STYLE_CHOICES = [
  { name: "青（Primary）", value: "1" },
  { name: "グレー（Secondary）", value: "2" },
  { name: "緑（Success）", value: "3" },
  { name: "赤（Danger）", value: "4" },
] as const;

const roleButtonCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("rolebutton")
    .setDescription("ボタンを押すとロールが付与・解除されるパネルを管理します")
    .addSubcommand((sub) =>
      sub
        .setName("create")
        .setDescription("ロールボタンパネルを設置します（管理者）")
        .addStringOption((opt) =>
          opt.setName("title").setDescription("パネルのタイトル").setRequired(true).setMaxLength(256),
        )
        .addRoleOption((opt) =>
          opt.setName("role1").setDescription("付与するロール①").setRequired(true),
        )
        .addStringOption((opt) =>
          opt.setName("label1").setDescription("ボタン①のラベル").setRequired(true).setMaxLength(80),
        )
        .addStringOption((opt) =>
          opt.setName("style1").setDescription("ボタン①の色").setRequired(false).addChoices(...BUTTON_STYLE_CHOICES),
        )
        .addRoleOption((opt) =>
          opt.setName("role2").setDescription("付与するロール②").setRequired(false),
        )
        .addStringOption((opt) =>
          opt.setName("label2").setDescription("ボタン②のラベル").setRequired(false).setMaxLength(80),
        )
        .addStringOption((opt) =>
          opt.setName("style2").setDescription("ボタン②の色").setRequired(false).addChoices(...BUTTON_STYLE_CHOICES),
        )
        .addRoleOption((opt) =>
          opt.setName("role3").setDescription("付与するロール③").setRequired(false),
        )
        .addStringOption((opt) =>
          opt.setName("label3").setDescription("ボタン③のラベル").setRequired(false).setMaxLength(80),
        )
        .addStringOption((opt) =>
          opt.setName("style3").setDescription("ボタン③の色").setRequired(false).addChoices(...BUTTON_STYLE_CHOICES),
        )
        .addStringOption((opt) =>
          opt.setName("description").setDescription("パネルの説明文").setRequired(false).setMaxLength(4096),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("設置済みのロールボタンパネル一覧を表示します（管理者）"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("delete")
        .setDescription("ロールボタンパネルを削除します（管理者）")
        .addStringOption((opt) =>
          opt.setName("message_id").setDescription("削除するパネルのメッセージID").setRequired(true),
        ),
    ),

  async execute(interaction) {
    const guildId = requireGuild(interaction);
    const sub = interaction.options.getSubcommand();

    if (!requireAdmin(interaction)) {
      await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
      return;
    }

    // ── list ────────────────────────────────────────────────────────────────
    if (sub === "list") {
      const panels = await listRoleButtonPanels(guildId);
      if (panels.length === 0) {
        await interaction.reply({ content: "ロールボタンパネルはまだありません。", ephemeral: true });
        return;
      }
      // Group by messageId
      const grouped = new Map<string, typeof panels>();
      for (const btn of panels) {
        const arr = grouped.get(btn.messageId) ?? [];
        arr.push(btn);
        grouped.set(btn.messageId, arr);
      }
      const lines = [...grouped.entries()].map(([msgId, btns]) => {
        const roles = btns.map((b) => `<@&${b.roleId}> \`${b.label}\``).join(", ");
        return `• \`${msgId}\` → ${roles}`;
      });
      await interaction.reply({
        content: `## 🎛️ ロールボタンパネル一覧\n${lines.join("\n")}`,
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }

    // ── delete ──────────────────────────────────────────────────────────────
    if (sub === "delete") {
      const messageId = interaction.options.getString("message_id", true);
      await deleteRoleButtonsByMessage(messageId);
      // Try to delete the Discord message too
      try {
        const panels = await listRoleButtonPanels(guildId);
        const sample = panels.find((p) => p.messageId === messageId);
        if (sample) {
          const ch = interaction.guild?.channels.cache.get(sample.channelId);
          if (ch?.isTextBased()) {
            const msg = await ch.messages.fetch(messageId).catch(() => null);
            await msg?.delete();
          }
        }
      } catch { /* ignore */ }
      await interaction.reply({ content: `✅ パネル \`${messageId}\` を削除しました。`, ephemeral: true });
      return;
    }

    // ── create ──────────────────────────────────────────────────────────────
    if (sub === "create") {
      if (!interaction.channel?.isSendable()) {
        await interaction.reply({ content: "このチャンネルには送信できません。", ephemeral: true });
        return;
      }

      const title       = interaction.options.getString("title", true);
      const description = interaction.options.getString("description");

      const slots = [1, 2, 3] as const;
      const buttons: { role: import("discord.js").Role; label: string; style: number }[] = [];

      for (const n of slots) {
        const role  = interaction.options.getRole(`role${n}`);
        const label = interaction.options.getString(`label${n}`);
        const style = Number(interaction.options.getString(`style${n}`) ?? "1");
        if (role && label) buttons.push({ role: role as import("discord.js").Role, label, style });
      }

      if (buttons.length === 0) {
        await interaction.reply({ content: "ロールとラベルを少なくとも1つ指定してください。", ephemeral: true });
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle(title)
        .setColor(0x5865f2);
      if (description) embed.setDescription(description);

      // Post the panel message first (without button IDs — we need the messageId first)
      const placeholderRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        buttons.map((b) =>
          new ButtonBuilder()
            .setCustomId("pending")
            .setLabel(b.label)
            .setStyle(b.style as ButtonStyle)
            .setDisabled(true),
        ),
      );

      await interaction.deferReply({ ephemeral: true });
      const msg = await interaction.channel.send({ embeds: [embed], components: [placeholderRow] });

      // Persist each button
      for (const b of buttons) {
        await createRoleButton({
          guildId,
          channelId: msg.channelId,
          messageId: msg.id,
          roleId: b.role.id,
          label: b.label,
          style: b.style,
        });
      }

      // Fetch the saved buttons to get their IDs, then update the message with real customIds
      const saved = await getRoleButtonsByMessage(msg.id);
      const realRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        saved.map((b) =>
          new ButtonBuilder()
            .setCustomId(`${COMM_ROLEBUTTON_PREFIX}${b.id}`)
            .setLabel(b.label)
            .setStyle(b.style as ButtonStyle),
        ),
      );
      await msg.edit({ components: [realRow] });

      await interaction.editReply(`✅ ロールボタンパネルを設置しました: <#${msg.channelId}>`);
      return;
    }
  },
};

export async function handleRoleButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild || !interaction.guildId) {
    await interaction.reply({ content: "サーバー内でのみ使用できます。", ephemeral: true });
    return;
  }

  const buttonId = Number(interaction.customId.slice(COMM_ROLEBUTTON_PREFIX.length));
  if (isNaN(buttonId)) return;

  const btnRecord = await getRoleButtonById(buttonId);
  if (!btnRecord) {
    await interaction.reply({ content: "このボタンの設定が見つかりません。管理者にご連絡ください。", ephemeral: true });
    return;
  }

  let member: GuildMember;
  try {
    member = await interaction.guild.members.fetch(interaction.user.id);
  } catch {
    await interaction.reply({ content: "メンバー情報の取得に失敗しました。", ephemeral: true });
    return;
  }

  const role = interaction.guild.roles.cache.get(btnRecord.roleId)
    ?? await interaction.guild.roles.fetch(btnRecord.roleId).catch(() => null);
  if (!role) {
    await interaction.reply({ content: "対象ロールが見つかりません。管理者にご連絡ください。", ephemeral: true });
    return;
  }

  const has = member.roles.cache.has(role.id);
  try {
    if (has) {
      await member.roles.remove(role, "ロールボタンによる解除");
      await interaction.reply({ content: `✅ **${role.name}** を解除しました。`, ephemeral: true });
    } else {
      await member.roles.add(role, "ロールボタンによる付与");
      await interaction.reply({ content: `✅ **${role.name}** を付与しました。`, ephemeral: true });
    }
  } catch {
    await interaction.reply({ content: "ロールの変更に失敗しました。Botに権限があるか確認してください。", ephemeral: true });
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export const commands: Command[] = [
  rankingCommand,
  mystatsCommand,
  privacyCommand,
  eventCommand,
  ticketCommand,
  sheetCommand,
  botstatusCommand,
  roleButtonCommand,
];
