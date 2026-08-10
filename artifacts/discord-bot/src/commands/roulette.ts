/**
 * /roulette — ヨーロピアンルーレット（0〜36、シングルゼロ）
 *
 * フロー:
 *   1. /roulette <bet> → 賭け方選択UI（ボタン10個）
 *   2. 色・奇偶・ロー/ハイ・ダズン → 即スピン
 *   3. 「数字を選ぶ」→ 0〜36 セレクトメニュー表示 → スピン
 */

import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { and, eq, sql } from "drizzle-orm";
import { db, walletsTable } from "@workspace/db";
import { getGuildSettings, getOrCreateWallet, recordTransaction } from "../lib/economy";

// 自作GIFを起動時に読み込む（毎スピン生成不要、即時添付可能）
const __dir = dirname(fileURLToPath(import.meta.url));
const ROULETTE_GIF = readFileSync(join(__dir, "../../assets/roulette.gif"));

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_BET       = 10;
const MAX_BET       = 100_000;
const SESSION_TTL   = 3 * 60 * 1000; // 3分

const RED_NUMBERS = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18,
  19, 21, 23, 25, 27, 30, 32, 34, 36,
]);

const COLOR_NEUTRAL = 0x5865f2;
const COLOR_WIN     = 0x57f287;
const COLOR_LOSE    = 0xed4245;

export const ROULETTE_PREFIX = "rlt:";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function numColor(n: number): string {
  if (n === 0) return "🟢";
  return RED_NUMBERS.has(n) ? "🔴" : "⚫";
}

function spin(): number { return Math.floor(Math.random() * 37); }

// ─── Session management ───────────────────────────────────────────────────────

interface RouletteSession {
  guildId: string;
  userId: string;
  bet: number;
  currencyName: string;
  expiresAt: number;
}

const sessions = new Map<string, RouletteSession>();
const sKey = (guildId: string, userId: string) => `${guildId}:${userId}`;

setInterval(() => {
  const now = Date.now();
  for (const [k, s] of sessions) if (s.expiresAt < now) sessions.delete(k);
}, 60_000);

// ─── UI builders ──────────────────────────────────────────────────────────────

function betTypeComponents() {
  const r1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("rlt:color:red")  .setLabel("レッド")     .setEmoji("🔴").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("rlt:color:black").setLabel("ブラック")   .setEmoji("⚫").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("rlt:par:odd")    .setLabel("奇数")       .setEmoji("🔢").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("rlt:par:even")   .setLabel("偶数")       .setEmoji("🔢").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("rlt:numsel")     .setLabel("数字を選ぶ") .setEmoji("🎯").setStyle(ButtonStyle.Primary),
  );
  const r2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("rlt:half:low")  .setLabel("ロー  1〜18") .setEmoji("📉").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("rlt:half:high") .setLabel("ハイ 19〜36") .setEmoji("📈").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("rlt:doz:1")     .setLabel("1〜12")       .setEmoji("1️⃣").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("rlt:doz:2")     .setLabel("13〜24")      .setEmoji("2️⃣").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("rlt:doz:3")     .setLabel("25〜36")      .setEmoji("3️⃣").setStyle(ButtonStyle.Secondary),
  );
  return [r1, r2];
}

function numberSelectComponents() {
  // 0〜24 (25件) と 25〜36 (12件) で2つのセレクトメニューに分割
  const mkOpt = (n: number) =>
    new StringSelectMenuOptionBuilder()
      .setLabel(String(n))
      .setValue(String(n))
      .setEmoji(numColor(n))
      .setDescription(n === 0 ? "グリーン" : RED_NUMBERS.has(n) ? "レッド" : "ブラック");

  const lo = new StringSelectMenuBuilder()
    .setCustomId("rlt:num:lo")
    .setPlaceholder("0〜24 から選ぶ")
    .addOptions(Array.from({ length: 25 }, (_, i) => mkOpt(i)));

  const hi = new StringSelectMenuBuilder()
    .setCustomId("rlt:num:hi")
    .setPlaceholder("25〜36 から選ぶ")
    .addOptions(Array.from({ length: 12 }, (_, i) => mkOpt(i + 25)));

  const back = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("rlt:back").setLabel("← 戻る").setStyle(ButtonStyle.Secondary),
  );

  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(lo),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(hi),
    back,
  ];
}

function selectionEmbed(session: RouletteSession, title = "何に賭けますか？"): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("🏴‍☠️ 海賊ルーレット")
    .setDescription(`賭け金: **${session.bet.toLocaleString()}** ${session.currencyName}\n\n${title}`)
    .setColor(COLOR_NEUTRAL)
    .setFooter({ text: "配当: 数字×35 | 色/奇偶/ロー・ハイ×1 | ダズン×2 | 0は全て外れ | 3分でタイムアウト" });
}

