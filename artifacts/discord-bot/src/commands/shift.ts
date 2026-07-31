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
  type Client,
} from "discord.js";
import { logger } from "../lib/logger.js";
import {
  addShift,
  calcMinutes,
  formatDuration,
  getAllShiftSettings,
  getShiftSettings,
  getShiftsInRange,
  removeShift,
  setShiftRewardAmount,
  setShiftSettings,
  setShiftSubmitRoles,
  type Shift,
} from "../lib/shift.js";

// ─── Button prefix constants ─────────────────────────────────────────────────

export const SHIFT_TOGGLE_PREFIX  = "shift:toggle:";   // shift:toggle:{sid}:{date}
export const SHIFT_CONFIRM_PREFIX = "shift:confirm:"; // shift:confirm:{sid}
export const SHIFT_CANCEL_PREFIX  = "shift:cancel:";  // shift:cancel:{sid}
export const SHIFT_TIME_PREFIX    = "shift:time:";    // shift:time:{sid}:{time}
export const SHIFT_PANEL_OPEN     = "shift:panel:open"; // パネルボタン → submit起動

/** 選択肢として表示する時刻一覧 */
const SHIFT_TIME_OPTIONS = ["21:00", "22:00", "23:00"];

// ─── In-memory submit sessions ────────────────────────────────────────────────

interface DaySelection {
  times: string[];  // 選択済み時刻スロット ["21:00", "22:00"] など
}

interface SubmitSession {
  guildId: string;
  userId: string;
  dates: string[];                        // Mon→Sun "YYYY-MM-DD"
  selections: Record<string, DaySelection>;
  expiresAt: number;
  /** 時間ボタン待ち状態の日付 */
  activeDate?: string;
}

const submitSessions = new Map<string, SubmitSession>();

function cleanExpiredSessions(): void {
  const now = Date.now();
  for (const [k, v] of submitSessions) {
    if (v.expiresAt < now) submitSessions.delete(k);
  }
}

// ─── Date / time helpers ──────────────────────────────────────────────────────

const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** Parse "YYYY-MM-DD" or "M/D" / "MM/DD" into a canonical "YYYY-MM-DD" string. */
function parseDate(input: string): string | null {
  const trimmed = input.trim();

  // Full ISO date
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const d = new Date(`${trimmed}T00:00:00+09:00`);
    return isNaN(d.getTime()) ? null : trimmed;
  }

  // Short M/D or MM/DD — assume current JST year
  const short = trimmed.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (short) {
    const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const year = jstNow.getUTCFullYear();
    const m = short[1]!.padStart(2, "0");
    const d = short[2]!.padStart(2, "0");
    const dt = new Date(`${year}-${m}-${d}T00:00:00+09:00`);
    return isNaN(dt.getTime()) ? null : `${year}-${m}-${d}`;
  }

  return null;
}

/** Parse "H:MM" / "HH:MM" into a canonical "HH:MM" string. */
function parseTime(input: string): string | null {
  const m = input.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1]!);
  const min = parseInt(m[2]!);
  if (h > 23 || min > 59) return null;
  return `${h.toString().padStart(2, "0")}:${m[2]}`;
}

/** "YYYY-MM-DD" → "M/D（曜）" label. */
function formatDateLabel(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00+09:00`);
  const dow = WEEKDAY_JA[d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}（${dow}）`;
}

/** Returns the Monday and Sunday of the week containing dateStr (JST). */
function getWeekRange(dateStr?: string): { from: string; to: string } {
  const ref = dateStr
    ? new Date(`${dateStr}T00:00:00+09:00`)
    : new Date(Date.now() + 9 * 60 * 60 * 1000);
  const dow = ref.getUTCDay(); // 0=Sun
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(ref);
  monday.setUTCDate(ref.getUTCDate() + mondayOffset);
  const from = monday.toISOString().slice(0, 10);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const to = sunday.toISOString().slice(0, 10);
  return { from, to };
}

