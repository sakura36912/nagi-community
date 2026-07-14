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
} from "discord.js";
import { logger } from "../lib/logger.js";
import {
  addParticipant,
  addTempVc,
  createEvent,
  createSheet,
  createTicket,
  getEvent,
  getParticipants,
  getActiveSession,
  getLobbyChannelId,
  getRecentTempVcDeletions,
  getSheetSettings,
  getTicketByChannel,
  getTicketSettings,
  getUserVcRank,
  getVcRanking,
  getVcTimeInPeriod,
  isVcTrackingOptedOut,
  listSheets,
  listUpcomingEvents,
  removeParticipant,
  removeTicket,
  setLobbyChannel,
  setNameboardUrl,
  setStaffRole,
  setVcPrivacyOptOut,
  updateEventMessageId,
} from "../lib/community.js";

// ─── Prefix constants ────────────────────────────────────────────────────────

export const COMM_EVENT_JOIN_PREFIX = "comm:event:join:";
export const COMM_EVENT_CANCEL_PREFIX = "comm:event:cancel:";
export const COMM_TICKET_CREATE = "comm:ticket:create";
export const COMM_TICKET_CLOSE_PREFIX = "comm:ticket:close:";
export const COMM_TEMPVC_CREATE = "comm:tempvc:create";

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
  return !!interaction.memberPermissions?.has("ManageGuild");
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

const rankingCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("ranking")
    .setDescription("VC滞在時間のランキングを表示します")
    .addStringOption((opt) =>
      opt
        .setName("period")
        .setDescription("集計期間")
        .setRequired(false)
        .addChoices(
          { name: "今日", value: "today" },
          { name: "今週", value: "week" },
          { name: "今月", value: "month" },
          { name: "全期間", value: "all" },
        ),
    ),
  async execute(interaction) {
    const guildId = requireGuild(interaction);
    await interaction.deferReply();

    const period = (interaction.options.getString("period") ?? "all") as "today" | "week" | "month" | "all";

    const now = new Date();
    let periodStart: Date | undefined;
    let periodLabel: string;

    if (period === "today") {
      periodStart = new Date(now);
      periodStart.setHours(0, 0, 0, 0);
      periodLabel = "今日";
    } else if (period === "week") {
      periodStart = new Date(now);
      const day = periodStart.getDay();
      periodStart.setDate(periodStart.getDate() - day);
      periodStart.setHours(0, 0, 0, 0);
      periodLabel = "今週";
    } else if (period === "month") {
      periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
      periodLabel = "今月";
    } else {
      periodLabel = "全期間";
    }

    const ranking = await getVcRanking(guildId, periodStart);

    if (ranking.length === 0) {
      await interaction.editReply("まだVC滞在記録がありません。");
      return;
    }

    const medals = ["🥇", "🥈", "🥉"];
    const lines = ranking.map((entry, i) => {
      const prefix = medals[i] ?? `**${i + 1}.**`;
      return `${prefix} <@${entry.userId}> — ${formatSeconds(entry.totalSeconds)}`;
    });

    const embed = new EmbedBuilder()
      .setTitle(`🎙️ VC滞在時間ランキング（${periodLabel}）`)
      .setColor(0xf5a623)
      .setDescription(lines.join("\n"))
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};

// ─── /tempvc ─────────────────────────────────────────────────────────────────

const TEMPVC_DELETION_REASON_LABEL: Record<string, string> = {
  empty_leave:        "退室による空VC削除",
  bot_restart:        "Bot再起動時の空VC削除",
  stale_guild_gone:   "ギルド消失によるレコード削除",
  stale_channel_gone: "チャンネル消失によるレコード削除",
};

const tempvcCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("tempvc")
    .setDescription("一時VC機能の設定")
    .addSubcommand((sub) =>
      sub
        .setName("setup")
        .setDescription("ロビーVCを設定します（管理者）")
        .addChannelOption((opt) =>
          opt
            .setName("lobby")
            .setDescription("ロビーとして使うVCチャンネル")
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("panel")
        .setDescription("一時VCパネルをこのチャンネルに設置します（管理者）"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("log")
        .setDescription("一時VCの削除履歴を表示します（管理者）")
        .addIntegerOption((opt) =>
          opt
            .setName("limit")
            .setDescription("表示する件数（最大20件、デフォルト10件）")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(20),
        ),
    ),
  async execute(interaction) {
    const guildId = requireGuild(interaction);
    const sub = interaction.options.getSubcommand();

    if (!requireAdmin(interaction)) {
      await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
      return;
    }

    if (sub === "setup") {
      const lobby = interaction.options.getChannel("lobby", true);
      await setLobbyChannel(guildId, lobby.id);
      await interaction.reply({ content: `✅ ロビーVCを <#${lobby.id}> に設定しました。このチャンネルに参加すると自動で一時VCが作成されます。`, ephemeral: true });
      return;
    }

    if (sub === "panel") {
      const embed = new EmbedBuilder()
        .setTitle("🎙️ 一時VCの作成")
        .setColor(0x57f287)
        .setDescription("ボタンを押すと、あなた専用の一時VCが作成されます。");
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(COMM_TEMPVC_CREATE)
          .setLabel("一時VCを作成 🎙️")
          .setStyle(ButtonStyle.Success),
      );
      await interaction.reply({ content: "パネルを設置しました。", ephemeral: true });
      if (interaction.channel?.isSendable()) await interaction.channel.send({ embeds: [embed], components: [row] });
      return;
    }

    if (sub === "log") {
      await interaction.deferReply({ ephemeral: true });
      const limit = interaction.options.getInteger("limit") ?? 10;
      const logs = await getRecentTempVcDeletions(guildId, limit);

      if (logs.length === 0) {
        await interaction.editReply("一時VCの削除履歴はまだありません。");
        return;
      }

      const lines = logs.map((entry) => {
        const ts = Math.floor(entry.deletedAt.getTime() / 1000);
        const reason = TEMPVC_DELETION_REASON_LABEL[entry.reason] ?? entry.reason;
        return `• **${entry.channelName}** — <@${entry.ownerId}> — ${reason} — <t:${ts}:f>`;
      });

      const embed = new EmbedBuilder()
        .setTitle("🗑️ 一時VC削除履歴")
        .setColor(0xed4245)
        .setDescription(lines.join("\n").slice(0, 4000))
        .setFooter({ text: `直近 ${logs.length} 件` })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
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
          opt
            .setName("datetime")
            .setDescription("開催日時（YYYY-MM-DD HH:MM 形式、日本時間）")
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt.setName("description").setDescription("イベントの説明").setRequired(false).setMaxLength(1000),
        ),
    )
    .addSubcommand((sub) => sub.setName("list").setDescription("予定イベントの一覧を表示します")),
  async execute(interaction) {
    const guildId = requireGuild(interaction);
    const sub = interaction.options.getSubcommand();

    if (sub === "create") {
      if (!requireAdmin(interaction)) {
        await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
        return;
      }
      await interaction.deferReply({ ephemeral: true });

      const title = interaction.options.getString("title", true);
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
      const msg = interaction.channel?.isSendable() ? await interaction.channel.send({ embeds: [embed], components: rows }) : null;
      if (msg) await updateEventMessageId(event.id, msg.id);

      await interaction.editReply(`✅ イベント「${title}」を作成しました。`);
      return;
    }

    if (sub === "list") {
      await interaction.deferReply({ ephemeral: true });
      const events = await listUpcomingEvents(guildId);
      if (events.length === 0) {
        await interaction.editReply("予定されているイベントはありません。");
        return;
      }
      const lines = events.map((e) => {
        const ts = Math.floor(e.scheduledAt.getTime() / 1000);
        return `• **${e.title}** — <t:${ts}:F>`;
      });
      const embed = new EmbedBuilder()
        .setTitle("📅 予定イベント一覧")
        .setColor(0x5865f2)
        .setDescription(lines.join("\n"));
      await interaction.editReply({ embeds: [embed] });
      return;
    }
  },
};

// ─── /ticket ─────────────────────────────────────────────────────────────────

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
        .setDescription("スタッフロールを設定します（管理者）")
        .addRoleOption((opt) =>
          opt.setName("staff_role").setDescription("チケット対応スタッフのロール").setRequired(true),
        ),
    ),
  async execute(interaction) {
    const guildId = requireGuild(interaction);
    const sub = interaction.options.getSubcommand();

    if (!requireAdmin(interaction)) {
      await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
      return;
    }

    if (sub === "settings") {
      const role = interaction.options.getRole("staff_role", true);
      await setStaffRole(guildId, role.id);
      await interaction.reply({ content: `✅ スタッフロールを <@&${role.id}> に設定しました。`, ephemeral: true });
      return;
    }

    if (sub === "panel") {
      const embed = new EmbedBuilder()
        .setTitle("🎫 サポートチケット")
        .setColor(0xfee75c)
        .setDescription("ボタンを押すと、スタッフとのプライベートチャンネルが作成されます。");
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(COMM_TICKET_CREATE)
          .setLabel("チケットを作成 🎫")
          .setStyle(ButtonStyle.Primary),
      );
      await interaction.reply({ content: "パネルを設置しました。", ephemeral: true });
      if (interaction.channel?.isSendable()) await interaction.channel.send({ embeds: [embed], components: [row] });
      return;
    }
  },
};

