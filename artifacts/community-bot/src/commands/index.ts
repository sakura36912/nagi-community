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
import { zombieCommands } from "./zombie.js";
import {
  addParticipant,
  createEvent,
  deleteEvent,
  editEvent,
  createRoleButton,
  deleteRoleButtonsByMessage,
  getEvent,
  getParticipants,
  deleteUserVcSessions,
  getActiveSession,
  getActiveSessionCount,
  getRoleButtonById,
  getRoleButtonsByMessage,
  getEventSettings,
  getUserVcRank,
  getVcRanking,
  getVcTimeInPeriod,
  getVcTimeByChannelIds,
  getVcTimeForTavernAndBeach,
  isVcTrackingOptedOut,
  listRoleButtonPanels,
  listUpcomingEvents,
  setEventSettings,
  removeParticipant,
  setLeaveLogChannel,
  setRankingSettings,
  setVcSessionRetentionDays,
  getVcSessionRetentionDays,
  setStaffRole,
  setVcPrivacyOptOut,
  setVcGlobalPrivacyOptOut,
  setVcPrivacyOptin,
  isVcTrackingGloballyOptedOut,
  isVcTrackingGuildLocalOptedOut,
  deleteAllUserVcSessions,
  updateEventMessageId,
  getAllTempVcDeletions,
  getAuditLogChannel,
  setAuditLogChannel,
  countCompletedSessionsOlderThan,
  buildTempVcCsv,
  wipeGuildVcSessions,
  getTrackedVcCategoryId,
  setTrackedVcCategoryId,
  getTicketSettings,
  getTicketPanel,
  upsertTicketSettings,
  createTicket,
} from "../lib/community.js";

// ─── Prefix constants ────────────────────────────────────────────────────────

export const COMM_EVENT_JOIN_PREFIX = "comm:event:join:";
export const COMM_EVENT_CANCEL_PREFIX = "comm:event:cancel:";

export const COMM_PRIVACY_DELETE_CONFIRM = "comm:privacy:delete:confirm";
export const COMM_PRIVACY_DELETE_CANCEL = "comm:privacy:delete:cancel";
export const COMM_PRIVACY_OPTOUT_KEEP = "comm:privacy:optout:keep";
export const COMM_PRIVACY_OPTOUT_DELETE = "comm:privacy:optout:delete";
export const COMM_PRIVACY_GLOBAL_OPTOUT_KEEP = "comm:privacy:global:optout:keep";
export const COMM_PRIVACY_GLOBAL_OPTOUT_DELETE = "comm:privacy:global:optout:delete";
export const COMM_PRIVACY_ADMIN_DELETE_CONFIRM_PREFIX = "comm:privacy:admin-delete:confirm:";
export const COMM_PRIVACY_ADMIN_DELETE_CANCEL_PREFIX = "comm:privacy:admin-delete:cancel:";
export const COMM_BOTSTATUS_REFRESH = "comm:botstatus:refresh";
export const COMM_RETENTION_CONFIRM_PREFIX = "comm:retention:confirm:";
export const COMM_RETENTION_CANCEL_PREFIX = "comm:retention:cancel:";

/** Button custom ID prefix for opening a ticket (suffix is an optional panel ID). */
export const COMM_TICKET_CREATE_PREFIX = "comm:ticket:create:";

/**
 * Server-side expiry registry for short-retention confirmation embeds.
 *
 * Key: a per-confirmation nonce (crypto.randomUUID()) embedded in the button
 * custom ID.  Value: the originating guildId, requested days, and an expiry
 * timestamp (ms).  Using a nonce instead of `guildId:days` means two
 * concurrent confirmations for the same guild+days are independent — each has
 * its own entry and neither invalidates the other.  The entry is consumed
 * (deleted) when the admin clicks "確定する" or "キャンセル", or when the
 * 60-second timeout fires.
 */
export const retentionConfirmExpiry = new Map<string, { guildId: string; days: number; expiry: number }>();

// ─── Ticket defaults ─────────────────────────────────────────────────────────

/**
 * Default values used when no custom welcome message is configured for a guild.
 * Panel settings override global ticket settings, which override these defaults.
 */
export const TICKET_DEFAULTS = {
  embedTitle: "🎫 サポートチケット",
  message: "用件をお書きください。スタッフが対応します。",
} as const;

/**
 * Resolves the welcome embed title and description from pre-fetched data.
 * Resolution order (first non-null wins):
 *   1. Per-panel welcomeEmbedTitle / welcomeMessage (guild-scoped; see caller)
 *   2. Guild-level ticket settings welcomeEmbedTitle / welcomeMessage
 *   3. TICKET_DEFAULTS
 *
 * Not exported — callers use handleTicketCreate or handleTicketOpen.
 */
function buildWelcomeEmbed(
  settings: { welcomeEmbedTitle?: string | null; welcomeMessage?: string | null } | undefined,
  panel:    { welcomeEmbedTitle?: string | null; welcomeMessage?: string | null } | undefined,
): EmbedBuilder {
  const title =
    panel?.welcomeEmbedTitle ??
    settings?.welcomeEmbedTitle ??
    TICKET_DEFAULTS.embedTitle;

  const description =
    panel?.welcomeMessage ??
    settings?.welcomeMessage ??
    TICKET_DEFAULTS.message;

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(0x5865f2);
}

/**
 * Builds the welcome embed posted in a newly created ticket channel.
 * Exported for unit testing; the production path goes through handleTicketOpen.
 *
 * Resolution order (first non-null wins):
 *   1. Per-panel welcomeEmbedTitle / welcomeMessage (when panelId is provided
 *      and the panel belongs to guildId — cross-guild panels are ignored)
 *   2. Guild-level ticket settings welcomeEmbedTitle / welcomeMessage
 *   3. TICKET_DEFAULTS
 */
export async function handleTicketCreate(
  guildId: string,
  panelId?: number | null,
): Promise<EmbedBuilder> {
  const [settings, rawPanel] = await Promise.all([
    getTicketSettings(guildId),
    panelId != null ? getTicketPanel(panelId) : Promise.resolve(undefined),
  ]);

  // Guild-scope guard: only apply panel overrides when the panel belongs to
  // the same guild that is opening the ticket.  A panel from another guild
  // must never influence this guild's welcome embed.
  const panel = rawPanel?.guildId === guildId ? rawPanel : undefined;

  return buildWelcomeEmbed(settings, panel);
}

/**
 * Handles the "open ticket" button click.
 *
 * Workflow:
 *   1. Read ticket settings + optional panel in a single parallel fetch.
 *   2. Create a private text channel for the user.
 *   3. Record the ticket in the DB.
 *   4. Build the welcome embed from the fetched settings (configured
 *      welcomeEmbedTitle / welcomeMessage, or TICKET_DEFAULTS).
 *   5. Send the embed as the first message in the new channel.
 *
 * The button custom ID must be `${COMM_TICKET_CREATE_PREFIX}<panelId>` where
 * panelId is an integer, or `${COMM_TICKET_CREATE_PREFIX}` (empty suffix) for
 * guild-default settings with no panel override.
 */