/** Returns the first and last day of a month, plus a display label. */
function getMonthRange(monthStr?: string): { from: string; to: string; label: string } {
  let year: number;
  let month: number; // 0-indexed

  if (monthStr) {
    const m = monthStr.match(/^(\d{4})-(\d{1,2})$/);
    if (m) {
      year = parseInt(m[1]!);
      month = parseInt(m[2]!) - 1;
    } else {
      const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
      year = jstNow.getUTCFullYear();
      month = jstNow.getUTCMonth();
    }
  } else {
    const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
    year = jstNow.getUTCFullYear();
    month = jstNow.getUTCMonth();
  }

  const from = `${year}-${(month + 1).toString().padStart(2, "0")}-01`;
  const lastDay = new Date(Date.UTC(year, month + 1, 0));
  const to = lastDay.toISOString().slice(0, 10);
  return { from, to, label: `${year}年${month + 1}月` };
}

/** Returns Mon–Sun "YYYY-MM-DD" strings for the week `weekOffset` weeks from now (JST). */
function getWeekDates(weekOffset = 0): string[] {
  const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const dow = jstNow.getUTCDay(); // 0=Sun
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(jstNow);
  monday.setUTCDate(jstNow.getUTCDate() + mondayOffset + weekOffset * 7);

  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

/** 次の時刻（1時間後）を返す。23:00 → 00:00 */
function nextHour(time: string): string {
  const [h = 0, m = 0] = time.split(":").map(Number);
  return `${((h + 1) % 24).toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

function buildSubmitComponents(
  sessionId: string,
  session: SubmitSession,
): ActionRowBuilder<ButtonBuilder>[] {
  const dayButtons = session.dates.map((date) => {
    const d = new Date(`${date}T00:00:00+09:00`);
    const dow = WEEKDAY_JA[d.getDay()]!;
    const base = `${d.getMonth() + 1}/${d.getDate()}(${dow})`;
    const sel = session.selections[date]!;
    const isActive = session.activeDate === date;
    const hasTimes = sel.times.length > 0;

    let label: string;
    let style: ButtonStyle;
    if (hasTimes && isActive) {
      label = `${base} ${sel.times.join(" ")} ◀`;
      style = ButtonStyle.Success;
    } else if (hasTimes) {
      label = `${base} ${sel.times.join(" ")}`;
      style = ButtonStyle.Success;
    } else if (isActive) {
      label = `${base} ◀`;
      style = ButtonStyle.Primary;
    } else {
      label = base;
      style = ButtonStyle.Secondary;
    }
    return new ButtonBuilder()
      .setCustomId(`${SHIFT_TOGGLE_PREFIX}${sessionId}:${date}`)
      .setLabel(label)
      .setStyle(style);
  });

  const activeTimes = session.activeDate ? session.selections[session.activeDate]!.times : [];
  const timeButtons = SHIFT_TIME_OPTIONS.map((t) =>
    new ButtonBuilder()
      .setCustomId(`${SHIFT_TIME_PREFIX}${sessionId}:${t}`)
      .setLabel(t)
      .setStyle(
        !session.activeDate ? ButtonStyle.Secondary
        : activeTimes.includes(t) ? ButtonStyle.Success
        : ButtonStyle.Primary,
      )
      .setDisabled(!session.activeDate),
  );

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(dayButtons.slice(0, 5)),
    new ActionRowBuilder<ButtonBuilder>().addComponents(dayButtons.slice(5, 7)),
    new ActionRowBuilder<ButtonBuilder>().addComponents(timeButtons),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${SHIFT_CONFIRM_PREFIX}${sessionId}`)
        .setLabel("✅ 提出する")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`${SHIFT_CANCEL_PREFIX}${sessionId}`)
        .setLabel("❌ キャンセル")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function buildSubmitEmbed(session: SubmitSession): EmbedBuilder {
  const from = session.dates[0]!;
  const to   = session.dates[6]!;
  const lines = session.dates.map((date) => {
    const sel = session.selections[date]!;
    const isActive = session.activeDate === date;
    if (sel.times.length > 0) {
      return `🟢 ${formatDateLabel(date)}  ${sel.times.join("  ")}`;
    }
    if (isActive) return `📍 ${formatDateLabel(date)}  ← 時間を選択`;
    return               `⬜ ${formatDateLabel(date)}`;
  });
  return new EmbedBuilder()
    .setTitle("📋 シフト提出")
    .setColor(0x5865f2)
    .setDescription(
      `**${formatDateLabel(from)} 〜 ${formatDateLabel(to)}**\n\n` +
      lines.join("\n"),
    )
    .setFooter({ text: "① 日付を押す → ② 時間を押す ／ 🟢 を押すと取り消し ／ 選び終わったら「提出する」（15分以内）" });
}