// ─── /sheet ──────────────────────────────────────────────────────────────────

const sheetCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("sheet")
    .setDescription("評価シートの管理")
    .addSubcommand((sub) =>
      sub
        .setName("settings")
        .setDescription("名簿リンクURLを設定します（管理者）")
        .addStringOption((opt) =>
          opt.setName("url").setDescription("名簿のURL（省略で削除）").setRequired(false),
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
      const url = interaction.options.getString("url");
      await setNameboardUrl(guildId, url ?? null);
      await interaction.reply({
        content: url ? `✅ 名簿URLを設定しました: ${url}` : "✅ 名簿URLを削除しました。",
        ephemeral: true,
      });
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

      const settings = await getSheetSettings(guildId);
      const vcSeconds = await getVcTimeInPeriod(guildId, targetUser.id, startDate, endDate);

      const startTs = Math.floor(startDate.getTime() / 1000);
      const endTs = Math.floor(endDate.getTime() / 1000);
      const nameboardValue = settings?.nameboardUrl
        ? `[名簿を見る](${settings.nameboardUrl})`
        : "未設定";

      const embed = new EmbedBuilder()
        .setTitle(`📋 評価シート — ${displayName}`)
        .setColor(0x2ecc71)
        .setThumbnail(targetUser.displayAvatarURL())
        .addFields(
          { name: "👤 メンバー", value: `${displayName}（<@${targetUser.id}>）`, inline: false },
          { name: "📋 名簿", value: nameboardValue, inline: false },
          { name: "📅 評価開始", value: `<t:${startTs}:D>`, inline: true },
          { name: "⏰ 評価終了", value: `<t:${endTs}:D>`, inline: true },
          { name: "🎙️ 期間中のVC滞在時間", value: formatSeconds(vcSeconds), inline: false },
        )
        .setFooter({ text: `作成者: ${interaction.user.displayName}` })
        .setTimestamp();

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
    ),
  async execute(interaction) {
    const guildId = requireGuild(interaction);
    const userId = interaction.user.id;
    const sub = interaction.options.getSubcommand();

    await interaction.deferReply({ ephemeral: true });

    if (sub === "optout") {
      await setVcPrivacyOptOut(guildId, userId, true);
      const embed = new EmbedBuilder()
        .setTitle("🔒 トラッキングを停止しました")
        .setColor(0xed4245)
        .setDescription(
          "VCの滞在時間の記録を**停止**しました。\n\n" +
          "• これ以降のVCセッションは記録されません\n" +
          "• `/ranking` や `/mystats` にあなたのデータは表示されなくなります\n" +
          "• 過去のデータはそのまま残ります\n\n" +
          "再開するには `/privacy optin` を使用してください。",
        )
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === "optin") {
      await setVcPrivacyOptOut(guildId, userId, false);
      const embed = new EmbedBuilder()
        .setTitle("🔓 トラッキングを再開しました")
        .setColor(0x57f287)
        .setDescription(
          "VCの滞在時間の記録を**再開**しました。\n\n" +
          "• これ以降のVCセッションが記録されます\n" +
          "• `/ranking` や `/mystats` にあなたのデータが表示されます\n\n" +
          "停止するには `/privacy optout` を使用してください。",
        )
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === "status") {
      const optedOut = await isVcTrackingOptedOut(guildId, userId);
      const embed = new EmbedBuilder()
        .setTitle("🔎 プライバシー設定")
        .setColor(optedOut ? 0xed4245 : 0x57f287)
        .addFields({
          name: "VCトラッキング",
          value: optedOut
            ? "🔴 **停止中** — `/privacy optin` で再開できます"
            : "🟢 **有効** — `/privacy optout` で停止できます",
          inline: false,
        })
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
      return;
    }
  },
};