export async function handleTicketOpen(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({ content: "サーバー内でのみ使用できます。", ephemeral: true });
    return;
  }

  const guildId = interaction.guildId;
  const userId = interaction.user.id;

  // Parse optional panelId from the button suffix (empty string → null).
  const suffix = interaction.customId.slice(COMM_TICKET_CREATE_PREFIX.length);
  const panelId = suffix ? Number(suffix) || null : null;

  await interaction.deferReply({ ephemeral: true });

  // Fetch settings and panel in one round-trip so we don't query the DB twice.
  const [settings, rawPanel] = await Promise.all([
    getTicketSettings(guildId),
    panelId != null ? getTicketPanel(panelId) : Promise.resolve(undefined),
  ]);

  // Guild-scope guard: ignore panels from other guilds.
  const panel = rawPanel?.guildId === guildId ? rawPanel : undefined;

  const categoryId = settings?.categoryId ?? null;
  const prefix     = settings?.channelNamePrefix ?? "ticket";

  // Create the private ticket channel.
  const channelName = `${prefix}-${interaction.user.username}`.slice(0, 100);
  const channel = await interaction.guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: categoryId ?? undefined,
    permissionOverwrites: [
      { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: userId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      ...(settings?.staffRoleId
        ? [{ id: settings.staffRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] } as OverwriteResolvable]
        : []),
    ],
  });

  // Record the ticket so it can be listed/closed later.
  await createTicket(guildId, channel.id, userId);

  // Build the welcome embed from the already-fetched settings (no second DB
  // round-trip) and post it as the first message in the channel.
  const embed = buildWelcomeEmbed(settings, panel);
  await channel.send({ embeds: [embed] });

  await interaction.editReply(`✅ チケットを作成しました: <#${channel.id}>`);
}

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
  ranking: { userId: string; totalSeconds: number; isLive?: boolean }[],
  activeCount: number,
  period: RankingPeriod,
): EmbedBuilder {
  const medals = ["🥇", "🥈", "🥉"];
  const lines = ranking.map((entry, i) => {
    const prefix = medals[i] ?? `**${i + 1}.**`;
    return `${prefix} <@${entry.userId}> — ${formatSeconds(entry.totalSeconds)}`;
  });

  return new EmbedBuilder()
    .setTitle(`🎙️ VC滞在時間ランキング（${RANKING_PERIOD_LABELS[period]}）`)
    .setColor(0xf5a623)
    .setDescription(lines.join("\n"))
    .setTimestamp();
}

const rankingCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("ranking")
    .setDescription("VC滞在時間のランキングを表示・設定します")
    .setDefaultMemberPermissions(0)
    .addSubcommand((sub) =>
      sub
        .setName("show")
        .setDescription("VC累計滞在時間ランキングを表示します"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("setup")
        .setDescription("毎日0時に累計ランキングを自動投稿するチャンネルを設定します（管理者用）")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("投稿先チャンネル")
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("me")
        .setDescription("自分のVC順位と累計滞在時間を確認します"),
    )
    .addSubcommand((sub) =>
      sub.setName("disable").setDescription("毎日の自動投稿を停止します（管理者用）"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("retention-days")
        .setDescription("VCセッション履歴の保持期間を設定します（管理者用）")
        .addIntegerOption((opt) =>
          opt
            .setName("days")
            .setDescription("保持日数（1〜3650）。省略すると現在の設定を表示。0を指定するとデフォルト（180日）にリセット。")
            .setRequired(false)
            .setMinValue(0)
            .setMaxValue(3650),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("tracked-category")
        .setDescription("VC滞在時間を計測するカテゴリーを設定します（管理者用）")
        .addChannelOption((opt) =>
          opt
            .setName("category")
            .setDescription("追跡対象のカテゴリー（省略すると現在の設定を表示）")
            .setRequired(false)
            .addChannelTypes(ChannelType.GuildCategory),
        )
        .addBooleanOption((opt) =>
          opt.setName("clear").setDescription("カテゴリー制限を解除して全チャンネルを追跡する").setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("reset")
        .setDescription("このサーバーのVC滞在時間をすべてリセットします（管理者用・取り消し不可）")
        .addBooleanOption((opt) =>
          opt.setName("confirm").setDescription("true を指定するとリセットを実行します").setRequired(false),
        ),
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

      const now = new Date();

      const [rank, seconds, activeSession] = await Promise.all([
        getUserVcRank(guildId, interaction.user.id, undefined),
        getVcTimeInPeriod(guildId, interaction.user.id, new Date(0), now),
        getActiveSession(guildId, interaction.user.id),
      ]);

      const rankText = rank != null ? `第 **${rank}** 位` : "圏外（記録なし）";
      const timeText = formatSeconds(seconds);

      const liveSeconds = activeSession
        ? Math.floor((now.getTime() - activeSession.joinedAt.getTime()) / 1000)
        : 0;

      const embed = new EmbedBuilder()
        .setTitle("🏆 あなたのVCランク（累計）")
        .setColor(activeSession ? 0xed4245 : 0xf5a623)
        .setThumbnail((interaction.member as GuildMember)?.displayAvatarURL() ?? interaction.user.displayAvatarURL())
        .addFields(
          { name: "順位", value: rankText, inline: true },
          { name: "累計滞在時間", value: timeText, inline: true },
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
      const [ranking, activeCount] = await Promise.all([
        getVcRanking(guildId, undefined),
        getActiveSessionCount(guildId),
      ]);

      if (ranking.length === 0) {
        await interaction.editReply("まだVC滞在記録がありません。");
        return;
      }

      await interaction.editReply({ embeds: [buildRankingEmbed(ranking, activeCount, "all")] });
      return;
    }

    // ── setup / disable — admin only ──────────────────────────────────────────
    if (!requireAdmin(interaction)) {
      await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
      return;
    }

    if (sub === "setup") {
      const channel = interaction.options.getChannel("channel", true);
      await setRankingSettings(guildId, channel.id, "all");
      await interaction.reply({
        content: `毎日0時（JST）に <#${channel.id}> へ **累計ランキング** を投稿します。`,
        ephemeral: true,
      });
      return;
    }

    if (sub === "disable") {
      await setRankingSettings(guildId, null, "today");
      await interaction.reply({ content: "毎日のランキング自動投稿を停止しました。", ephemeral: true });
      return;
    }

    if (sub === "retention-days") {
      const days = interaction.options.getInteger("days");

      // No argument → show current setting
      if (days === null) {
        const current = await getVcSessionRetentionDays(guildId);
        await interaction.reply({
          content: `現在のVCセッション保持期間は **${current}日** です（カスタム設定がない場合はデフォルトの180日）。`,
          ephemeral: true,
        });
        return;
      }

      // days=0 → reset to default
      if (days === 0) {
        await setVcSessionRetentionDays(guildId, null);
        await interaction.reply({
          content: "VCセッションの保持期間をデフォルト（**180日**）にリセットしました。",
          ephemeral: true,
        });
        return;
      }

      // days < 30 → reject; a floor of 30 prevents accidental data loss from typos
      if (days < 30) {
        await interaction.reply({
          content:
            `⛔ 保持期間は最低 **30日** 以上に設定してください（入力値: **${days}日**）。\n\n` +
            "30日未満に設定すると直近のVC履歴が次回プルーン時に失われる可能性があります。\n" +
            "設定をリセットしたい場合は `0` を指定してください（デフォルト: **180日**）。",
          ephemeral: true,
        });

        // Notify the audit log channel (if configured) that the floor guard
        // fired so admins can see a record of the rejected attempt.
        const auditChannelId = await getAuditLogChannel(guildId);
        if (auditChannelId) {
          try {
            const auditChannel =
              interaction.guild?.channels.cache.get(auditChannelId) ??
              (await interaction.guild?.channels.fetch(auditChannelId).catch(() => null));
            if (auditChannel?.isTextBased()) {
              const auditEmbed = new EmbedBuilder()
                .setTitle("⛔ 保持期間の最低日数ガードが発動しました")
                .setColor(0xed4245)
                .setDescription(
                  "管理者が30日未満の保持期間を設定しようとしました。コマンドは拒否されました。",
                )
                .addFields(
                  { name: "操作者", value: `<@${interaction.user.id}>`, inline: true },
                  { name: "入力値", value: `${days}日`, inline: true },
                  { name: "最低値", value: "30日", inline: true },
                )
                .setFooter({ text: `操作者ID: ${interaction.user.id}` })
                .setTimestamp();
              await auditChannel.send({ embeds: [auditEmbed] });
            }
          } catch (err) {
            logger.error("[ranking] Failed to post floor-guard notice to audit log channel", err);
          }
        }

        return;
      }

      // days >= 30 but < 180 → short-retention warning: show dry-run count and
      // require explicit 2-step confirmation.  The embed expires after 60 s so
      // a non-admin who gains the message after the original admin leaves cannot
      // replay the confirm button.
      if (days < 180) {
        await interaction.deferReply({ ephemeral: true });
        const affected = await countCompletedSessionsOlderThan(guildId, days);

        const warnEmbed = new EmbedBuilder()
          .setTitle("⚠️ 保持期間を短縮しますか？")
          .setColor(0xfee75c)
          .setDescription(
            `保持期間を **${days}日** に設定しようとしています。\n\n` +
            (affected > 0
              ? `現在、**${affected}件** のVC記録がこの日数より古く、次回のプルーン時に削除されます。\n\n`
              : `現在、この日数より古いVC記録はありません。\n\n`) +
            "• 削除されたデータは復元できません\n" +
            "• この操作は次回のプルーン実行時に効果を発揮します\n\n" +
            "本当に設定を変更しますか？",
          )
          .setFooter({ text: "このボタンは60秒後に無効になります" })
          .setTimestamp();

        // Generate a per-confirmation nonce so two concurrent confirmations for
        // the same guild+days are independent entries in the server-side registry
        // and do not overwrite or invalidate each other.
        const nonce = crypto.randomUUID();
        retentionConfirmExpiry.set(nonce, { guildId, days, expiry: Date.now() + 60_000 });

        const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`${COMM_RETENTION_CONFIRM_PREFIX}${nonce}`)
            .setLabel("確定する")
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(`${COMM_RETENTION_CANCEL_PREFIX}${nonce}`)
            .setLabel("キャンセル")
            .setStyle(ButtonStyle.Secondary),
        );

        await interaction.editReply({ embeds: [warnEmbed], components: [confirmRow] });

        // Disable the buttons after 60 seconds to prevent stale replays by a
        // non-admin who encounters the message after the admin's session ends.
        setTimeout(async () => {
          // Expire this specific confirmation's registry entry.  If the admin
          // already confirmed or cancelled the entry has already been consumed,
          // so deleting a missing key is a harmless no-op.
          retentionConfirmExpiry.delete(nonce);
          try {
            const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId(`${COMM_RETENTION_CONFIRM_PREFIX}${nonce}`)
                .setLabel("確定する")
                .setStyle(ButtonStyle.Danger)
                .setDisabled(true),
              new ButtonBuilder()
                .setCustomId(`${COMM_RETENTION_CANCEL_PREFIX}${nonce}`)
                .setLabel("キャンセル")
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true),
            );
            const expiredEmbed = new EmbedBuilder()
              .setTitle("⏱️ タイムアウト")
              .setColor(0x808080)
              .setDescription("確認がタイムアウトしました。設定を変更する場合はコマンドを再実行してください。")
              .setTimestamp();
            await interaction.editReply({ embeds: [expiredEmbed], components: [disabledRow] });
          } catch { /* ignore – token expired or the admin already confirmed/cancelled */ }
        }, 60_000);

        return;
      }

      // days >= 180 → at or above the default retention; persist directly (no
      // data-loss risk relative to the default 180-day window).
      await setVcSessionRetentionDays(guildId, days);
      await interaction.reply({
        content: `VCセッションの保持期間を **${days}日** に設定しました。`,
        ephemeral: true,
      });
      return;
    }

    if (sub === "tracked-category") {
      const clear = interaction.options.getBoolean("clear");
      const category = interaction.options.getChannel("category");

      if (clear) {
        await setTrackedVcCategoryId(guildId, null);
        await interaction.reply({ content: "✅ カテゴリー制限を解除しました。全チャンネルのVC滞在時間を記録します。", ephemeral: true });
        return;
      }

      if (!category) {
        const current = await getTrackedVcCategoryId(guildId);
        const msg = current
          ? `現在の追跡カテゴリー: <#${current}>\nすべてのチャンネルに戻すには \`clear: true\` を指定してください。`
          : "現在カテゴリー制限はありません（全チャンネルを記録中）。";
        await interaction.reply({ content: msg, ephemeral: true });
        return;
      }

      await setTrackedVcCategoryId(guildId, category.id);
      await interaction.reply({
        content: `✅ VC滞在時間の追跡を <#${category.id}> カテゴリー内のチャンネルのみに設定しました。`,
        ephemeral: true,
      });
      return;
    }

    if (sub === "reset") {
      const confirm = interaction.options.getBoolean("confirm");
      if (!confirm) {
        await interaction.reply({
          content:
            "⚠️ このコマンドを実行するとこのサーバーの **全VC滞在時間データ** が削除されます。\n\n" +
            "実行するには `confirm: true` を付けて再度実行してください。この操作は取り消せません。",
          ephemeral: true,
        });
        return;
      }
      await interaction.deferReply({ ephemeral: true });
      const deleted = await wipeGuildVcSessions(guildId);
      await interaction.editReply(`✅ このサーバーのVC滞在時間データを **${deleted}件** 削除しました。`);

      // Post an audit-log embed so admins can see who triggered the wipe and
      // how many rows were removed.  Errors are swallowed so a missing or
      // unreachable audit channel never surfaces to the acting admin.
      const auditChannelId = await getAuditLogChannel(guildId);
      if (auditChannelId) {
        try {
          const auditChannel =
            interaction.guild?.channels.cache.get(auditChannelId) ??
            (await interaction.guild?.channels.fetch(auditChannelId).catch(() => null));
          if (auditChannel?.isTextBased()) {
            const auditEmbed = new EmbedBuilder()
              .setTitle("🗑️ VCセッションデータ全消去")
              .setColor(0xed4245)
              .setDescription("管理者がこのサーバーの全VCセッションデータを削除しました。")
              .addFields(
                { name: "操作者", value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
                { name: "削除件数", value: `${deleted}件`, inline: true },
                { name: "サーバー", value: interaction.guild?.name ?? guildId, inline: true },
              )
              .setFooter({ text: `操作者ID: ${interaction.user.id}` })
              .setTimestamp();
            await auditChannel.send({ embeds: [auditEmbed] });
          }
        } catch (err) {
          logger.error("[ranking reset] Failed to post wipe notice to audit log channel", err);
        }
      }

      return;
    }
  },
};