// ─── Embed builders ──────────────────────────────────────────────────────────

/** Build one or more embeds showing shifts grouped by date. */
export function buildShiftEmbeds(
  shifts: Shift[],
  title: string,
  from: string,
  to: string,
): EmbedBuilder[] {
  const header = `**${formatDateLabel(from)} 〜 ${formatDateLabel(to)}**`;

  if (shifts.length === 0) {
    return [
      new EmbedBuilder()
        .setTitle(title)
        .setColor(0x5865f2)
        .setDescription(`${header}\n\nこの期間にシフトは登録されていません。`)
        .setTimestamp(),
    ];
  }

  // Group by date (map preserves insertion order)
  const byDate = new Map<string, Shift[]>();
  for (const s of shifts) {
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date)!.push(s);
  }

  const fields: { name: string; value: string }[] = [];
  for (const [date, dayShifts] of [...byDate.entries()].sort()) {
    const lines = dayShifts.map((s) => {
      const note = s.note ? ` — ${s.note}` : "";
      return `• <@${s.userId}> ${s.startTime}${note}`;
    });
    fields.push({
      name: `📅 ${formatDateLabel(date)}`,
      value: lines.join("\n").slice(0, 1024),
    });
  }

  // Discord allows max 25 fields per embed; split if necessary
  const embeds: EmbedBuilder[] = [];
  for (let i = 0; i < fields.length; i += 25) {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .addFields(fields.slice(i, i + 25));
    if (i === 0) {
      embed.setTitle(title).setDescription(header).setTimestamp();
    }
    embeds.push(embed);
  }
  return embeds;
}

function buildSummaryEmbed(
  shifts: Shift[],
  label: string,
  from: string,
  to: string,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`📊 ${label} 勤務回数集計`)
    .setColor(0xfee75c)
    .setDescription(`**${formatDateLabel(from)} 〜 ${formatDateLabel(to)}**`)
    .setTimestamp();

  if (shifts.length === 0) {
    embed.setDescription(`${embed.data.description ?? ""}\n\nこの期間にシフトは登録されていません。`);
    return embed;
  }

  // Aggregate by userId
  const byUser = new Map<string, number>();
  for (const s of shifts) {
    byUser.set(s.userId, (byUser.get(s.userId) ?? 0) + 1);
  }

  // Sort by count descending
  const sorted = [...byUser.entries()].sort((a, b) => b[1] - a[1]);
  const lines = sorted.map(([uid, count], i) => {
    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
    return `${medal} <@${uid}> — **${count}回**`;
  });

  embed.setDescription(`${embed.data.description ?? ""}\n\n${lines.join("\n").slice(0, 3800)}`);
  return embed;
}

// ─── Weekly post ─────────────────────────────────────────────────────────────

/** Returns the next Monday 00:00 UTC (= 09:00 JST) for the weekly auto-post. */
export function getNextWeeklyPostTime(): Date {
  const now = new Date();
  // Find this week's Monday at 00:00 UTC
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = d.getUTCDay(); // 0=Sun
  const daysToThisMon = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + daysToThisMon);
  // If this Monday's post is already past (including right now), jump to next week
  if (d <= now) d.setUTCDate(d.getUTCDate() + 7);
  return d;
}