// ─── Balance helpers ──────────────────────────────────────────────────────────

async function deductBet(guildId: string, userId: string, bet: number) {
  const [row] = await db
    .update(walletsTable)
    .set({ balance: sql`${walletsTable.balance} - ${bet}` })
    .where(and(
      eq(walletsTable.guildId, guildId),
      eq(walletsTable.userId, userId),
      sql`${walletsTable.balance} >= ${bet}`,
    ))
    .returning({ balance: walletsTable.balance });
  return row ?? null;
}

async function creditAmount(guildId: string, userId: string, amount: number) {
  const [row] = await db
    .update(walletsTable)
    .set({ balance: sql`${walletsTable.balance} + ${amount}` })
    .where(and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId)))
    .returning({ balance: walletsTable.balance });
  return row?.balance ?? 0;
}

// ─── Animation helpers ────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function randNum(): number { return Math.floor(Math.random() * 37); }

function wheelRow(nums: number[], ci = 2): string {
  return nums.map((n, i) => {
    const c = numColor(n);
    return i === ci ? `**｢ ${c} ${n} ｣**` : `${c} ${n}`;
  }).join("  ·  ");
}

function spinningEmbed(row: string, status: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("🏴‍☠️ 海賊ルーレット")
    .setDescription(`-# ${status}\n\n${row}\n`)
    .setColor(COLOR_NEUTRAL);
}

// ─── Resolve helpers ──────────────────────────────────────────────────────────

interface ResolveResult { win: boolean; multiplier: number; betDesc: string }

function resolveColor(landed: number, color: "red" | "black"): ResolveResult {
  const isRed = RED_NUMBERS.has(landed);
  const win = color === "red" ? isRed : (!isRed && landed !== 0);
  return { win, multiplier: 1, betDesc: color === "red" ? "🔴 レッド" : "⚫ ブラック" };
}
function resolveParity(landed: number, p: "odd" | "even"): ResolveResult {
  const win = landed !== 0 && (p === "odd" ? landed % 2 === 1 : landed % 2 === 0);
  return { win, multiplier: 1, betDesc: p === "odd" ? "🔢 オッド（奇数）" : "🔢 イーブン（偶数）" };
}
function resolveHalf(landed: number, r: "low" | "high"): ResolveResult {
  const win = landed !== 0 && (r === "low" ? landed <= 18 : landed >= 19);
  return { win, multiplier: 1, betDesc: r === "low" ? "📉 ロー（1〜18）" : "📈 ハイ（19〜36）" };
}
function resolveDozen(landed: number, d: 1 | 2 | 3): ResolveResult {
  const [lo, hi] = ({ 1: [1,12], 2: [13,24], 3: [25,36] } as Record<number,[number,number]>)[d];
  return { win: landed >= lo && landed <= hi, multiplier: 2, betDesc: `🎰 ダズン${d}（${lo}〜${hi}）` };
}
function resolveNumber(landed: number, target: number): ResolveResult {
  return { win: landed === target, multiplier: 35, betDesc: `🎯 **${target}**（${numColor(target)}）` };
}

// ─── Spin runner ──────────────────────────────────────────────────────────────

async function runSpin(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  session: RouletteSession,
  landed: number,
  result: ResolveResult,
): Promise<void> {
  const { guildId, userId, bet, currencyName } = session;
  sessions.delete(sKey(guildId, userId));

  // ベット控除 — deferUpdate より先に実行してエラーを早期返却
  const afterDeduct = await deductBet(guildId, userId, bet);
  if (!afterDeduct) {
    await interaction.reply({
      content: "❌ 残高が不足しています。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();

  for (let i = 0; i < 4; i++) {
    await interaction.editReply({ embeds: [spinningEmbed(wheelRow(Array.from({length:5},()=>randNum())), "🔄 スピン中...")], components: [] });
    await sleep(420);
  }
  await interaction.editReply({
    embeds: [spinningEmbed(wheelRow([randNum(), randNum(), randNum(), randNum(), landed]), "📉 速度が落ちています...")],
  });
  await sleep(650);
  await interaction.editReply({
    embeds: [spinningEmbed(wheelRow([randNum(), landed, randNum(), randNum(), randNum()], 1), "🛑 もうすぐ止まります...")],
  });
  await sleep(900);

  // 決済
  let netDelta: number;
  if (result.win) {
    const winnings = bet * result.multiplier;
    await creditAmount(guildId, userId, bet + winnings);
    netDelta = winnings;
  } else {
    netDelta = -bet;
  }
  if (netDelta !== 0) {
    await recordTransaction(guildId, userId, netDelta, `ルーレット ${result.betDesc}（賭け: ${bet}）`).catch(() => {});
  }

  const sign  = netDelta > 0 ? "+" : "";
  const lc    = numColor(landed);
  const att   = new AttachmentBuilder(ROULETTE_GIF, { name: "roulette.gif" });

  const embed = new EmbedBuilder()
    .setTitle(`🏴‍☠️ 海賊ルーレット — ${result.win ? "✅ 勝利！" : "❌ 敗北"}`)
    .setColor(result.win ? COLOR_WIN : COLOR_LOSE)
    .setImage("attachment://roulette.gif")
    .addFields(
      { name: "ボールが止まった数字", value: `## ${lc} **${landed}**` },
      { name: "ベット", value: result.betDesc, inline: true },
      { name: "収支", value: `${sign}${netDelta.toLocaleString()} ${currencyName}`, inline: true },
      ...(result.win ? [{ name: "倍率", value: `${result.multiplier}x`, inline: true }] : []),
    )
    .setFooter({ text: "配当: 数字×35 | 色/奇偶/ロー・ハイ×1 | ダズン×2 | 0は全て外れ" })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed], files: [att], components: [] });
}