// ─── /mystats ────────────────────────────────────────────────────────────────

const mystatsCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("vc時間")
    .setDescription("自分（または指定メンバー）のVC滞在時間を確認します")
    .setDefaultMemberPermissions(0)
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
      .setThumbnail(interaction.guild?.members.cache.get(target.id)?.displayAvatarURL() ?? target.displayAvatarURL())
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

// ─── /vcランク ───────────────────────────────────────────────────────────────

const vcRankCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("vcランク")
    .setDescription("自分のVC順位と累計滞在時間を確認します"),

  async execute(interaction) {
    const guildId = requireGuild(interaction);
    await interaction.deferReply();

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

    const member = interaction.member as GuildMember;
    const isExile = member?.roles.cache.some(
      (r) => r.name === "追放者",
    ) ?? false;

    const now = new Date();

    // 砂浜チャンネルIDをギルドキャッシュから取得（名前に「砂浜」を含むVC）
    await interaction.guild!.channels.fetch().catch(() => {});
    const beachChannelIds = interaction.guild!.channels.cache
      .filter(
        (ch) =>
          (ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice) &&
          ch.name.includes("砂浜"),
      )
      .map((ch) => ch.id);

    const [rank, cumulativeSeconds, activeSession] = await Promise.all([
      isExile ? Promise.resolve(null) : getUserVcRank(guildId, interaction.user.id, undefined),
      // 酒場: community_tavern_channels.hub_name で DB 結合（削除済みチャンネルも含む）
      // 砂浜: guild cache から取得した砂浜チャンネルID
      getVcTimeForTavernAndBeach(
        guildId,
        interaction.user.id,
        ["大酒場🍺", "小酒場🍺"],
        beachChannelIds,
      ),
      getActiveSession(guildId, interaction.user.id),
    ]);

    const rankText = isExile
      ? "追放者として別記録中"
      : rank != null ? `第 **${rank}** 位` : "圏外（記録なし）";
    const timeText = formatSeconds(cumulativeSeconds);

    const liveSeconds = activeSession
      ? Math.floor((now.getTime() - activeSession.joinedAt.getTime()) / 1000)
      : 0;

    const embed = new EmbedBuilder()
      .setTitle("🏆 あなたのVCランク（累計）")
      .setColor(activeSession ? 0xed4245 : 0xf5a623)
      .setThumbnail(member?.displayAvatarURL() ?? interaction.user.displayAvatarURL())
      .addFields(
        { name: "順位", value: rankText, inline: true },
        { name: "累計時間", value: timeText, inline: true },
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
  },
};

// ─── /privacy ────────────────────────────────────────────────────────────────

const privacyCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("privacy")
    .setDescription("VCトラッキングのプライバシー設定を管理します")
    .setDefaultMemberPermissions(0)
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
    )
    .addSubcommand((sub) =>
      sub
        .setName("admin-delete")
        .setDescription("指定したメンバーのVC記録を削除します（ManageGuild権限が必要）")
        .addUserOption((opt) =>
          opt.setName("member").setDescription("対象ユーザー").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("audit-channel")
        .setDescription("管理者によるVC記録削除の監査ログチャンネルを設定します（管理者用）")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("監査ログを投稿するチャンネル（省略すると現在の設定を表示、'none'で無効化）")
            .setRequired(false)
            .addChannelTypes(ChannelType.GuildText),
        )
        .addBooleanOption((opt) =>
          opt.setName("disable").setDescription("監査ログを無効化する").setRequired(false),
        ),
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
          "• ランキングや `/vc時間` から完全に除外されます\n" +
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
      await handlePrivacyOptin(interaction);
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

    if (sub === "audit-channel") {
      if (!requireAdmin(interaction)) {
        await interaction.editReply("このコマンドはサーバー管理権限が必要です。");
        return;
      }

      const disable = interaction.options.getBoolean("disable") ?? false;
      const channel = interaction.options.getChannel("channel");

      // No arguments → show current setting
      if (!disable && !channel) {
        const current = await getAuditLogChannel(guildId);
        const embed = new EmbedBuilder()
          .setTitle("📋 監査ログ設定")
          .setColor(0x5865f2)
          .addFields({
            name: "監査ログチャンネル",
            value: current ? `<#${current}>` : "未設定（無効）",
            inline: false,
          })
          .setFooter({ text: "channel を指定して再実行するとチャンネルを設定できます。disable: true で無効化。" });
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (disable) {
        await setAuditLogChannel(guildId, null);
        await interaction.editReply("✅ 監査ログを無効化しました。");
        return;
      }

      await setAuditLogChannel(guildId, channel!.id);
      await interaction.editReply(`✅ 監査ログチャンネルを <#${channel!.id}> に設定しました。`);
      return;
    }

    if (sub === "admin-delete") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.editReply("このコマンドはサーバー管理（ManageGuild）権限が必要です。");
        return;
      }

      const targetUser = interaction.options.getUser("member", true);

      const embed = new EmbedBuilder()
        .setTitle("⚠️ メンバーのVC記録を削除しますか？")
        .setColor(0xfee75c)
        .setDescription(
          `<@${targetUser.id}> のこのサーバーにおける**すべてのVC滞在記録**を削除します。\n\n` +
          "• ランキングや統計からそのメンバーのデータが除外されます\n" +
          "• この操作は**取り消せません**\n\n" +
          "本当に削除しますか？",
        )
        .setFooter({ text: `対象ユーザーID: ${targetUser.id}` })
        .setTimestamp();
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${COMM_PRIVACY_ADMIN_DELETE_CONFIRM_PREFIX}${targetUser.id}`)
          .setLabel("削除する 🗑️")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`${COMM_PRIVACY_ADMIN_DELETE_CANCEL_PREFIX}${targetUser.id}`)
          .setLabel("キャンセル")
          .setStyle(ButtonStyle.Secondary),
      );
      await interaction.editReply({ embeds: [embed], components: [row] });
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
    .setDescription("Botのセットアップ状況を確認します（管理者）")
    .setDefaultMemberPermissions(0),
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
  // Guild ownership check: reject replayed buttons from other guilds.
  const event = await getEvent(eventId);
  if (!event || event.guildId !== interaction.guildId) {
    await interaction.followUp({ content: "❌ このイベントはこのサーバーでは無効です。", ephemeral: true });
    return;
  }
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
  // Guild ownership check: reject replayed buttons from other guilds.
  const event = await getEvent(eventId);
  if (!event || event.guildId !== interaction.guildId) {
    await interaction.followUp({ content: "❌ このイベントはこのサーバーでは無効です。", ephemeral: true });
    return;
  }
  const removed = await removeParticipant(eventId, interaction.user.id);
  const { embed, rows } = await buildEventEmbed(eventId);
  await interaction.editReply({ embeds: [embed], components: rows });
  if (removed) {
    await interaction.followUp({ content: "❌ 参加をキャンセルしました。", ephemeral: true });
  } else {
    await interaction.followUp({ content: "参加登録されていませんでした。", ephemeral: true });
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

export async function handlePrivacyOptin(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.editReply("このコマンドはサーバー内でのみ使用できます。");
    return;
  }
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  // Clear both global and per-guild opt-out atomically so a transient DB error
  // on either write cannot leave the user in a mixed opted-in/opted-out state.
  await setVcPrivacyOptin(guildId, userId);
  const embed = new EmbedBuilder()
    .setTitle("🔓 トラッキングを再開しました")
    .setColor(0x57f287)
    .setDescription(
      "VCの滞在時間の記録を**再開**しました。\n\n" +
      "• これ以降のVCセッションが記録されます（このサーバー＆グローバル設定を解除）\n" +
      "• `/ranking` や `/vc時間` にあなたのデータが表示されます\n\n" +
      "停止するには `/privacy optout`（このサーバー）または `/privacy optout-all`（全サーバー）を使用してください。",
    )
    .setTimestamp();
  await interaction.editReply({ embeds: [embed] });
}

export async function handlePrivacyOptoutKeep(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guildId) return;
  await interaction.deferUpdate();
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const sessionClosed = await setVcPrivacyOptOut(guildId, userId, true);
  const closedNote = sessionClosed ? "• 進行中のVCセッションを自動的に終了しました\n" : "";
  const embed = new EmbedBuilder()
    .setTitle("🔒 トラッキングを停止しました")
    .setColor(0xed4245)
    .setDescription(
      "VCの滞在時間の記録を**停止**しました。\n\n" +
      "• 新しいセッションは記録されません\n" +
      closedNote +
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
  // Sequential: wipe sessions (which also clears the privacy row) BEFORE re-setting
  // opt-out, so the upsert never races against the DELETE and leaves the user
  // in an unintentionally opted-in state.
  const deleted = await deleteUserVcSessions(guildId, userId);
  await setVcPrivacyOptOut(guildId, userId, true);
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

  // Sequential: wipe sessions (which also clears the privacy row) BEFORE re-setting
  // opt-out, so the upsert never races against the DELETE.
  const deleted = await deleteUserVcSessions(guildId, userId);
  await setVcPrivacyOptOut(guildId, userId, true);

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
  const userId = interaction.user.id;
  const closed = await setVcGlobalPrivacyOptOut(userId, true);
  const closedNote = closed > 0
    ? `• 進行中のVCセッション **${closed}件** を自動的に終了しました\n`
    : "";
  const embed = new EmbedBuilder()
    .setTitle("🌐 全サーバーでトラッキングを停止しました")
    .setColor(0xed4245)
    .setDescription(
      "すべてのサーバーでVCの滞在時間の記録を**停止**しました。\n\n" +
      "• 新しいセッションはどのサーバーでも記録されません\n" +
      closedNote +
      "• 各サーバーの過去データはそのまま残ります\n\n" +
      "再開するには `/privacy optin` を使用してください。",
    )
    .setTimestamp();
  await interaction.editReply({ embeds: [embed], components: [] });
}

export async function handlePrivacyGlobalOptoutDelete(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferUpdate();
  const userId = interaction.user.id;
  // Run sequentially so the opt-out write always wins:
  //   1. deleteAllUserVcSessions wipes session rows and clears the global opt-out row.
  //   2. setVcGlobalPrivacyOptOut re-sets the global opt-out to true so the user
  //      stays opted out after the wipe (deterministic final state).
  const deleted = await deleteAllUserVcSessions(userId);
  await setVcGlobalPrivacyOptOut(userId, true);
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

  // Build the list of guilds to send the audit log to.
  //
  // Guild interaction  → only the invoking guild's audit channel is checked.
  // DM interaction     → the bot enumerates every guild it is in, checks whether
  //                      the user is a member, and posts to each guild that has an
  //                      audit channel configured.  This covers the common privacy
  //                      flow where the wipe is triggered from a cross-posted embed
  //                      in a DM: admins in every guild the user belonged to receive
  //                      an audit entry even though no guildId is present on the
  //                      interaction itself.
  type AuditTarget = { guildId: string; guild: NonNullable<typeof interaction.guild> };
  const guildsToAudit: AuditTarget[] = [];

  if (interaction.guildId && interaction.guild) {
    guildsToAudit.push({ guildId: interaction.guildId, guild: interaction.guild });
  } else {
    // DM context: check every guild the bot is in for user membership.
    for (const [guildId, guild] of interaction.client.guilds.cache) {
      const member =
        guild.members.cache.get(userId) ??
        await guild.members.fetch(userId).catch(() => null);
      if (member) {
        guildsToAudit.push({ guildId, guild: guild as NonNullable<typeof interaction.guild> });
      }
    }
  }

  for (const { guildId, guild } of guildsToAudit) {
    const auditChannelId = await getAuditLogChannel(guildId);
    if (!auditChannelId) continue;
    try {
      const auditChannel =
        guild.channels.cache.get(auditChannelId) ??
        await guild.channels.fetch(auditChannelId).catch(() => null);
      if (auditChannel?.isTextBased()) {
        const auditEmbed = new EmbedBuilder()
          .setTitle("🔍 ユーザーによる全データ削除（グローバルオプトアウト）")
          .setColor(0xed4245)
          .addFields(
            { name: "ユーザー", value: `<@${userId}>`, inline: true },
            { name: "削除件数", value: `${deleted}件`, inline: true },
          )
          .setFooter({ text: `ユーザーID: ${userId}` })
          .setTimestamp();
        await auditChannel.send({ embeds: [auditEmbed] });
      }
    } catch (err) {
      logger.error("[privacy] Failed to post global wipe to audit log channel", err);
    }
  }
}

export async function handlePrivacyAdminDeleteConfirm(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "サーバー内でのみ使用できます。", ephemeral: true });
    return;
  }
  // Verify the button-clicker still has ManageGuild
  const member = interaction.member as GuildMember | null;
  if (!member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: "このボタンはサーバー管理（ManageGuild）権限を持つメンバーのみ使用できます。", ephemeral: true });
    return;
  }

  await interaction.deferUpdate();

  const targetUserId = interaction.customId.slice(COMM_PRIVACY_ADMIN_DELETE_CONFIRM_PREFIX.length);
  const guildId = interaction.guildId;

  const deleted = await deleteUserVcSessions(guildId, targetUserId);

  const embed = new EmbedBuilder()
    .setTitle("🗑️ VC記録を削除しました")
    .setColor(0xed4245)
    .setDescription(
      `<@${targetUserId}> のVC滞在記録 **${deleted}件** を削除しました。\n\n` +
      "• ランキングや統計からそのメンバーのデータは除外されます",
    )
    .setFooter({ text: `操作者: ${interaction.user.tag} (${interaction.user.id})` })
    .setTimestamp();
  await interaction.editReply({ embeds: [embed], components: [] });

  // Post to the audit log channel if configured
  const auditChannelId = await getAuditLogChannel(guildId);
  if (auditChannelId) {
    try {
      let auditChannel = interaction.guild?.channels.cache.get(auditChannelId) ?? null;
      if (!auditChannel) {
        try {
          auditChannel = await interaction.guild?.channels.fetch(auditChannelId) ?? null;
        } catch (fetchErr: unknown) {
          // Unknown Channel (10003) means the channel was deleted from Discord.
          // Clear the stale id so future admin actions don't keep hitting the dead channel.
          if ((fetchErr as { code?: number })?.code === 10003) {
            await setAuditLogChannel(guildId, null);
          }
        }
      }
      if (auditChannel?.isTextBased()) {
        const auditEmbed = new EmbedBuilder()
          .setTitle("🔍 管理者によるVC記録削除")
          .setColor(0xed4245)
          .addFields(
            { name: "操作者", value: `<@${interaction.user.id}> (${interaction.user.tag})`, inline: true },
            { name: "対象ユーザー", value: `<@${targetUserId}>`, inline: true },
            { name: "削除件数", value: `${deleted}件`, inline: true },
            { name: "サーバー", value: interaction.guild?.name ?? guildId, inline: false },
          )
          .setFooter({ text: `操作者ID: ${interaction.user.id} | 対象ID: ${targetUserId}` })
          .setTimestamp();
        await auditChannel.send({ embeds: [auditEmbed] });
      }
    } catch (err) {
      logger.error("[privacy] Failed to post to audit log channel", err);
    }
  }
}

export async function handlePrivacyAdminDeleteCancel(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "サーバー内でのみ使用できます。", ephemeral: true });
    return;
  }
  // Mirror the confirm handler's gate so a non-admin cannot replay the cancel button
  const member = interaction.member as GuildMember | null;
  if (!member?.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: "このボタンはサーバー管理（ManageGuild）権限を持つメンバーのみ使用できます。", ephemeral: true });
    return;
  }

  await interaction.deferUpdate();
  const embed = new EmbedBuilder()
    .setTitle("✅ キャンセルしました")
    .setColor(0x57f287)
    .setDescription("VC記録の削除をキャンセルしました。データはそのまま保持されます。")
    .setTimestamp();
  await interaction.editReply({ embeds: [embed], components: [] });
}

// ─── /ranking retention-days confirmation buttons ─────────────────────────────

/**
 * Admin clicked "確定する" on the short-retention warning embed.
 * The button custom ID encodes a per-confirmation nonce that is looked up in
 * retentionConfirmExpiry to validate the originating guild, the requested
 * days, and that the 60-second TTL has not elapsed.  The entry is consumed on
 * the first valid click so the button cannot be used a second time.
 * Only an Administrator may confirm.
 */
export async function handleRetentionConfirm(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "サーバー内でのみ使用できます。", ephemeral: true });
    return;
  }
  const member = interaction.member as GuildMember | null;
  if (!member?.permissions.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "このボタンはサーバー管理者のみ使用できます。", ephemeral: true });
    return;
  }

  // The nonce is the suffix of the custom ID; look it up in the per-confirmation
  // registry to get the originating guild, days, and expiry.
  const nonce = interaction.customId.slice(COMM_RETENTION_CONFIRM_PREFIX.length);
  const record = retentionConfirmExpiry.get(nonce);

  // No entry, or the entry is for a different guild.
  // A cross-guild mismatch is silently rejected WITHOUT removing the nonce so
  // the legitimate guild-A admin can still confirm.
  if (!record || record.guildId !== interaction.guildId) {
    await interaction.reply({
      content: "⏱️ この確認の有効期限が切れています。コマンドを再実行してください。",
      ephemeral: true,
    });
    return;
  }

  // The entry belongs to this guild but its TTL has elapsed — clean it up.
  if (Date.now() > record.expiry) {
    retentionConfirmExpiry.delete(nonce);
    await interaction.reply({
      content: "⏱️ この確認の有効期限が切れています。コマンドを再実行してください。",
      ephemeral: true,
    });
    return;
  }
  // Consume the entry so the button cannot be clicked a second time.
  retentionConfirmExpiry.delete(nonce);

  const { days } = record;

  // Defense-in-depth floor guard: the command handler already prevents values
  // below 30 from being registered, but re-check here in case the registry was
  // populated through an unexpected path.
  if (days < 30) {
    await interaction.reply({
      content: `⛔ 保持期間は最低 **30日** 以上に設定してください（入力値: **${days}日**）。`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferUpdate();
  await setVcSessionRetentionDays(interaction.guildId, days);

  const embed = new EmbedBuilder()
    .setTitle("✅ 保持期間を変更しました")
    .setColor(0xed4245)
    .setDescription(
      `VCセッションの保持期間を **${days}日** に設定しました。\n\n` +
      "次回のプルーン実行時に、この日数より古い完了済みセッションが削除されます。",
    )
    .setTimestamp();
  await interaction.editReply({ embeds: [embed], components: [] });
}

/**
 * Admin clicked "キャンセル" on the short-retention warning embed.
 * Consumes the nonce registry entry so the paired confirm button is also
 * invalidated — clicking "確定する" after cancelling will find no entry.
 */
export async function handleRetentionCancel(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "サーバー内でのみ使用できます。", ephemeral: true });
    return;
  }
  const member = interaction.member as GuildMember | null;
  if (!member?.permissions.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "このボタンはサーバー管理者のみ使用できます。", ephemeral: true });
    return;
  }

  // Look up the nonce in the registry.  We must check guild scope before
  // consuming it — an admin in guild B must NOT be able to cancel guild A's
  // pending confirmation by presenting the nonce in a cancel button.
  // A cross-guild mismatch is silently rejected WITHOUT removing the nonce so
  // the legitimate guild-A admin can still confirm or cancel.
  const nonce = interaction.customId.slice(COMM_RETENTION_CANCEL_PREFIX.length);
  const record = retentionConfirmExpiry.get(nonce);

  if (!record || record.guildId !== interaction.guildId) {
    await interaction.reply({
      content: "⏱️ この確認の有効期限が切れています。コマンドを再実行してください。",
      ephemeral: true,
    });
    return;
  }

  // The entry belongs to this guild — consume it so the confirm button is also
  // invalidated, then acknowledge the cancellation.
  retentionConfirmExpiry.delete(nonce);

  await interaction.deferUpdate();
  const embed = new EmbedBuilder()
    .setTitle("✅ キャンセルしました")
    .setColor(0x57f287)
    .setDescription("保持期間の変更をキャンセルしました。設定はそのまま変わりません。")
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
    .setDefaultMemberPermissions(0)
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

  // 同じロールを既に持っていればトグル解除
  if (member.roles.cache.has(role.id)) {
    try {
      await member.roles.remove(role, "ロールボタンによるトグル解除");
      await interaction.reply({ content: `✅ **${role.name}** を外しました。`, ephemeral: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[role-btn] role remove failed guildId=${interaction.guildId} userId=${member.id} roleId=${role.id}:`, msg);
      let hint = "Botに「ロールの管理」権限があるか、またBotのロールが対象ロールより上位か確認してください。";
      if (msg.includes("Missing Permissions")) hint = "Botの「ロールの管理」権限が不足しています。";
      if (msg.includes("Invalid Form Body") || msg.includes("50013")) hint = "BotのロールがDiscordサーバーのロール一覧で対象ロールより下にあります。Botのロールを上に移動してください。";
      await interaction.reply({ content: `ロールの解除に失敗しました。\n> ${hint}`, ephemeral: true });
    }
    return;
  }

  // 排他制御：同一パネル内の別ロールをすでに持っていたら拒否
  const panelButtons = await getRoleButtonsByMessage(btnRecord.messageId);
  const panelRoleIds = panelButtons.map((b) => b.roleId);
  const alreadyHeld  = panelRoleIds.find((rid) => member.roles.cache.has(rid));
  if (alreadyHeld) {
    await interaction.reply({
      content: "❌ すでにこのパネルから別のロールを選択済みです。変更はできません。",
      ephemeral: true,
    });
    return;
  }

  // 付与
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
    .setDefaultMemberPermissions(0)
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