/** Posts this week's shift schedule to every guild that has a channel configured. */
export async function postWeeklyShifts(client: Client): Promise<void> {
  const settings = await getAllShiftSettings().catch(() => []);
  const { from, to } = getWeekRange();

  for (const setting of settings) {
    if (!setting.channelId) continue;
    try {
      const guild =
        client.guilds.cache.get(setting.guildId) ??
        (await client.guilds.fetch(setting.guildId).catch(() => null));
      if (!guild) continue;

      const channel =
        guild.channels.cache.get(setting.channelId) ??
        (await guild.channels.fetch(setting.channelId).catch(() => null));
      if (!channel?.isTextBased()) continue;

      const shifts = await getShiftsInRange(setting.guildId, from, to);
      const embeds = buildShiftEmbeds(shifts, "📅 今週のシフト", from, to);
      await channel.send({ embeds });
      logger.info(`[shift] Posted weekly schedule to ${setting.channelId} in guild ${setting.guildId}`);
    } catch (err) {
      logger.error(`[shift] Failed to post weekly schedule for guild ${setting.guildId}`, err);
    }
  }
}

// ─── Command ─────────────────────────────────────────────────────────────────

interface Command {
  data: { name: string; toJSON: () => unknown };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

export const shiftCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("shift")
    .setDescription("シフト管理")
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("シフトを削除する（管理者は他人のシフトも削除可）")
        .addIntegerOption((opt) =>
          opt
            .setName("id")
            .setDescription("シフトID（/shift list で確認）")
            .setRequired(true)
            .setMinValue(1),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("list")
        .setDescription("シフト一覧を表示する")
        .addStringOption((opt) =>
          opt
            .setName("period")
            .setDescription("表示期間（デフォルト: 今週）")
            .setRequired(false)
            .addChoices(
              { name: "今週", value: "week" },
              { name: "今月", value: "month" },
            ),
        )
        .addStringOption((opt) =>
          opt
            .setName("date")
            .setDescription("基準日（YYYY-MM-DD）。省略時は今日基準")
            .setRequired(false),
        )
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("絞り込むユーザー（省略時: 全員）")
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("summary")
        .setDescription("月次の勤務回数を集計する")
        .addStringOption((opt) =>
          opt
            .setName("month")
            .setDescription("集計月（例: 2026-07）。省略時は今月")
            .setRequired(false),
        )
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("特定ユーザーに絞り込む")
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("submit")
        .setDescription("○/✕ボタンで週間シフトをまとめて提出する（各日の時間はボタン押下後に入力）")
        .addIntegerOption((opt) =>
          opt
            .setName("week")
            .setDescription("対象週（0=今週・1=来週・-1=先週。デフォルト: 0）")
            .setRequired(false)
            .setMinValue(-4)
            .setMaxValue(4),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("panel")
        .setDescription("このチャンネルにシフト提出ボタンを設置します（管理者）"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("setup")
        .setDescription("週次自動投稿の設定・手動投稿（管理者）")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("投稿先テキストチャンネル（変更する場合のみ指定）")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false),
        )
        .addBooleanOption((opt) =>
          opt
            .setName("post-now")
            .setDescription("今すぐ今週のシフト表を投稿する")
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("reward")
            .setDescription("シフト1回あたりの報酬額（0で無効化）")
            .setRequired(false)
            .setMinValue(0),
        )
        .addRoleOption((opt) =>
          opt.setName("submit_role_1").setDescription("/shift submit を使えるロール①").setRequired(false),
        )
        .addRoleOption((opt) =>
          opt.setName("submit_role_2").setDescription("/shift submit を使えるロール②").setRequired(false),
        )
        .addRoleOption((opt) =>
          opt.setName("submit_role_3").setDescription("/shift submit を使えるロール③").setRequired(false),
        )
        .addBooleanOption((opt) =>
          opt.setName("submit_role_clear").setDescription("submitロール制限を解除して全員に開放する").setRequired(false),
        ),
    ),

