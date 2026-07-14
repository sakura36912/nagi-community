import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
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
  setShiftSettings,
  type Shift,
} from "../lib/shift.js";

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
      const mins = calcMinutes(s.startTime, s.endTime);
      const note = s.note ? ` — ${s.note}` : "";
      return `• <@${s.userId}> ${s.startTime}〜${s.endTime}（${formatDuration(mins)}）${note}`;
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
    .setTitle(`📊 ${label} 勤務集計`)
    .setColor(0xfee75c)
    .setDescription(`**${formatDateLabel(from)} 〜 ${formatDateLabel(to)}**`)
    .setTimestamp();

  if (shifts.length === 0) {
    embed.setDescription(`${embed.data.description ?? ""}\n\nこの期間にシフトは登録されていません。`);
    return embed;
  }

  // Aggregate by userId
  const byUser = new Map<string, { count: number; minutes: number }>();
  for (const s of shifts) {
    if (!byUser.has(s.userId)) byUser.set(s.userId, { count: 0, minutes: 0 });
    const rec = byUser.get(s.userId)!;
    rec.count += 1;
    rec.minutes += Math.max(0, calcMinutes(s.startTime, s.endTime));
  }

  // Sort by total hours descending
  const sorted = [...byUser.entries()].sort((a, b) => b[1].minutes - a[1].minutes);
  const lines = sorted.map(([uid, rec], i) => {
    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
    return `${medal} <@${uid}> — **${formatDuration(rec.minutes)}** （${rec.count}件のシフト）`;
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
        .setName("add")
        .setDescription("シフトを登録する")
        .addStringOption((opt) =>
          opt
            .setName("date")
            .setDescription("日付（例: 2026-07-14 または 7/14）")
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("start")
            .setDescription("開始時刻（例: 10:00）")
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("end")
            .setDescription("終了時刻（例: 18:00）")
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("note")
            .setDescription("備考（任意、最大100文字）")
            .setRequired(false)
            .setMaxLength(100),
        ),
    )
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
        .setDescription("月次の勤務時間を集計する")
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
        .setName("setup")
        .setDescription("毎週月曜 9:00（JST）に自動投稿するチャンネルを設定する（管理者）")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("投稿先テキストチャンネル")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("post")
        .setDescription("今週のシフト表を今すぐ投稿する（管理者）"),
    ),

  async execute(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: "このコマンドはサーバー内でのみ使用できます。", ephemeral: true });
      return;
    }

    const guildId = interaction.guildId;
    const sub = interaction.options.getSubcommand();
    const isAdmin = !!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);

    // ── /shift add ────────────────────────────────────────────────────────────
    if (sub === "add") {
      const dateInput = interaction.options.getString("date", true);
      const startInput = interaction.options.getString("start", true);
      const endInput = interaction.options.getString("end", true);
      const note = interaction.options.getString("note");

      const date = parseDate(dateInput);
      if (!date) {
        await interaction.reply({
          content: "❌ 日付の形式が正しくありません。`2026-07-14` または `7/14` の形式で入力してください。",
          ephemeral: true,
        });
        return;
      }

      const start = parseTime(startInput);
      if (!start) {
        await interaction.reply({
          content: "❌ 開始時刻の形式が正しくありません。`10:00` のように `HH:MM` で入力してください。",
          ephemeral: true,
        });
        return;
      }

      const end = parseTime(endInput);
      if (!end) {
        await interaction.reply({
          content: "❌ 終了時刻の形式が正しくありません。`18:00` のように `HH:MM` で入力してください。",
          ephemeral: true,
        });
        return;
      }

      const mins = calcMinutes(start, end);
      if (mins <= 0) {
        await interaction.reply({
          content: "❌ 終了時刻は開始時刻より後でなければなりません。深夜をまたぐシフトは2件に分けて登録してください。",
          ephemeral: true,
        });
        return;
      }

      const shift = await addShift(guildId, interaction.user.id, date, start, end, note);

      const embed = new EmbedBuilder()
        .setTitle("✅ シフトを登録しました")
        .setColor(0x57f287)
        .addFields(
          { name: "📅 日付", value: formatDateLabel(date), inline: true },
          { name: "⏰ 時間", value: `${start}〜${end}（${formatDuration(mins)}）`, inline: true },
          { name: "🔢 シフトID", value: `#${shift.id}`, inline: true },
        );
      if (note) embed.addFields({ name: "📝 備考", value: note, inline: false });

      await interaction.reply({ embeds: [embed], ephemeral: true });
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

    // ── /shift setup ──────────────────────────────────────────────────────────
    if (sub === "setup") {
      if (!isAdmin) {
        await interaction.reply({
          content: "このコマンドはサーバー管理権限が必要です。",
          ephemeral: true,
        });
        return;
      }

      const channel = interaction.options.getChannel("channel", true);
      await setShiftSettings(guildId, channel.id);

      const nextPost = getNextWeeklyPostTime();
      const ts = Math.floor(nextPost.getTime() / 1000);

      await interaction.reply({
        content: [
          `✅ 週次シフト自動投稿チャンネルを <#${channel.id}> に設定しました。`,
          `次回投稿: <t:${ts}:F>（<t:${ts}:R>）`,
        ].join("\n"),
        ephemeral: true,
      });
      return;
    }

    // ── /shift post ───────────────────────────────────────────────────────────
    if (sub === "post") {
      if (!isAdmin) {
        await interaction.reply({
          content: "このコマンドはサーバー管理権限が必要です。",
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      const settings = await getShiftSettings(guildId);
      if (!settings?.channelId) {
        await interaction.editReply(
          "投稿チャンネルが設定されていません。先に `/shift setup channel:` で設定してください。",
        );
        return;
      }

      const channel =
        interaction.guild?.channels.cache.get(settings.channelId) ??
        (await interaction.guild?.channels.fetch(settings.channelId).catch(() => null));

      if (!channel?.isTextBased()) {
        await interaction.editReply(
          "設定されたチャンネルが見つからないか、テキストチャンネルではありません。",
        );
        return;
      }

      const { from, to } = getWeekRange();
      const shifts = await getShiftsInRange(guildId, from, to);
      const embeds = buildShiftEmbeds(shifts, "📅 今週のシフト", from, to);
      await channel.send({ embeds });
      await interaction.editReply(`✅ <#${settings.channelId}> に今週のシフト表を投稿しました。`);
      return;
    }
  },
};