// ─── /tempvc ─────────────────────────────────────────────────────────────────

/**
 * Build a CSV string from a list of completed VC sessions.
 * Columns: id, user_id, channel_id, joined_at, left_at, duration_seconds, opted_out
 *
 * `opted_out` is "true" when the user currently has an active opt-out (per-guild
 * or global), allowing admins to identify privacy-sensitive rows at a glance.
 */

/**
 * Build the CSV export filename from optional filter parameters.
 * Exported for unit testing.
 */
export function buildTempVcCsvFilename(opts: {
  startStr?: string | null;
  endStr?: string | null;
  userId?: string | null;
}): string {
  const { startStr, endStr, userId } = opts;
  const datePart = startStr && endStr
    ? `${startStr}_${endStr}`
    : startStr
      ? `from-${startStr}`
      : endStr
        ? `until-${endStr}`
        : "all";
  const userPart = userId ? `-${userId}` : "";
  return `tempvc-log-${datePart}${userPart}.csv`;
}

const tempvcCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("tempvc")
    .setDescription("一時VCセッションのログを管理します（管理者用）")
    .setDefaultMemberPermissions(0)
    .addSubcommand((sub) =>
      sub
        .setName("export")
        .setDescription("完了したVCセッションのログをCSVでエクスポートします（管理者用）")
        .addStringOption((opt) =>
          opt
            .setName("start")
            .setDescription("集計開始日（YYYY-MM-DD）省略時は全期間")
            .setRequired(false)
            .setMinLength(10)
            .setMaxLength(10),
        )
        .addStringOption((opt) =>
          opt
            .setName("end")
            .setDescription("集計終了日（YYYY-MM-DD・当日を含む）省略時は全期間")
            .setRequired(false)
            .setMinLength(10)
            .setMaxLength(10),
        )
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("特定のユーザーのみエクスポート（省略時は全ユーザー）")
            .setRequired(false),
        ),
    ),

  async execute(interaction) {
    requireGuild(interaction);

    if (!requireAdmin(interaction)) {
      await interaction.reply({
        content: "このコマンドはサーバー管理権限が必要です。",
        ephemeral: true,
      });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === "export") {
      await interaction.deferReply({ ephemeral: true });

      const guildId  = interaction.guildId!;
      const startStr = interaction.options.getString("start");
      const endStr   = interaction.options.getString("end");
      const targetUser: User | null = interaction.options.getUser("user");

      // Parse and validate date strings
      let startDate: Date | undefined;
      let endDate:   Date | undefined;

      if (startStr) {
        const parsed = parseDate(startStr);
        if (!parsed) {
          await interaction.editReply(
            "❌ `start` の日付形式が正しくありません。`YYYY-MM-DD` 形式で指定してください（例: `2025-01-01`）。",
          );
          return;
        }
        startDate = parsed;
      }

      if (endStr) {
        const parsed = parseDate(endStr);
        if (!parsed) {
          await interaction.editReply(
            "❌ `end` の日付形式が正しくありません。`YYYY-MM-DD` 形式で指定してください（例: `2025-01-31`）。",
          );
          return;
        }
        // Add 1 day so the end date is inclusive (sessions ending on that calendar day are included).
        endDate = new Date(parsed.getTime() + 24 * 60 * 60 * 1000);
      }

      if (startDate && endDate && startDate >= endDate) {
        await interaction.editReply("❌ `start` は `end` より前の日付を指定してください。");
        return;
      }

      const rows = await getAllTempVcDeletions(guildId, {
        start: startDate,
        end: endDate,
        userId: targetUser?.id,
      });

      if (rows.length === 0) {
        const rangeNote = startStr || endStr
          ? `（期間: ${startStr ?? "−"} 〜 ${endStr ?? "−"}）`
          : "";
        const userNote = targetUser ? `（ユーザー: <@${targetUser.id}>）` : "";
        await interaction.editReply(`📭 エクスポート対象のセッション記録が見つかりませんでした。${rangeNote}${userNote}`);
        return;
      }

      // Build CSV and filename
      const csv = buildTempVcCsv(rows);
      const filename = buildTempVcCsvFilename({ startStr, endStr, userId: targetUser?.id });

      await interaction.editReply({
        content: `✅ **${rows.length}件** のセッション記録をエクスポートしました。`,
        files: [
          {
            attachment: Buffer.from(csv, "utf-8"),
            name: filename,
          },
        ],
      });
    }
  },
};