  async execute(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: "このコマンドはサーバー内でのみ使用できます。", ephemeral: true });
      return;
    }

    const guildId = interaction.guildId;
    const sub = interaction.options.getSubcommand();
    const isAdmin = !!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);

    // ── /shift submit ─────────────────────────────────────────────────────────
    if (sub === "submit") {
      // ロール制限チェック
      const settings = await getShiftSettings(guildId);
      const allowedRoles = settings?.submitRoleIds ?? [];
      if (allowedRoles.length > 0 && !isAdmin) {
        const memberRoles = interaction.member && "roles" in interaction.member
          ? (interaction.member.roles as { cache: Map<string, unknown> }).cache
          : null;
        const hasRole = memberRoles ? allowedRoles.some((id: string) => memberRoles.has(id)) : false;
        if (!hasRole) {
          await interaction.reply({
            content: `❌ このコマンドは指定されたロールのメンバーのみ使用できます。`,
            ephemeral: true,
          });
          return;
        }
      }

      const weekOffset = interaction.options.getInteger("week") ?? 0;

      cleanExpiredSessions();

      const sessionId = interaction.id;
      const dates = getWeekDates(weekOffset);
      const session: SubmitSession = {
        guildId,
        userId: interaction.user.id,
        dates,
        selections: Object.fromEntries(dates.map((d) => [d, { times: [] }])),
        expiresAt: Date.now() + 15 * 60 * 1000,
      };
      submitSessions.set(sessionId, session);

      await interaction.reply({
        embeds: [buildSubmitEmbed(session)],
        components: buildSubmitComponents(sessionId, session),
        ephemeral: true,
      });
      return;
    }

    // ── /shift remove ─────────────────────────────────────────────────────────
    if (sub === "remove") {
      const id = interaction.options.getInteger("id", true);
      const result = await removeShift(id, guildId, interaction.user.id, isAdmin);

      if (result === "not_found") {
        await interaction.reply({
          content: `❌ シフト #${id} が見つかりません。`,
          ephemeral: true,
        });
        return;
      }
      if (result === "forbidden") {
        await interaction.reply({
          content: "❌ 他のメンバーのシフトは削除できません。",
          ephemeral: true,
        });
        return;
      }

      await interaction.reply({ content: `✅ シフト #${id} を削除しました。`, ephemeral: true });
      return;
    }

    // ── /shift list ───────────────────────────────────────────────────────────
    if (sub === "list") {
      await interaction.deferReply();

      const period = interaction.options.getString("period") ?? "week";
      const dateOpt = interaction.options.getString("date") ?? undefined;
      const userOpt = interaction.options.getUser("user");

      let from: string, to: string, title: string;

      if (period === "month") {
        const range = getMonthRange(dateOpt);
        from = range.from;
        to = range.to;
        title = `📅 ${range.label} シフト一覧`;
      } else {
        const range = getWeekRange(dateOpt);
        from = range.from;
        to = range.to;
        title = "📅 週間シフト一覧";
      }

      const shifts = await getShiftsInRange(guildId, from, to, userOpt?.id);
      const embeds = buildShiftEmbeds(shifts, title, from, to);
      await interaction.editReply({ embeds });
      return;
    }

    // ── /shift summary ────────────────────────────────────────────────────────
    if (sub === "summary") {
      await interaction.deferReply();

      const monthOpt = interaction.options.getString("month") ?? undefined;
      const userOpt = interaction.options.getUser("user");
      const { from, to, label } = getMonthRange(monthOpt);

      const shifts = await getShiftsInRange(guildId, from, to, userOpt?.id);
      const embed = buildSummaryEmbed(shifts, label, from, to);
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── /shift panel ──────────────────────────────────────────────────────────
    if (sub === "panel") {
      if (!isAdmin) {
        await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
        return;
      }
      if (!interaction.channel?.isTextBased()) {
        await interaction.reply({ content: "テキストチャンネル内で実行してください。", ephemeral: true });
        return;
      }
      const embed = new EmbedBuilder()
        .setTitle("📋 シフト提出")
        .setColor(0x5865f2)
        .setDescription("下のボタンを押すと今週のシフト提出フォームが開きます。");
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(SHIFT_PANEL_OPEN)
          .setLabel("📋 シフトを提出する")
          .setStyle(ButtonStyle.Primary),
      );
      const ch = interaction.channel;
      if (!ch || !("send" in ch)) {
        await interaction.reply({ content: "このチャンネルにはメッセージを送信できません。", ephemeral: true });
        return;
      }
      await ch.send({ embeds: [embed], components: [row] });
      await interaction.reply({ content: "✅ シフト提出パネルを設置しました。", ephemeral: true });
      return;
    }

    // ── /shift setup ──────────────────────────────────────────────────────────
    if (sub === "setup") {
      if (!isAdmin) {
        await interaction.reply({
          content: "このコマンドはサーバー管理権限が必要です。",
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      const channelOpt     = interaction.options.getChannel("channel");
      const postNow        = interaction.options.getBoolean("post-now") ?? false;
      const rewardOpt      = interaction.options.getInteger("reward");
      const clearRoles     = interaction.options.getBoolean("submit_role_clear") ?? false;
      const submitRoles    = [1, 2, 3]
        .map((n) => interaction.options.getRole(`submit_role_${n}`))
        .filter(Boolean);

      if (!channelOpt && !postNow && rewardOpt === null && submitRoles.length === 0 && !clearRoles) {
        await interaction.editReply(
          "`channel`・`reward`・`post-now`・`submit_role_*`・`submit_role_clear` のいずれかを指定してください。",
        );
        return;
      }

      const lines: string[] = [];

      // 報酬額変更
      if (rewardOpt !== null) {
        await setShiftRewardAmount(guildId, rewardOpt);
        lines.push(
          rewardOpt === 0
            ? "✅ シフト出勤報酬を**無効化**しました。"
            : `✅ シフト1回あたりの報酬を **${rewardOpt}** に設定しました。`,
        );
      }

      // submitロール設定
      if (clearRoles) {
        await setShiftSubmitRoles(guildId, []);
        lines.push("✅ `/shift submit` のロール制限を解除しました（全員が使用可能）。");
      } else if (submitRoles.length > 0) {
        const roleIds = submitRoles.map((r) => r!.id);
        await setShiftSubmitRoles(guildId, roleIds);
        lines.push(`✅ \`/shift submit\` を使用できるロールを設定しました: ${submitRoles.map((r) => `<@&${r!.id}>`).join(" ")}`);
      }

      // チャンネル変更
      if (channelOpt) {
        await setShiftSettings(guildId, channelOpt.id);
        const nextPost = getNextWeeklyPostTime();
        const ts = Math.floor(nextPost.getTime() / 1000);
        lines.push(`✅ 週次シフト自動投稿チャンネルを <#${channelOpt.id}> に設定しました。`);
        lines.push(`次回自動投稿: <t:${ts}:F>（<t:${ts}:R>）`);
      }

      // 即時投稿
      if (postNow) {
        const settings = await getShiftSettings(guildId);
        const targetId = channelOpt?.id ?? settings?.channelId;
        if (!targetId) {
          await interaction.editReply(
            "投稿チャンネルが設定されていません。`channel` オプションで指定してください。",
          );
          return;
        }
        const ch =
          interaction.guild?.channels.cache.get(targetId) ??
          (await interaction.guild?.channels.fetch(targetId).catch(() => null));
        if (!ch?.isTextBased()) {
          await interaction.editReply("チャンネルが見つからないか、テキストチャンネルではありません。");
          return;
        }
        const { from, to } = getWeekRange();
        const shifts = await getShiftsInRange(guildId, from, to);
        const embeds = buildShiftEmbeds(shifts, "📅 今週のシフト", from, to);
        await ch.send({ embeds });
        lines.push(`✅ <#${targetId}> に今週のシフト表を投稿しました。`);
      }

      await interaction.editReply(lines.join("\n"));
      return;
    }
  },
};

// ─── /shift submit — button handlers ─────────────────────────────────────────

function parseSessionId(customId: string, prefix: string): string {
  return customId.slice(prefix.length);
}

function parseSessionDate(customId: string, prefix: string): { sessionId: string; date: string } {
  const rest = customId.slice(prefix.length);
  const idx = rest.indexOf(":");
  return { sessionId: rest.slice(0, idx), date: rest.slice(idx + 1) };
}

function parseSessionTime(customId: string, prefix: string): { sessionId: string; time: string } {
  // customId = "{prefix}{sessionId}:{time}"  time には : が含まれる (HH:MM)
  const rest = customId.slice(prefix.length);
  const idx = rest.indexOf(":");
  return { sessionId: rest.slice(0, idx), time: rest.slice(idx + 1) };
}

function checkSession(
  session: SubmitSession | undefined,
  userId: string,
): "ok" | "not_found" | "expired" {
  if (!session || session.userId !== userId) return "not_found";
  if (Date.now() > session.expiresAt) return "expired";
  return "ok";
}

/**
 * 日付ボタン:
 *   — (非アクティブ) → アクティブ化（時間ボタン待ち）
 *   — (アクティブ)   → 解除
 *   ○               → — に戻す（取り消し）
 */
export async function handleShiftToggle(interaction: ButtonInteraction): Promise<void> {
  const { sessionId, date } = parseSessionDate(interaction.customId, SHIFT_TOGGLE_PREFIX);
  const session = submitSessions.get(sessionId);
  const check = checkSession(session, interaction.user.id);

  if (check === "not_found") {
    await interaction.reply({ content: "このフォームはあなたのものではないか、期限切れです。", ephemeral: true });
    return;
  }
  if (check === "expired") {
    submitSessions.delete(sessionId);
    await interaction.reply({ content: "フォームの有効期限が切れました。もう一度 `/shift submit` を実行してください。", ephemeral: true });
    return;
  }

  const s = session!;

  if (s.activeDate === date) {
    // アクティブ中 → 解除
    s.activeDate = undefined;
  } else {
    // 非アクティブ → アクティブ化（時間ボタン待ち／編集）
    s.activeDate = date;
  }

  await interaction.update({
    embeds: [buildSubmitEmbed(s)],
    components: buildSubmitComponents(sessionId, s),
  });
}

/**
 * 時間ボタン: アクティブな日付に時間を割り当てて ○ 確定
 */
export async function handleShiftTime(interaction: ButtonInteraction): Promise<void> {
  const { sessionId, time } = parseSessionTime(interaction.customId, SHIFT_TIME_PREFIX);
  const session = submitSessions.get(sessionId);
  const check = checkSession(session, interaction.user.id);

  if (check === "not_found") {
    await interaction.reply({ content: "このフォームはあなたのものではないか、期限切れです。", ephemeral: true });
    return;
  }
  if (check === "expired") {
    submitSessions.delete(sessionId);
    await interaction.reply({ content: "フォームの有効期限が切れました。もう一度 `/shift submit` を実行してください。", ephemeral: true });
    return;
  }

  const s = session!;
  if (!s.activeDate) {
    await interaction.reply({ content: "先に日付ボタンを押してください。", ephemeral: true });
    return;
  }

  const times = s.selections[s.activeDate]!.times;
  const idx = times.indexOf(time);
  if (idx === -1) {
    times.push(time);
    times.sort(); // 昇順に保つ
  } else {
    times.splice(idx, 1);
  }
  // activeDate はそのまま保持（続けて他の時間を追加・削除できる）

  await interaction.update({
    embeds: [buildSubmitEmbed(s)],
    components: buildSubmitComponents(sessionId, s),
  });
}

/** Confirm and save all ○ days as shifts. */
export async function handleShiftConfirm(interaction: ButtonInteraction): Promise<void> {
  const sessionId = interaction.customId.slice(SHIFT_CONFIRM_PREFIX.length);
  const session = submitSessions.get(sessionId);
  const check = checkSession(session, interaction.user.id);

  if (check === "not_found") {
    await interaction.reply({ content: "このフォームはあなたのものではないか、期限切れです。", ephemeral: true });
    return;
  }
  if (check === "expired") {
    submitSessions.delete(sessionId);
    await interaction.reply({ content: "フォームの有効期限が切れました。もう一度 `/shift submit` を実行してください。", ephemeral: true });
    return;
  }

  await interaction.deferUpdate();

  const s = session!;
  const workDays = s.dates.filter((d) => s.selections[d]!.times.length > 0);

  const saved: { date: string; start: string; end: string }[] = [];
  for (const date of workDays) {
    for (const start of s.selections[date]!.times) {
      const end = nextHour(start);
      try {
        await addShift(s.guildId, s.userId, date, start, end, null);
        saved.push({ date, start, end });
      } catch (err) {
        logger.error(`[shift:submit] Failed to save shift for ${date} ${start}`, err);
      }
    }
  }

  submitSessions.delete(sessionId);

  const lines: string[] = [];
  if (saved.length > 0) {
    // 日付ごとにグループ化して表示
    const byDate = new Map<string, { start: string; end: string }[]>();
    for (const entry of saved) {
      if (!byDate.has(entry.date)) byDate.set(entry.date, []);
      byDate.get(entry.date)!.push(entry);
    }
    for (const [date, slots] of byDate) {
      const slotStr = slots.map(({ start }) => start).join("  ");
      lines.push(`　🟢 ${formatDateLabel(date)}  ${slotStr}`);
    }
    lines.unshift(`✅ **${workDays.length}日・計${saved.length}スロット登録**`);
  } else {
    lines.push("出勤日が選択されていないためシフトは登録されませんでした。");
  }

  const resultEmbed = new EmbedBuilder()
    .setTitle("📋 シフト提出完了")
    .setColor(saved.length > 0 ? 0x57f287 : 0x95a5a6)
    .setDescription(lines.join("\n"))
    .setTimestamp();

  await interaction.editReply({ embeds: [resultEmbed], components: [] });
}

/** Cancel without saving. */
export async function handleShiftCancel(interaction: ButtonInteraction): Promise<void> {
  const sessionId = interaction.customId.slice(SHIFT_CANCEL_PREFIX.length);
  submitSessions.delete(sessionId);
  await interaction.update({
    embeds: [new EmbedBuilder().setTitle("❌ シフト提出をキャンセルしました").setColor(0x95a5a6)],
    components: [],
  });
}

/** パネルボタン押下: /shift submit と同じフローを ephemeral で起動 */
export async function handleShiftPanelOpen(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "このボタンはサーバー内でのみ使用できます。", ephemeral: true });
    return;
  }

  const guildId = interaction.guildId;
  const settings = await getShiftSettings(guildId);
  const allowedRoles = settings?.submitRoleIds ?? [];
  if (allowedRoles.length > 0) {
    const memberRoles = interaction.member && "roles" in interaction.member
      ? (interaction.member.roles as { cache: Map<string, unknown> }).cache
      : null;
    const hasRole = memberRoles ? allowedRoles.some((id: string) => memberRoles.has(id)) : false;
    if (!hasRole) {
      await interaction.reply({ content: "❌ このボタンは指定されたロールのメンバーのみ使用できます。", ephemeral: true });
      return;
    }
  }

  cleanExpiredSessions();
  const sessionId = interaction.id;
  const dates = getWeekDates(0);
  const session: SubmitSession = {
    guildId,
    userId: interaction.user.id,
    dates,
    selections: Object.fromEntries(dates.map((d) => [d, { times: [] }])),
    expiresAt: Date.now() + 15 * 60 * 1000,
  };
  submitSessions.set(sessionId, session);

  await interaction.reply({
    embeds: [buildSubmitEmbed(session)],
    components: buildSubmitComponents(sessionId, session),
    ephemeral: true,
  });
}