// ─── Button / Select handler (exported to index.ts) ───────────────────────────

export async function handleRouletteInteraction(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
): Promise<void> {
  const { guildId, user } = interaction;
  if (!guildId) return;

  const key    = sKey(guildId, user.id);
  const action = interaction.customId.slice(ROULETTE_PREFIX.length); // e.g. "color:red"

  // ── 戻るボタン ──
  if (action === "back") {
    const s = sessions.get(key);
    if (!s) { await interaction.update({ embeds: [], components: [] }); return; }
    await interaction.update({ embeds: [selectionEmbed(s)], components: betTypeComponents() });
    return;
  }

  // ── 数字セレクトメニューを表示 ──
  if (action === "numsel") {
    const s = sessions.get(key);
    if (!s) { await interaction.update({ embeds: [], components: [] }); return; }
    if (s.userId !== user.id) {
      await interaction.reply({ content: "このゲームはあなたのものではありません。", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.update({
      embeds: [selectionEmbed(s, "数字（0〜36）を選んでください")],
      components: numberSelectComponents(),
    });
    return;
  }

  // ── ここから先: セッション必須 & 所有者チェック ──
  const session = sessions.get(key);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(key);
    await interaction.reply({ content: "セッションが切れました。`/roulette` でやり直してください。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (session.userId !== user.id) {
    await interaction.reply({ content: "このゲームはあなたのものではありません。", flags: MessageFlags.Ephemeral });
    return;
  }

  const landed = spin();

  // ── 数字セレクトメニュー選択 ──
  if ((action === "num:lo" || action === "num:hi") && interaction.isStringSelectMenu()) {
    const target = parseInt(interaction.values[0], 10);
    await runSpin(interaction, session, landed, resolveNumber(landed, target));
    return;
  }

  // ── ベット種別ボタン ──
  if (!interaction.isButton()) return;
  const [type, value] = action.split(":");
  if (type === "color") await runSpin(interaction, session, landed, resolveColor(landed, value as "red"|"black"));
  if (type === "par")   await runSpin(interaction, session, landed, resolveParity(landed, value as "odd"|"even"));
  if (type === "half")  await runSpin(interaction, session, landed, resolveHalf(landed, value as "low"|"high"));
  if (type === "doz")   await runSpin(interaction, session, landed, resolveDozen(landed, parseInt(value) as 1|2|3));
}

// ─── /roulette ────────────────────────────────────────────────────────────────

async function handlePlay(interaction: ChatInputCommandInteraction): Promise<void> {
  const { guildId } = interaction;
  if (!guildId) return;
  const userId = interaction.user.id;
  const bet    = interaction.options.getInteger("bet", true);

  const key = sKey(guildId, userId);
  if (sessions.has(key)) {
    await interaction.reply({ content: "すでにゲームが進行中です。", flags: MessageFlags.Ephemeral });
    return;
  }

  const [, { currencyName }] = await Promise.all([
    getOrCreateWallet(guildId, userId),
    getGuildSettings(guildId),
  ]);

  const session: RouletteSession = { guildId, userId, bet, currencyName, expiresAt: Date.now() + SESSION_TTL };
  sessions.set(key, session);

  await interaction.reply({
    embeds: [selectionEmbed(session)],
    components: betTypeComponents(),
  });
}

export const rouletteCommand = {
  data: new SlashCommandBuilder()
    .setName("roulette")
    .setDescription("ヨーロピアンルーレット — ボタンで賭け方を選ぶ")
    .addIntegerOption((o) =>
      o.setName("bet")
        .setDescription(`賭け金（${MIN_BET}〜${MAX_BET.toLocaleString()}）`)
        .setMinValue(MIN_BET)
        .setMaxValue(MAX_BET)
        .setRequired(true),
    ),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await handlePlay(interaction);
  },
};