// ─── /event ──────────────────────────────────────────────────────────────────

const eventCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("event")
    .setDescription("イベントを管理します")
    .setDefaultMemberPermissions(0)
    .addSubcommand((sub) =>
      sub
        .setName("create")
        .setDescription("新しいイベントを作成します（管理者用）")
        .addStringOption((opt) =>
          opt.setName("title").setDescription("イベントのタイトル").setRequired(true).setMaxLength(100),
        )
        .addStringOption((opt) =>
          opt.setName("date").setDescription("開催日時（YYYY-MM-DD または YYYY-MM-DD HH:MM、JST）").setRequired(true),
        )
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("イベントを投稿するチャンネル")
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText),
        )
        .addStringOption((opt) =>
          opt.setName("description").setDescription("イベントの説明").setRequired(false).setMaxLength(1000),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("予定されているイベントの一覧を表示します"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("delete")
        .setDescription("イベントを削除します（管理者用）")
        .addIntegerOption((opt) =>
          opt.setName("event_id").setDescription("イベントID").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("edit")
        .setDescription("イベントを編集します（管理者用）")
        .addIntegerOption((opt) =>
          opt.setName("event_id").setDescription("イベントID").setRequired(true),
        )
        .addStringOption((opt) =>
          opt.setName("title").setDescription("新しいタイトル").setRequired(false).setMaxLength(100),
        )
        .addStringOption((opt) =>
          opt.setName("date").setDescription("新しい開催日時（YYYY-MM-DD または YYYY-MM-DD HH:MM、JST）").setRequired(false),
        )
        .addStringOption((opt) =>
          opt.setName("description").setDescription("新しい説明").setRequired(false).setMaxLength(1000),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("setup")
        .setDescription("イベント通知設定を変更します（管理者用）")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("通知チャンネル（省略すると現在の設定を表示）")
            .setRequired(false)
            .addChannelTypes(ChannelType.GuildText),
        )
        .addRoleOption((opt) =>
          opt.setName("role").setDescription("通知ロール（省略すると現在の設定を表示）").setRequired(false),
        ),
    ),

  async execute(interaction) {
    const guildId = requireGuild(interaction);
    const sub = interaction.options.getSubcommand();

    // ── list ──────────────────────────────────────────────────────────────────
    if (sub === "list") {
      await interaction.deferReply({ ephemeral: true });
      const events = await listUpcomingEvents(guildId);
      if (events.length === 0) {
        await interaction.editReply("予定されているイベントはありません。");
        return;
      }
      const lines = events.map((e) => {
        const ts = Math.floor(e.scheduledAt.getTime() / 1000);
        return `• **${e.title}** — <t:${ts}:F>（ID: \`${e.id}\`）`;
      });
      await interaction.editReply(`## 📅 予定イベント\n${lines.join("\n")}`);
      return;
    }

    // ── create / delete / edit / setup — admin only ───────────────────────────
    if (!requireAdmin(interaction)) {
      await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
      return;
    }

    // ── create ────────────────────────────────────────────────────────────────
    if (sub === "create") {
      const title       = interaction.options.getString("title", true);
      const dateStr     = interaction.options.getString("date", true);
      const channel     = interaction.options.getChannel("channel", true);
      const description = interaction.options.getString("description");

      const scheduledAt = parseDate(dateStr);
      if (!scheduledAt) {
        await interaction.reply({
          content: "❌ 日付の形式が正しくありません。`YYYY-MM-DD` または `YYYY-MM-DD HH:MM` 形式で指定してください。",
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });
      const event = await createEvent(guildId, channel.id, title, description ?? null, scheduledAt);

      // Post the event embed in the target channel
      if (interaction.guild) {
        const targetChannel = interaction.guild.channels.cache.get(channel.id);
        if (targetChannel?.isTextBased()) {
          const { embed, rows } = await buildEventEmbed(event.id, interaction.guild);
          const msg = await targetChannel.send({ embeds: [embed], components: rows });
          await updateEventMessageId(event.id, msg.id);
        }
      }

      await interaction.editReply(`✅ イベント **${title}** を作成しました（ID: \`${event.id}\`）。`);
      return;
    }

    // ── delete ────────────────────────────────────────────────────────────────
    if (sub === "delete") {
      const eventId = interaction.options.getInteger("event_id", true);
      await interaction.deferReply({ ephemeral: true });

      // Guild-ownership guard: reject if the event belongs to a different guild.
      const event = await getEvent(eventId);
      if (!event || event.guildId !== guildId) {
        await interaction.editReply(`❌ イベント ID **${eventId}** が見つかりません。`);
        return;
      }

      await deleteEvent(eventId);
      await interaction.editReply(`✅ イベント **${event.title}**（ID: \`${eventId}\`）を削除しました。`);
      return;
    }

    // ── edit ──────────────────────────────────────────────────────────────────
    if (sub === "edit") {
      const eventId        = interaction.options.getInteger("event_id", true);
      const newTitle       = interaction.options.getString("title");
      const newDateStr     = interaction.options.getString("date");
      const newDescription = interaction.options.getString("description");

      await interaction.deferReply({ ephemeral: true });

      // Guild-ownership guard: reject if the event belongs to a different guild.
      const event = await getEvent(eventId);
      if (!event || event.guildId !== guildId) {
        await interaction.editReply(`❌ イベント ID **${eventId}** が見つかりません。`);
        return;
      }

      if (!newTitle && newDateStr === null && newDescription === null) {
        await interaction.editReply("❌ 変更する項目を指定してください（title / date / description）。");
        return;
      }

      const opts: { title?: string; description?: string | null; scheduledAt?: Date } = {};
      if (newTitle)              opts.title = newTitle;
      if (newDescription !== null) opts.description = newDescription || null;
      if (newDateStr) {
        const parsed = parseDate(newDateStr);
        if (!parsed) {
          await interaction.editReply(
            "❌ 日付の形式が正しくありません。`YYYY-MM-DD` または `YYYY-MM-DD HH:MM` 形式で指定してください。",
          );
          return;
        }
        opts.scheduledAt = parsed;
      }

      await editEvent(eventId, opts);

      // Refresh the event embed in Discord if it was previously posted.
      if (event.messageId && interaction.guild) {
        const eventChannel = interaction.guild.channels.cache.get(event.channelId);
        if (eventChannel?.isTextBased()) {
          const msg = await eventChannel.messages.fetch(event.messageId).catch(() => null);
          if (msg) {
            const { embed, rows } = await buildEventEmbed(eventId, interaction.guild);
            await msg.edit({ embeds: [embed], components: rows }).catch(() => {});
          }
        }
      }

      await interaction.editReply(`✅ イベント **${event.title}**（ID: \`${eventId}\`）を更新しました。`);
      return;
    }

    // ── setup ─────────────────────────────────────────────────────────────────
    if (sub === "setup") {
      const channel = interaction.options.getChannel("channel");
      const role    = interaction.options.getRole("role");

      // No arguments → show current settings
      if (!channel && !role) {
        const settings = await getEventSettings(guildId);
        const channelVal = settings?.notifyChannelId ? `<#${settings.notifyChannelId}>` : "未設定";
        const roleVal    = settings?.notifyRoleId    ? `<@&${settings.notifyRoleId}>`   : "未設定";
        await interaction.reply({
          content: `## 📋 イベント通知設定\n通知チャンネル: ${channelVal}\n通知ロール: ${roleVal}`,
          ephemeral: true,
        });
        return;
      }

      await setEventSettings(guildId, {
        notifyChannelId: channel?.id ?? undefined,
        notifyRoleId:    role?.id    ?? undefined,
      });
      await interaction.reply({ content: "✅ イベント通知設定を更新しました。", ephemeral: true });
      return;
    }
  },
};

// ─── /ticket ─────────────────────────────────────────────────────────────────

const ticketCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("チケットシステムを設定・管理します（管理者用）")
    .setDefaultMemberPermissions(0)
    .addSubcommand((sub) =>
      sub
        .setName("setup")
        .setDescription("チケットのウェルカムメッセージを設定します")
        .addStringOption((opt) =>
          opt
            .setName("welcome-message")
            .setDescription("チケット作成時にチャンネルへ投稿するメッセージ本文")
            .setRequired(false)
            .setMaxLength(2000),
        )
        .addStringOption((opt) =>
          opt
            .setName("embed-title")
            .setDescription("ウェルカムメッセージのタイトル（省略時はデフォルト値を使用）")
            .setRequired(false)
            .setMaxLength(256),
        ),
    ),

  async execute(interaction) {
    const guildId = requireGuild(interaction);

    if (!requireAdmin(interaction)) {
      await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === "setup") {
      const welcomeMessage = interaction.options.getString("welcome-message");
      const embedTitle     = interaction.options.getString("embed-title");

      // Only update columns that were explicitly supplied; null leaves the
      // existing DB value intact (the admin can call setup multiple times to
      // update individual fields independently).
      const patch: Record<string, string> = {};
      if (welcomeMessage !== null) patch["welcomeMessage"]   = welcomeMessage;
      if (embedTitle      !== null) patch["welcomeEmbedTitle"] = embedTitle;

      await upsertTicketSettings(guildId, patch);

      const lines: string[] = ["✅ チケット設定を更新しました。"];
      if (embedTitle      !== null) lines.push(`📌 タイトル: **${embedTitle}**`);
      if (welcomeMessage  !== null) lines.push(`💬 メッセージ: ${welcomeMessage}`);
      if (embedTitle === null && welcomeMessage === null) {
        lines.push("（変更なし — オプションを指定して個別に設定してください）");
      }

      await interaction.reply({ content: lines.join("\n"), ephemeral: true });
    }
  },
};

// ─── Exports ─────────────────────────────────────────────────────────────────

import { prebanCommand } from "./preban.js";
import { periodicCommand } from "./periodic.js";

export const commands: Command[] = [
  ...zombieCommands,
  rankingCommand,
  vcRankCommand,
  mystatsCommand,
  privacyCommand,
  botstatusCommand,
  roleButtonCommand,
  leavelogCommand,
  prebanCommand,
  tempvcCommand,
  periodicCommand,
  ticketCommand,
  eventCommand,
];
