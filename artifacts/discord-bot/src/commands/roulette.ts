/**
 * /roulette — ヨーロピアンルーレット（0〜36、シングルゼロ）
 *
 * サブコマンド:
 *   number  — ストレートアップ（特定の数字）  35x
 *   color   — レッド / ブラック              1x
 *   parity  — オッド / イーブン              1x
 *   half    — ロー (1-18) / ハイ (19-36)    1x
 *   dozen   — 1〜12 / 13〜24 / 25〜36       2x
 */

import {
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { and, eq, sql } from "drizzle-orm";
import { db, walletsTable } from "@workspace/db";
import { getGuildSettings, getOrCreateWallet, recordTransaction } from "../lib/economy";

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_BET = 10;
const MAX_BET = 100_000;

// ヨーロピアン・ルーレットの赤い数字
const RED_NUMBERS = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18,
  19, 21, 23, 25, 27, 30, 32, 34, 36,
]);

const COLOR_NEUTRAL = 0x5865f2;
const COLOR_WIN     = 0x57f287;
const COLOR_LOSE    = 0xed4245;
const COLOR_PUSH    = 0xfee75c; // 使わないが保留

// 数字 → 色絵文字
function numColor(n: number): string {
  if (n === 0) return "🟢";
  return RED_NUMBERS.has(n) ? "🔴" : "⚫";
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

// ─── Spin & resolve ──────────────────────────────────────────────────────────

function spin(): number {
  return Math.floor(Math.random() * 37); // 0〜36
}

interface ResolveResult {
  win: boolean;
  multiplier: number; // 0 = lose, 1 = 1x, 2 = 2x, 35 = 35x
  betDesc: string;
}

// ─── Core handler ─────────────────────────────────────────────────────────────

async function playRoulette(
  interaction: ChatInputCommandInteraction,
  bet: number,
  result: ResolveResult,
): Promise<void> {
  const { guildId } = interaction;
  if (!guildId) return;
  const userId = interaction.user.id;

  const [, { currencyName }] = await Promise.all([
    getOrCreateWallet(guildId, userId),
    getGuildSettings(guildId),
  ]);

  const afterDeduct = await deductBet(guildId, userId, bet);
  if (!afterDeduct) {
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("🎡 ルーレット")
          .setDescription("❌ 残高が不足しています。")
          .setColor(COLOR_LOSE),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // スピン演出のため deferReply
  await interaction.deferReply();

  // ルーレットを回す
  const landed = spin();
  const landedColor = numColor(landed);

  let netDelta: number;
  if (result.win) {
    const winnings = bet * result.multiplier;
    await creditAmount(guildId, userId, bet + winnings);
    netDelta = winnings;
  } else {
    netDelta = -bet;
  }

  if (netDelta !== 0) {
    const reason = `ルーレット ${result.betDesc}（賭け: ${bet}）`;
    await recordTransaction(guildId, userId, netDelta, reason).catch(() => {});
  }

  const sign = netDelta > 0 ? "+" : "";
  const embed = new EmbedBuilder()
    .setTitle(`🎡 ルーレット — ${result.win ? "✅ 勝利！" : "❌ 敗北"}`)
    .setColor(result.win ? COLOR_WIN : COLOR_LOSE)
    .addFields(
      {
        name: "ボールが止まった数字",
        value: `## ${landedColor} **${landed}**`,
      },
      { name: "ベット", value: result.betDesc, inline: true },
      {
        name: "収支",
        value: `${sign}${netDelta.toLocaleString()} ${currencyName}`,
        inline: true,
      },
      ...(result.win ? [{ name: "倍率", value: `${result.multiplier}x`, inline: true }] : []),
    )
    .setFooter({ text: "配当: 数字×35 | 色/奇偶/ロー・ハイ×1 | ダズン×2 | 0は全て外れ" })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

// ─── Subcommand handlers ──────────────────────────────────────────────────────

async function handleNumber(interaction: ChatInputCommandInteraction): Promise<void> {
  const bet    = interaction.options.getInteger("bet", true);
  const target = interaction.options.getInteger("number", true);

  const landed = spin();
  const win = landed === target;
  await playRoulette(interaction, bet, {
    win,
    multiplier: 35,
    betDesc: `ストレートアップ **${target}**（${numColor(target)}）`,
  });
}

async function handleColor(interaction: ChatInputCommandInteraction): Promise<void> {
  const bet   = interaction.options.getInteger("bet", true);
  const color = interaction.options.getString("color", true) as "red" | "black";

  const landed = spin();
  const isRed  = RED_NUMBERS.has(landed);
  const win    = (color === "red" && isRed) || (color === "black" && !isRed && landed !== 0);
  const label  = color === "red" ? "🔴 レッド" : "⚫ ブラック";
  await playRoulette(interaction, bet, { win, multiplier: 1, betDesc: label });
}

async function handleParity(interaction: ChatInputCommandInteraction): Promise<void> {
  const bet    = interaction.options.getInteger("bet", true);
  const parity = interaction.options.getString("parity", true) as "odd" | "even";

  const landed = spin();
  const win    = landed !== 0 && (parity === "odd" ? landed % 2 === 1 : landed % 2 === 0);
  const label  = parity === "odd" ? "🔢 オッド（奇数）" : "🔢 イーブン（偶数）";
  await playRoulette(interaction, bet, { win, multiplier: 1, betDesc: label });
}

async function handleHalf(interaction: ChatInputCommandInteraction): Promise<void> {
  const bet   = interaction.options.getInteger("bet", true);
  const range = interaction.options.getString("range", true) as "low" | "high";

  const landed = spin();
  const win    = landed !== 0 && (range === "low" ? landed <= 18 : landed >= 19);
  const label  = range === "low" ? "📉 ロー（1〜18）" : "📈 ハイ（19〜36）";
  await playRoulette(interaction, bet, { win, multiplier: 1, betDesc: label });
}

async function handleDozen(interaction: ChatInputCommandInteraction): Promise<void> {
  const bet   = interaction.options.getInteger("bet", true);
  const dozen = interaction.options.getInteger("dozen", true) as 1 | 2 | 3;

  const landed  = spin();
  const ranges: Record<1 | 2 | 3, [number, number]> = { 1: [1, 12], 2: [13, 24], 3: [25, 36] };
  const [lo, hi] = ranges[dozen];
  const win      = landed >= lo && landed <= hi;
  const label    = `🎰 ダズン ${dozen}（${lo}〜${hi}）`;
  await playRoulette(interaction, bet, { win, multiplier: 2, betDesc: label });
}

// ─── Command export ───────────────────────────────────────────────────────────

export const rouletteCommand = {
  data: new SlashCommandBuilder()
    .setName("roulette")
    .setDescription("ヨーロピアンルーレット（0〜36）")
    .addSubcommand((sub) =>
      sub
        .setName("number")
        .setDescription("特定の数字（0〜36）に賭ける — 的中で35倍！")
        .addIntegerOption((o) =>
          o.setName("bet").setDescription(`賭け金（${MIN_BET}〜${MAX_BET.toLocaleString()}）`)
            .setMinValue(MIN_BET).setMaxValue(MAX_BET).setRequired(true),
        )
        .addIntegerOption((o) =>
          o.setName("number").setDescription("数字（0〜36）")
            .setMinValue(0).setMaxValue(36).setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("color")
        .setDescription("🔴レッド / ⚫ブラックに賭ける — 的中で1倍（0は外れ）")
        .addIntegerOption((o) =>
          o.setName("bet").setDescription(`賭け金（${MIN_BET}〜${MAX_BET.toLocaleString()}）`)
            .setMinValue(MIN_BET).setMaxValue(MAX_BET).setRequired(true),
        )
        .addStringOption((o) =>
          o.setName("color").setDescription("色を選ぶ").setRequired(true)
            .addChoices(
              { name: "🔴 レッド", value: "red" },
              { name: "⚫ ブラック", value: "black" },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("parity")
        .setDescription("奇数 / 偶数に賭ける — 的中で1倍（0は外れ）")
        .addIntegerOption((o) =>
          o.setName("bet").setDescription(`賭け金（${MIN_BET}〜${MAX_BET.toLocaleString()}）`)
            .setMinValue(MIN_BET).setMaxValue(MAX_BET).setRequired(true),
        )
        .addStringOption((o) =>
          o.setName("parity").setDescription("奇数 / 偶数").setRequired(true)
            .addChoices(
              { name: "🔢 オッド（奇数）", value: "odd" },
              { name: "🔢 イーブン（偶数）", value: "even" },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("half")
        .setDescription("1〜18（ロー）/ 19〜36（ハイ）に賭ける — 的中で1倍（0は外れ）")
        .addIntegerOption((o) =>
          o.setName("bet").setDescription(`賭け金（${MIN_BET}〜${MAX_BET.toLocaleString()}）`)
            .setMinValue(MIN_BET).setMaxValue(MAX_BET).setRequired(true),
        )
        .addStringOption((o) =>
          o.setName("range").setDescription("範囲を選ぶ").setRequired(true)
            .addChoices(
              { name: "📉 ロー（1〜18）", value: "low" },
              { name: "📈 ハイ（19〜36）", value: "high" },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("dozen")
        .setDescription("12個の数字グループに賭ける — 的中で2倍（0は外れ）")
        .addIntegerOption((o) =>
          o.setName("bet").setDescription(`賭け金（${MIN_BET}〜${MAX_BET.toLocaleString()}）`)
            .setMinValue(MIN_BET).setMaxValue(MAX_BET).setRequired(true),
        )
        .addIntegerOption((o) =>
          o.setName("dozen").setDescription("ダズンを選ぶ").setRequired(true)
            .addChoices(
              { name: "1st（1〜12）", value: 1 },
              { name: "2nd（13〜24）", value: 2 },
              { name: "3rd（25〜36）", value: 3 },
            ),
        ),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const sub = interaction.options.getSubcommand();
    if (sub === "number") await handleNumber(interaction);
    else if (sub === "color")  await handleColor(interaction);
    else if (sub === "parity") await handleParity(interaction);
    else if (sub === "half")   await handleHalf(interaction);
    else if (sub === "dozen")  await handleDozen(interaction);
  },
};
