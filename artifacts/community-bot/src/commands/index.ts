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
  getTicketByChannel,
  getTicketSettings,
  getUserVcRank,
  getVcRanking,
  getVcTimeInPeriod,
  isVcTrackingOptedOut,
  listRoleButtonPanels,
  listUpcomingEvents,
  setEventSettings,
  removeParticipant,
  removeTicket,
  setLeaveLogChannel,
  setRankingSettings,
  setStaffRole,
  setTicketMessages,
  setTicketRenameRole,
  upsertTicketSettings,
  createTicketPanel,
  getTicketPanel,
  updateTicketPanel,
  listTicketPanels,
  deleteTicketPanel,
  setVcPrivacyOptOut,
  setVcGlobalPrivacyOptOut,
  isVcTrackingGloballyOptedOut,
  isVcTrackingGuildLocalOptedOut,
  deleteAllUserVcSessions,
  updateEventMessageId,
  type CommunityTicketSettings,
  type CommunityTicketPanel,
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
export const COMM_PRIVACY_GLOBAL_OPTOUT_KEEP = "comm:privacy:global:optout:keep";
export const COMM_PRIVACY_GLOBAL_OPTOUT_DELETE = "comm:privacy:global:optout:delete";
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
      sub
        .setName("me")
        .setDescription("自分のVC順位と滞在時間を確認します")
        .addStringOption((opt) =>
          opt
            .setName("period")
            .setDescription("集計期間（デフォルト: 全期間）")
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

    // ── me ────────────────────────────────────────────────────────────────────
    if (sub === "me") {
      await interaction.deferReply({ ephemeral: true });

      const [globalOptedOut, guildOptedOut] = await Promise.all([
        isVcTrackingGloballyOptedOut(interaction.user.id),
        isVcTrackingGuildLocalOptedOut(guildId, interaction.user.id),
      ]);
      if (globalOptedOut) {
        await interaction.editReply("⏸ VCトラッキングを**全サーバーで停止中**です（グローバルオプトアウト）。`/privacy optin` で再開できます。");
        return;
      }
      if (guildOptedOut) {
        await interaction.editReply("🔒 このサーバーでVCトラッキングをオフにしています。`/privacy optin` で再開できます。");
        return;
      }

      const period = (interaction.options.getString("period") ?? "all") as RankingPeriod;
      const periodStart = buildRankingPeriodStart(period);
      const now = new Date();

      const [rank, seconds, activeSession] = await Promise.all([
        getUserVcRank(guildId, interaction.user.id, periodStart),
        getVcTimeInPeriod(
          guildId,
          interaction.user.id,
          periodStart ?? new Date(0),
          now,
        ),
        getActiveSession(guildId, interaction.user.id),
      ]);

      const periodLabel = RANKING_PERIOD_LABELS[period];
      const rankText   = rank != null ? `第 **${rank}** 位` : "圏外（記録なし）";
      const timeText   = formatSeconds(seconds);

      const liveSeconds = activeSession
        ? Math.floor((now.getTime() - activeSession.joinedAt.getTime()) / 1000)
        : 0;

      const embed = new EmbedBuilder()
        .setTitle(`🏆 あなたのVCランク（${periodLabel}）`)
        .setColor(activeSession ? 0xed4245 : 0xf5a623)
        .setThumbnail(interaction.user.displayAvatarURL())
        .addFields(
          { name: "順位", value: rankText, inline: true },
          { name: "滞在時間", value: timeText, inline: true },
        )
        .setTimestamp();

      if (activeSession) {
        embed.addFields({
          name: "現在VC中 🔴",
          value: `<#${activeSession.channelId}> に参加中（${formatSeconds(liveSeconds)} 経過）`,
          inline: false,
        });
      }

      await interaction.editReply({ embeds: [embed] });
      return;
    }

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

/** Fallback category when none is configured. */
const TICKET_CATEGORY_FALLBACK = "1526691329805910016";

/** Custom ID prefix for per-panel ticket buttons. */
export const COMM_TICKET_PANEL_PREFIX = "comm:ticket:panel:";

const TICKET_DEFAULTS = {
  panelTitle: "🎫 サポートチケット",
  panelDescription: "ボタンを押すと、スタッフとのプライベートチャンネルが作成されます。",
  panelButtonLabel: "チケットを作成 🎫",
  panelButtonStyle: ButtonStyle.Primary,
  welcomeMessage: "用件をお書きください。スタッフが対応します。",
  welcomeEmbedTitle: "🎫 サポートチケット",
  welcomeEmbedColor: 0xfee75c,
  channelNamePrefix: "ticket",
  closeButtonLabel: "チケットを閉じる 🔒",
  closeButtonStyle: ButtonStyle.Danger,
} as const;

const BUTTON_STYLE_MAP: Record<string, ButtonStyle> = {
  primary:   ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success:   ButtonStyle.Success,
  danger:    ButtonStyle.Danger,
};
const BUTTON_STYLE_LABELS: Record<string, string> = {
  primary:   "青（Primary）",
  secondary: "灰（Secondary）",
  success:   "緑（Success）",
  danger:    "赤（Danger）",
};
const STYLE_CHOICES = [
  { name: "青（Primary）",   value: "primary" },
  { name: "灰（Secondary）", value: "secondary" },
  { name: "緑（Success）",   value: "success" },
  { name: "赤（Danger）",    value: "danger" },
] as const;

function resolveButtonStyle(stored: number | null | undefined, fallback: ButtonStyle): ButtonStyle {
  if (stored != null && stored >= 1 && stored <= 4) return stored as ButtonStyle;
  return fallback;
}

function hexToInt(hex: string): number {
  return parseInt(hex.replace(/^#/, ""), 16);
}

function buildPanelButton(panel: CommunityTicketPanel) {
  const btn = new ButtonBuilder()
    .setCustomId(`${COMM_TICKET_PANEL_PREFIX}${panel.id}`)
    .setLabel(panel.panelButtonLabel ?? TICKET_DEFAULTS.panelButtonLabel)
    .setStyle(resolveButtonStyle(panel.panelButtonStyle, TICKET_DEFAULTS.panelButtonStyle));
  if (panel.panelButtonEmoji) btn.setEmoji(panel.panelButtonEmoji);
  return btn;
}

function styleLabel(n: number | null | undefined, fb: string): string {
  const entry = Object.entries(BUTTON_STYLE_MAP).find(([, v]) => v === n);
  return entry ? BUTTON_STYLE_LABELS[entry[0]] ?? fb : `（デフォルト）${fb}`;
}

function panelEmbed(panel: CommunityTicketPanel): EmbedBuilder {
  const colorInt = panel.welcomeEmbedColor ? hexToInt(panel.welcomeEmbedColor) : TICKET_DEFAULTS.welcomeEmbedColor;
  return new EmbedBuilder()
    .setTitle(panel.panelTitle ?? TICKET_DEFAULTS.panelTitle)
    .setColor(colorInt)
    .setDescription(panel.panelDescription ?? TICKET_DEFAULTS.panelDescription);
}

// ─ helper to add shared panel-appearance options to a subcommand ─────────────
/** Max number of mention-role slots per panel. */
const MAX_MENTION_ROLES = 5;

function addPanelOpts<T extends import("discord.js").SlashCommandSubcommandBuilder>(sub: T): T {
  let s = sub
    .addStringOption((o) => o.setName("title").setDescription("パネルの見出し").setRequired(false).setMaxLength(256))
    .addStringOption((o) => o.setName("description").setDescription("パネルの説明文").setRequired(false).setMaxLength(4096))
    .addStringOption((o) => o.setName("button_label").setDescription("ボタンのラベル").setRequired(false).setMaxLength(80))
    .addStringOption((o) => o.setName("button_style").setDescription("ボタンの色").setRequired(false).addChoices(...STYLE_CHOICES))
    .addStringOption((o) => o.setName("button_emoji").setDescription("ボタンの絵文字（例: 🎫 / <:name:id>）").setRequired(false).setMaxLength(100))
    .addStringOption((o) => o.setName("welcome").setDescription("チケット内ウェルカムメッセージ").setRequired(false).setMaxLength(2000))
    .addStringOption((o) => o.setName("embed_title").setDescription("ウェルカムEmbedの見出し").setRequired(false).setMaxLength(256))
    .addStringOption((o) => o.setName("embed_color").setDescription("ウェルカムEmbedの色（例: #5865F2）").setRequired(false).setMaxLength(7))
    .addStringOption((o) => o.setName("close_label").setDescription("クローズボタンのラベル").setRequired(false).setMaxLength(80))
    .addStringOption((o) => o.setName("close_style").setDescription("クローズボタンの色").setRequired(false).addChoices(...STYLE_CHOICES));
  for (let i = 1; i <= MAX_MENTION_ROLES; i++) {
    s = s.addRoleOption((o) =>
      o.setName(`mention_role_${i}`).setDescription(`チケット開設時にpingするロール ${i}`).setRequired(false),
    );
  }
  return s as T;
}

function collectPanelOpts(interaction: ChatInputCommandInteraction) {
  const embedColor = interaction.options.getString("embed_color");
  if (embedColor && !/^#?[0-9a-fA-F]{6}$/.test(embedColor)) return null; // invalid

  const buttonStyle = interaction.options.getString("button_style");
  const closeStyle  = interaction.options.getString("close_style");

  // Collect mention roles; keep only non-null, deduplicate
  const mentionRoleIds = Array.from(
    new Set(
      Array.from({ length: MAX_MENTION_ROLES }, (_, i) =>
        interaction.options.getRole(`mention_role_${i + 1}`)?.id,
      ).filter((id): id is string => id != null),
    ),
  );

  return {
    panelTitle:        interaction.options.getString("title")        ?? undefined,
    panelDescription:  interaction.options.getString("description")  ?? undefined,
    panelButtonLabel:  interaction.options.getString("button_label") ?? undefined,
    panelButtonStyle:  buttonStyle ? (BUTTON_STYLE_MAP[buttonStyle] as number) : undefined,
    panelButtonEmoji:  interaction.options.getString("button_emoji") ?? undefined,
    welcomeMessage:    interaction.options.getString("welcome")      ?? undefined,
    welcomeEmbedTitle: interaction.options.getString("embed_title")  ?? undefined,
    welcomeEmbedColor: embedColor
      ? (embedColor.startsWith("#") ? embedColor : `#${embedColor}`)
      : undefined,
    closeButtonLabel:  interaction.options.getString("close_label")  ?? undefined,
    closeButtonStyle:  closeStyle ? (BUTTON_STYLE_MAP[closeStyle] as number) : undefined,
    // Only include if at least one role was specified (so edit without touching
    // roles does not overwrite existing ones)
    ...(mentionRoleIds.length > 0 ? { mentionRoleIds } : {}),
  };
}

const ticketCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("チケットシステムの管理")
    // ── panel (subcommand group) ───────────────────────────────────────────────
    .addSubcommandGroup((group) =>
      group
        .setName("panel")
        .setDescription("チケットパネルの管理")
        .addSubcommand((sub) =>
          addPanelOpts(
            sub
              .setName("create")
              .setDescription("新しいパネルを作成してこのチャンネルに設置します（管理者）")
              .addStringOption((o) => o.setName("name").setDescription("パネルの管理名").setRequired(true).setMaxLength(50)),
          ),
        )
        .addSubcommand((sub) =>
          addPanelOpts(
            sub
              .setName("edit")
              .setDescription("既存パネルの設定を変更します（管理者）")
              .addIntegerOption((o) => o.setName("id").setDescription("パネルID（/ticket panel list で確認）").setRequired(true))
              .addStringOption((o) => o.setName("name").setDescription("管理名を変更").setRequired(false).setMaxLength(50)),
          ),
        )
        .addSubcommand((sub) =>
          sub.setName("list").setDescription("このサーバーのパネル一覧を表示します"),
        )
        .addSubcommand((sub) =>
          sub
            .setName("delete")
            .setDescription("パネルを削除します（管理者）")
            .addIntegerOption((o) => o.setName("id").setDescription("削除するパネルID").setRequired(true)),
        )
        .addSubcommand((sub) =>
          sub
            .setName("post")
            .setDescription("既存パネルをこのチャンネルに再設置します（管理者）")
            .addIntegerOption((o) => o.setName("id").setDescription("設置するパネルID").setRequired(true)),
        ),
    )
    // ── settings ──────────────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("settings")
        .setDescription("グローバル設定（スタッフロール・カテゴリー等）（管理者）")
        .addRoleOption((o) => o.setName("staff_role").setDescription("チケット対応スタッフのロール").setRequired(false))
        .addRoleOption((o) => o.setName("rename_role").setDescription("チャンネル名を変更できるロール").setRequired(false))
        .addChannelOption((o) =>
          o.setName("category").setDescription("チケットチャンネルを作るカテゴリー").addChannelTypes(ChannelType.GuildCategory).setRequired(false),
        )
        .addStringOption((o) =>
          o.setName("channel_prefix").setDescription("チャンネル名プレフィックス（例: support → support-名前）").setRequired(false).setMaxLength(20),
        )
        .addBooleanOption((o) => o.setName("mention_user").setDescription("チケット作成者をメンションするか").setRequired(false))
        .addBooleanOption((o) => o.setName("mention_staff").setDescription("スタッフロールをメンションするか").setRequired(false)),
    )
    // ── rename ────────────────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("rename")
        .setDescription("チケットチャンネルの名前を変更します")
        .addStringOption((o) => o.setName("name").setDescription("新しいチャンネル名").setRequired(true).setMaxLength(100)),
    ),

  async execute(interaction) {
    const guildId = requireGuild(interaction);
    const group = interaction.options.getSubcommandGroup(false);
    const sub   = interaction.options.getSubcommand();

    // ── rename ────────────────────────────────────────────────────────────────
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
      const member   = interaction.member as import("discord.js").GuildMember | null;
      const isAdmin  = requireAdmin(interaction);
      const hasRenameRole = settings?.renameRoleId ? member?.roles.cache.has(settings.renameRoleId) ?? false : false;
      if (!isAdmin && !hasRenameRole) {
        const mention = settings?.renameRoleId ? ` または <@&${settings.renameRoleId}>` : "";
        await interaction.reply({ content: `チャンネル名の変更は管理者${mention} のみ可能です。`, ephemeral: true, allowedMentions: { parse: [] } });
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

    // ── settings ──────────────────────────────────────────────────────────────
    if (sub === "settings" && group === null) {
      const staffRole     = interaction.options.getRole("staff_role");
      const renameRole    = interaction.options.getRole("rename_role");
      const category      = interaction.options.getChannel("category");
      const channelPrefix = interaction.options.getString("channel_prefix");
      const mentionUser   = interaction.options.getBoolean("mention_user");
      const mentionStaff  = interaction.options.getBoolean("mention_staff");

      const hasAny = staffRole || renameRole || category || channelPrefix !== null || mentionUser !== null || mentionStaff !== null;
      if (!hasAny) {
        const s = await getTicketSettings(guildId);
        const embed = new EmbedBuilder()
          .setTitle("🎫 チケット グローバル設定")
          .setColor(0xfee75c)
          .addFields(
            { name: "スタッフロール",           value: s?.staffRoleId          ? `<@&${s.staffRoleId}>` : "未設定", inline: true },
            { name: "名前変更ロール",           value: s?.renameRoleId         ? `<@&${s.renameRoleId}>` : "未設定", inline: true },
            { name: "チケットカテゴリー",       value: s?.categoryId           ? `<#${s.categoryId}>` : "未設定", inline: true },
            { name: "チャンネルプレフィックス", value: s?.channelNamePrefix    ?? TICKET_DEFAULTS.channelNamePrefix, inline: true },
            { name: "ユーザーメンション",       value: s?.mentionUser  !== false ? "オン ✅" : "オフ ❌", inline: true },
            { name: "スタッフメンション",       value: s?.mentionStaff !== false ? "オン ✅" : "オフ ❌", inline: true },
          );
        await interaction.reply({ embeds: [embed], ephemeral: true, allowedMentions: { parse: [] } });
        return;
      }

      const updates: Parameters<typeof upsertTicketSettings>[1] = {};
      if (staffRole)             updates.staffRoleId        = staffRole.id;
      if (renameRole)            updates.renameRoleId       = renameRole.id;
      if (category)              updates.categoryId         = category.id;
      if (channelPrefix)         updates.channelNamePrefix  = channelPrefix;
      if (mentionUser  !== null) updates.mentionUser        = mentionUser;
      if (mentionStaff !== null) updates.mentionStaff       = mentionStaff;
      await upsertTicketSettings(guildId, updates);

      const lines = [
        staffRole             && `スタッフロール: <@&${staffRole.id}>`,
        renameRole            && `名前変更ロール: <@&${renameRole.id}>`,
        category              && `カテゴリー: <#${category.id}>`,
        channelPrefix         && `プレフィックス: **${channelPrefix}**`,
        mentionUser  !== null && `ユーザーメンション: ${mentionUser ? "オン" : "オフ"}`,
        mentionStaff !== null && `スタッフメンション: ${mentionStaff ? "オン" : "オフ"}`,
      ].filter(Boolean).join("\n");
      await interaction.reply({ content: `✅ 設定しました。\n${lines}`, ephemeral: true, allowedMentions: { parse: [] } });
      return;
    }

    // ── panel group ───────────────────────────────────────────────────────────
    if (group === "panel") {

      // create ────────────────────────────────────────────────────────────────
      if (sub === "create") {
        const name = interaction.options.getString("name", true);
        const opts = collectPanelOpts(interaction);
        if (opts === null) {
          await interaction.reply({ content: "❌ 色は `#5865F2` のような6桁の16進数で指定してください。", ephemeral: true });
          return;
        }
        const panel = await createTicketPanel(guildId, name, opts);
        const embed = panelEmbed(panel);
        const row   = new ActionRowBuilder<ButtonBuilder>().addComponents(buildPanelButton(panel));
        await interaction.reply({ content: `✅ パネル **${name}** (ID: ${panel.id}) を作成して設置しました。`, ephemeral: true });
        if (interaction.channel?.isSendable()) await interaction.channel.send({ embeds: [embed], components: [row] });
        return;
      }

      // edit ──────────────────────────────────────────────────────────────────
      if (sub === "edit") {
        const id   = interaction.options.getInteger("id", true);
        const name = interaction.options.getString("name") ?? undefined;
        const opts = collectPanelOpts(interaction);
        if (opts === null) {
          await interaction.reply({ content: "❌ 色は `#5865F2` のような6桁の16進数で指定してください。", ephemeral: true });
          return;
        }
        const updates = { ...opts, ...(name ? { name } : {}) };
        if (Object.keys(updates).length === 0) {
          await interaction.reply({ content: "変更する項目を少なくとも1つ指定してください。", ephemeral: true });
          return;
        }
        const ok = await updateTicketPanel(id, guildId, updates);
        if (!ok) {
          await interaction.reply({ content: `❌ パネル ID ${id} が見つかりません。\`/ticket panel list\` で確認してください。`, ephemeral: true });
          return;
        }
        await interaction.reply({ content: `✅ パネル ID **${id}** を更新しました。パネルを再設置するには \`/ticket panel post id:${id}\` を実行してください。`, ephemeral: true });
        return;
      }

      // list ──────────────────────────────────────────────────────────────────
      if (sub === "list") {
        const panels = await listTicketPanels(guildId);
        if (panels.length === 0) {
          await interaction.reply({ content: "パネルがまだありません。`/ticket panel create` で作成してください。", ephemeral: true });
          return;
        }
        const fields = panels.map((p) => ({
          name: `ID ${p.id} — ${p.name}`,
          value: [
            `タイトル: ${p.panelTitle ?? TICKET_DEFAULTS.panelTitle}`,
            `ボタン: ${p.panelButtonLabel ?? TICKET_DEFAULTS.panelButtonLabel} | ${styleLabel(p.panelButtonStyle, "青")}`,
            p.mentionRoleIds && p.mentionRoleIds.length > 0
              ? `メンション: ${p.mentionRoleIds.map((id) => `<@&${id}>`).join(" ")}`
              : "メンション: （未設定 — グローバル設定を使用）",
          ].join("\n"),
          inline: false,
        }));
        const embed = new EmbedBuilder()
          .setTitle(`🎫 チケットパネル一覧（${panels.length}件）`)
          .setColor(0xfee75c)
          .addFields(fields);
        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      // delete ────────────────────────────────────────────────────────────────
      if (sub === "delete") {
        const id = interaction.options.getInteger("id", true);
        const ok = await deleteTicketPanel(id, guildId);
        if (!ok) {
          await interaction.reply({ content: `❌ パネル ID ${id} が見つかりません。`, ephemeral: true });
          return;
        }
        await interaction.reply({ content: `✅ パネル ID **${id}** を削除しました。（既存の設置済みメッセージはDiscord上に残ります）`, ephemeral: true });
        return;
      }

      // post ──────────────────────────────────────────────────────────────────
      if (sub === "post") {
        const id    = interaction.options.getInteger("id", true);
        const panel = await getTicketPanel(id);
        if (!panel || panel.guildId !== guildId) {
          await interaction.reply({ content: `❌ パネル ID ${id} が見つかりません。`, ephemeral: true });
          return;
        }
        const embed = panelEmbed(panel);
        const row   = new ActionRowBuilder<ButtonBuilder>().addComponents(buildPanelButton(panel));
        await interaction.reply({ content: `✅ パネル **${panel.name}** (ID: ${id}) を設置しました。`, ephemeral: true });
        if (interaction.channel?.isSendable()) await interaction.channel.send({ embeds: [embed], components: [row] });
        return;
      }
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
        .setDescription("このサーバーでのVCの滞在時間の記録を停止します"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("optout-all")
        .setDescription("すべてのサーバーでVCの滞在時間の記録を一括停止します（グローバル設定）"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("optin")
        .setDescription("VCの滞在時間の記録を再開します（このサーバー＆グローバル設定を解除）"),
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
          "ℹ️ 参加中の**すべてのサーバーで一括停止**したい場合は `/privacy optout-all` を使用してください。\n\n" +
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

    if (sub === "optout-all") {
      const embed = new EmbedBuilder()
        .setTitle("🌐 すべてのサーバーでVCトラッキングを停止しますか？")
        .setColor(0xfee75c)
        .setDescription(
          "Botが参加している**すべてのサーバー**でVCの滞在時間の記録を停止します。\n" +
          "この設定はグローバルに適用され、サーバーごとの設定より優先されます。\n\n" +
          "過去のデータをどうするか選択してください。\n\n" +
          "**🗄️ 停止のみ（データを保持）**\n" +
          "• 新しい記録はどのサーバーでも残りません\n" +
          "• 各サーバーの既存データはそのまま残ります\n\n" +
          "**🗑️ 停止＋全サーバーの過去データを削除（取り消し不可）**\n" +
          "• 新しい記録はどのサーバーでも残りません\n" +
          "• **すべてのサーバー**でのVC記録が完全に削除されます",
        )
        .setTimestamp();
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(COMM_PRIVACY_GLOBAL_OPTOUT_KEEP)
          .setLabel("全サーバーで停止（データを保持）")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(COMM_PRIVACY_GLOBAL_OPTOUT_DELETE)
          .setLabel("全サーバーで停止＋全データ削除 🗑️")
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
      // Clear both global and per-guild opt-out so the user resumes tracking everywhere.
      await Promise.all([
        setVcGlobalPrivacyOptOut(userId, false),
        setVcPrivacyOptOut(guildId, userId, false),
      ]);
      const embed = new EmbedBuilder()
        .setTitle("🔓 トラッキングを再開しました")
        .setColor(0x57f287)
        .setDescription(
          "VCの滞在時間の記録を**再開**しました。\n\n" +
          "• これ以降のVCセッションが記録されます（このサーバー＆グローバル設定を解除）\n" +
          "• `/ranking` や `/mystats` にあなたのデータが表示されます\n\n" +
          "停止するには `/privacy optout`（このサーバー）または `/privacy optout-all`（全サーバー）を使用してください。",
        )
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === "status") {
      const [globalOptedOut, guildOptedOut] = await Promise.all([
        isVcTrackingGloballyOptedOut(userId),
        isVcTrackingGuildLocalOptedOut(guildId, userId),
      ]);
      const effectivelyOptedOut = globalOptedOut || guildOptedOut;

      let statusValue: string;
      if (globalOptedOut) {
        statusValue = "🔴 **全サーバーで停止中（グローバル）** — `/privacy optin` で再開できます";
      } else if (guildOptedOut) {
        statusValue = "🔴 **このサーバーで停止中** — `/privacy optin` で再開できます";
      } else {
        statusValue = "🟢 **有効** — `/privacy optout` で停止、`/privacy optout-all` で全サーバー停止";
      }

      const embed = new EmbedBuilder()
        .setTitle("🔎 プライバシー設定")
        .setColor(effectivelyOptedOut ? 0xed4245 : 0x57f287)
        .addFields(
          {
            name: "VCトラッキング",
            value: statusValue,
            inline: false,
          },
          {
            name: "グローバル設定",
            value: globalOptedOut
              ? "🌐 **すべてのサーバーで停止中**"
              : "— （グローバル停止なし）",
            inline: true,
          },
          {
            name: "このサーバーの設定",
            value: guildOptedOut
              ? "🔴 停止中"
              : "🟢 有効",
            inline: true,
          },
        )
        .setFooter({ text: "グローバル設定はサーバーごとの設定より優先されます。サーバーを退出・再参加しても設定は保持されます。" })
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

  // ── Load global + per-panel settings ──────────────────────────────────────
  const settings = await getTicketSettings(guildId);

  // Parse panelId from customId: "comm:ticket:panel:<id>"
  let panel: Awaited<ReturnType<typeof getTicketPanel>> = undefined;
  if (interaction.customId.startsWith(COMM_TICKET_PANEL_PREFIX)) {
    const rawId = parseInt(interaction.customId.slice(COMM_TICKET_PANEL_PREFIX.length), 10);
    if (!isNaN(rawId)) panel = await getTicketPanel(rawId).catch(() => undefined);
  }

  const me = interaction.guild.members.me;
  if (!me?.permissions.has("ManageChannels")) {
    await interaction.editReply("BotにManageChannels権限がありません。");
    return;
  }

  // ── Channel name: global prefix setting ───────────────────────────────────
  const prefix = settings?.channelNamePrefix ?? TICKET_DEFAULTS.channelNamePrefix;
  const suffix = Date.now().toString(36).slice(-4);
  const channelName = `${prefix}-${interaction.user.username.slice(0, 20)}-${suffix}`;

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

  // ── Category: global setting, fallback to hardcoded ───────────────────────
  const categoryId = settings?.categoryId ?? TICKET_CATEGORY_FALLBACK;

  let channel;
  try {
    channel = await interaction.guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: categoryId,
      permissionOverwrites: overwrites,
    });
  } catch (err) {
    logger.error("[ticket] Failed to create channel", err);
    await interaction.editReply("チャンネルの作成に失敗しました。");
    return;
  }

  const ticket = await createTicket(guildId, channel.id, interaction.user.id);

  // ── Welcome embed: per-panel settings > defaults ──────────────────────────
  const welcome    = panel?.welcomeMessage    ?? TICKET_DEFAULTS.welcomeMessage;
  const embedTitle = panel?.welcomeEmbedTitle ?? TICKET_DEFAULTS.welcomeEmbedTitle;
  const colorInt   = panel?.welcomeEmbedColor ? hexToInt(panel.welcomeEmbedColor) : TICKET_DEFAULTS.welcomeEmbedColor;
  const embed = new EmbedBuilder()
    .setTitle(embedTitle)
    .setColor(colorInt)
    .setDescription(`<@${interaction.user.id}> からのチケットです。\n${welcome}`)
    .setTimestamp();

  // ── Close button: per-panel settings > defaults ───────────────────────────
  const closeLabel = panel?.closeButtonLabel ?? TICKET_DEFAULTS.closeButtonLabel;
  const closeStyle = resolveButtonStyle(panel?.closeButtonStyle, TICKET_DEFAULTS.closeButtonStyle);
  const closeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${COMM_TICKET_CLOSE_PREFIX}${ticket.id}`)
      .setLabel(closeLabel)
      .setStyle(closeStyle),
  );

  // ── Mention content ───────────────────────────────────────────────────────
  // Priority: per-panel mentionRoleIds → global mentionStaff+staffRoleId fallback
  const mentionUser = settings?.mentionUser !== false;
  const contentParts: string[] = [];
  if (mentionUser) contentParts.push(`<@${interaction.user.id}>`);

  if (panel?.mentionRoleIds && panel.mentionRoleIds.length > 0) {
    // Use per-panel role list
    for (const roleId of panel.mentionRoleIds) contentParts.push(`<@&${roleId}>`);
  } else {
    // Legacy fallback: global mentionStaff + staffRoleId
    if (settings?.mentionStaff !== false && settings?.staffRoleId) {
      contentParts.push(`<@&${settings.staffRoleId}>`);
    }
  }
  const content = contentParts.join(" ") || undefined;

  await channel.send({ content, embeds: [embed], components: [closeRow] });
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

export async function handlePrivacyGlobalOptoutKeep(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferUpdate();
  await setVcGlobalPrivacyOptOut(interaction.user.id, true);
  const embed = new EmbedBuilder()
    .setTitle("🌐 全サーバーでトラッキングを停止しました")
    .setColor(0xed4245)
    .setDescription(
      "すべてのサーバーでVCの滞在時間の記録を**停止**しました。\n\n" +
      "• 新しいセッションはどのサーバーでも記録されません\n" +
      "• 各サーバーの過去データはそのまま残ります\n\n" +
      "再開するには `/privacy optin` を使用してください。",
    )
    .setTimestamp();
  await interaction.editReply({ embeds: [embed], components: [] });
}

export async function handlePrivacyGlobalOptoutDelete(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferUpdate();
  const userId = interaction.user.id;
  const [deleted] = await Promise.all([
    deleteAllUserVcSessions(userId),
    setVcGlobalPrivacyOptOut(userId, true),
  ]);
  const embed = new EmbedBuilder()
    .setTitle("🗑️ 全サーバーでトラッキングを停止し、全データを削除しました")
    .setColor(0xed4245)
    .setDescription(
      `すべてのサーバーのVC滞在記録 **${deleted}件** を削除し、グローバルトラッキングを停止しました。\n\n` +
      "• ランキングや統計からあなたのデータはすべて除外されます\n" +
      "• 再開するには `/privacy optin` を使用してください",
    )
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
        if (role) buttons.push({ role: role as import("discord.js").Role, label: (label ?? role.name).slice(0, 80), style });
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
      // customId must be unique per message, so use index-based placeholders
      const placeholderRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        buttons.map((b, i) =>
          new ButtonBuilder()
            .setCustomId(`pending:${i}`)
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

  // 排他制御：同一パネル内の他のロールをすでに持っていたら拒否
  const panelButtons = await getRoleButtonsByMessage(btnRecord.messageId);
  const panelRoleIds = panelButtons.map((b) => b.roleId);
  const alreadyHeld  = panelRoleIds.find((rid) => member.roles.cache.has(rid));
  if (alreadyHeld) {
    await interaction.reply({
      content: "❌ すでにこのパネルからロールを選択済みです。変更はできません。",
      ephemeral: true,
    });
    return;
  }

  // 永久付与のみ（解除不可）
  try {
    await member.roles.add(role, "ロールボタンによる付与");
    await interaction.reply({ content: `✅ **${role.name}** を付与しました。`, ephemeral: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[role-btn] role change failed guildId=${interaction.guildId} userId=${member.id} roleId=${role.id}:`, msg);

    let hint = "Botに「ロールの管理」権限があるか、またBotのロールが対象ロールより上位か確認してください。";
    if (msg.includes("Missing Permissions")) hint = "Botの「ロールの管理」権限が不足しています。";
    if (msg.includes("Invalid Form Body") || msg.includes("50013")) hint = "BotのロールがDiscordサーバーのロール一覧で対象ロールより下にあります。Botのロールを上に移動してください。";

    await interaction.reply({ content: `ロールの変更に失敗しました。\n> ${hint}`, ephemeral: true });
  }
}

// ─── /leavelog ────────────────────────────────────────────────────────────────

const leavelogCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("leavelog")
    .setDescription("メンバー退出ログの設定をします（管理者用）")
    .addSubcommand((sub) =>
      sub
        .setName("setup")
        .setDescription("退出ログを送信するチャンネルを設定します")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("ログ送信先チャンネル")
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("disable").setDescription("退出ログを無効化します"),
    ),

  async execute(interaction) {
    const guildId = requireGuild(interaction);
    if (!requireAdmin(interaction)) {
      await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
      return;
    }
    const sub = interaction.options.getSubcommand();

    if (sub === "setup") {
      const channel = interaction.options.getChannel("channel", true);
      await setLeaveLogChannel(guildId, channel.id);
      await interaction.reply({ content: `✅ 退出ログを <#${channel.id}> に送信します。`, ephemeral: true });
      return;
    }

    if (sub === "disable") {
      await setLeaveLogChannel(guildId, null);
      await interaction.reply({ content: "退出ログを無効化しました。", ephemeral: true });
      return;
    }
  },
};

// ─── Exports ─────────────────────────────────────────────────────────────────

import { prebanCommand } from "./preban.js";
import { pointCommand } from "./point.js";

export const commands: Command[] = [
  rankingCommand,
  mystatsCommand,
  privacyCommand,
  eventCommand,
  ticketCommand,
  botstatusCommand,
  roleButtonCommand,
  leavelogCommand,
  prebanCommand,
  pointCommand,
];