// ─── /botstatus ──────────────────────────────────────────────────────────────

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

    const guild = interaction.guild!;
    const me = guild.members.me;

    // ── Permissions ───────────────────────────────────────────────────────────
    const hasManageChannels = me?.permissions.has("ManageChannels") ?? false;
    const hasMoveMembers    = me?.permissions.has("MoveMembers")    ?? false;

    const manageChannelsLine = hasManageChannels
      ? "✅ ManageChannels — 付与済み"
      : "❌ ManageChannels — **未付与** (Server Settings → Roles → Community Bot で付与してください)";

    const moveMembersLine = hasMoveMembers
      ? "✅ MoveMembers — 付与済み"
      : "❌ MoveMembers — **未付与** (Server Settings → Roles → Community Bot で付与してください)";

    // ── GuildMembers privileged intent ────────────────────────────────────────
    // If the intent is active the bot's own member record will always be cached.
    // We use guild.members.cache.size > 0 as a reliable runtime signal:
    // with GuildMembers enabled Discord pushes all members into cache on ready;
    // without it the cache typically contains only the bot itself.
    const guildMembersIntentBit = 1 << 1; // GatewayIntentBits.GuildMembers = 2
    const intents = interaction.client.options.intents;
    let hasGuildMembersIntent = false;
    if (typeof (intents as { has?: (bit: number) => boolean }).has === "function") {
      hasGuildMembersIntent = (intents as { has: (bit: number) => boolean }).has(guildMembersIntentBit);
    } else if (typeof intents === "number" || typeof intents === "bigint") {
      hasGuildMembersIntent = Boolean(BigInt(intents as number) & BigInt(guildMembersIntentBit));
    }

    const guildMembersLine = hasGuildMembersIntent
      ? "✅ GuildMembers intent — 有効"
      : "❌ GuildMembers intent — **無効** (Discord Developer Portal → Bot → Privileged Gateway Intents で有効化してください)";

    // ── Lobby channel ─────────────────────────────────────────────────────────
    const lobbyId = await getLobbyChannelId(guild.id).catch(() => null);
    const lobbyLine = lobbyId
      ? `✅ ロビーVC — <#${lobbyId}>`
      : "⚠️ ロビーVC — **未設定** (`/tempvc setup` で設定してください)";

    // ── Overall status ────────────────────────────────────────────────────────
    const allGood = hasManageChannels && hasMoveMembers && hasGuildMembersIntent && !!lobbyId;
    const statusLine = allGood
      ? "🟢 **すべて正常です**"
      : "🔴 **設定に問題があります** — 上記の項目を確認してください";

    const embed = new EmbedBuilder()
      .setTitle("🤖 Bot セットアップ状況")
      .setColor(allGood ? 0x57f287 : 0xed4245)
      .setDescription(
        [statusLine, "", manageChannelsLine, moveMembersLine, guildMembersLine, lobbyLine].join("\n"),
      )
      .setFooter({ text: `サーバー: ${guild.name}` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
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

  const embed = new EmbedBuilder()
    .setTitle("🎫 サポートチケット")
    .setColor(0xfee75c)
    .setDescription(`<@${interaction.user.id}> からのチケットです。\n用件をお書きください。スタッフが対応します。`)
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

export async function handleTempVcCreate(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guild || !interaction.guildId) {
    await interaction.reply({ content: "サーバー内でのみ使用できます。", ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });

  const me = interaction.guild.members.me;
  if (!me?.permissions.has("ManageChannels")) {
    await interaction.editReply("BotにManageChannels権限がありません。");
    return;
  }

  let member: GuildMember;
  try {
    member = await interaction.guild.members.fetch(interaction.user.id);
  } catch {
    await interaction.editReply("メンバー情報の取得に失敗しました。");
    return;
  }

  const channelName = `🔊 ${member.displayName} の部屋`;
  let channel;
  try {
    channel = await interaction.guild.channels.create({
      name: channelName.slice(0, 100),
      type: ChannelType.GuildVoice,
    });
  } catch (err) {
    logger.error("[tempvc] Failed to create VC from panel", err);
    await interaction.editReply("VCの作成に失敗しました。");
    return;
  }

  // Try to move user if they're already in a VC
  if (member.voice.channelId) {
    try {
      await member.voice.setChannel(channel);
    } catch {
      // ignore move failure
    }
  }

  await addTempVc(interaction.guildId, channel.id, interaction.user.id);
  await interaction.editReply(`✅ 一時VCを作成しました: <#${channel.id}>`);
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export const commands: Command[] = [
  rankingCommand,
  mystatsCommand,
  privacyCommand,
  tempvcCommand,
  eventCommand,
  ticketCommand,
  sheetCommand,
  botstatusCommand,
];
