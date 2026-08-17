/**
 * /pachinko — ガルトンボード式パチンコ
 *
 * フロー:
 *   1. /pachinko play bet:<金額>
 *   2. 5段の釘でボールが左右にランダムに弾かれる（ガルトンボード）
 *   3. 0〜5番のポケットに落下 → 倍率に応じて配当
 *
 * 配当（純利益 = bet × multiplier）:
 *   ポケット 0, 5（端）: 8×
 *   ポケット 1, 4      : 1×
 *   ポケット 2, 3（中央）: 0×（betを失う）
 *
 * 期待倍率: (1×8 + 5×1 + 10×0 + 10×0 + 5×1 + 1×8)/32 = 28/32 ≈ 0.875
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
import { CASINO_DEFAULT_MAX_BET } from "./casino";

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_BET = 10;
const MAX_BET = 10_000;
const ROWS = 5; // 5段 → ポケット 6個 (0〜5)

/** ポケット番号 0〜5 の純利益倍率 */
const POCKET_MULTIPLIERS: readonly number[] = [8, 1, 0, 0, 1, 8];

const COLOR_WIN  = 0x57f287;
const COLOR_LOSE = 0xed4245;

// ─── Processing lock ──────────────────────────────────────────────────────────

const processing = new Set<string>();

// ─── Game logic ───────────────────────────────────────────────────────────────

function rollPath(): { moves: ("L" | "R")[]; pocket: number } {
  const moves = Array.from({ length: ROWS }, (): "L" | "R" =>
    Math.random() < 0.5 ? "L" : "R",
  );
  const pocket = moves.filter((m) => m === "R").length;
  return { moves, pocket };
}

// ─── Balance helpers ──────────────────────────────────────────────────────────

async function deductBet(guildId: string, userId: string, bet: number) {
  const [row] = await db
    .update(walletsTable)
    .set({ balance: sql`${walletsTable.balance} - ${bet}` })
    .where(
      and(
        eq(walletsTable.guildId, guildId),
        eq(walletsTable.userId, userId),
        sql`${walletsTable.balance} >= ${bet}`,
      ),
    )
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

// ─── Display helpers ──────────────────────────────────────────────────────────

/** 釘板の各段で弾かれた方向を表示 */
function buildPathDisplay(moves: ("L" | "R")[]): string {
  return moves
    .map((m, i) => `${i + 1}段目: ${m === "L" ? "↙" : "↘"}`)
    .join("\n");
}

/** 全ポケットを並べて当選ポケットをハイライト */
function buildPocketRow(pocket: number): string {
  return POCKET_MULTIPLIERS.map((multi, i) => {
    const label = `${multi}×`;
    return i === pocket ? `**[${label}]**` : `\`${label}\``;
  }).join("  ");
}

/** ポケット番号の行（どこに落ちたか視覚的に） */
function buildPocketIndex(pocket: number): string {
  return POCKET_MULTIPLIERS.map((_, i) =>
    i === pocket ? `**[${i}]**` : `\`${i}\``,
  ).join("  ");
}

// ─── Embed builder ────────────────────────────────────────────────────────────

function buildResultEmbed(
  moves: ("L" | "R")[],
  pocket: number,
  bet: number,
  netDelta: number,
  finalBalance: number,
  currencyName: string,
): EmbedBuilder {
  const multiplier = POCKET_MULTIPLIERS[pocket]!;
  const resultLabel =
    multiplier === 0
      ? "💥 ハズレ"
      : multiplier >= 8
        ? "🎉 大当たり！"
        : "✅ 当たり";

  const deltaStr =
    (netDelta >= 0 ? "+" : "") + netDelta.toLocaleString() + " " + currencyName;

  return new EmbedBuilder()
    .setTitle("🎰 パチンコ")
    .setColor(netDelta >= 0 ? COLOR_WIN : COLOR_LOSE)
    .setDescription(
      [
        "```",
        "     ●",
        "   ↙   ↘",
        "  ●       ●",
        " ↙ ↘   ↙ ↘",
        "●   ●   ●   ●",
        "```",
      ].join("\n"),
    )
    .addFields(
      {
        name: "ボールの軌跡",
        value: buildPathDisplay(moves),
        inline: false,
      },
      {
        name: "ポケット（倍率）",
        value: buildPocketRow(pocket),
        inline: false,
      },
      {
        name: "落下位置",
        value: buildPocketIndex(pocket),
        inline: false,
      },
      {
        name: "結果",
        value: `${resultLabel}　ポケット **${pocket}**（${multiplier}×）`,
        inline: true,
      },
      {
        name: "損益",
        value: deltaStr,
        inline: true,
      },
      {
        name: "残高",
        value: `**${finalBalance.toLocaleString()}** ${currencyName}`,
        inline: true,
      },
    );
}

// ─── Handler ──────────────────────────────────────────────────────────────────

async function handlePlay(interaction: ChatInputCommandInteraction): Promise<void> {
  const { guild, user } = interaction;
  if (!guild) return;
  const guildId = guild.id;
  const userId  = user.id;
  const key     = `${guildId}:${userId}`;

  if (processing.has(key)) {
    await interaction.reply({
      content: "⏳ 処理中です。少し待ってから再試行してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const bet = interaction.options.getInteger("bet", true);

  const [settings] = await Promise.all([
    getGuildSettings(guildId),
    getOrCreateWallet(guildId, userId),
  ]);

  const maxBet       = settings.casinoMaxBet ?? CASINO_DEFAULT_MAX_BET;
  const currencyName = settings.currencyName ?? "コイン";

  if (bet < MIN_BET) {
    await interaction.reply({
      content: `❌ 最低賭け金は **${MIN_BET.toLocaleString()}** ${currencyName} です。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (bet > maxBet) {
    await interaction.reply({
      content: `❌ 賭け金が上限（**${maxBet.toLocaleString()}** ${currencyName}）を超えています。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  processing.add(key);
  try {
    await interaction.deferReply();

    const afterDeduct = await deductBet(guildId, userId, bet);
    if (!afterDeduct) {
      await interaction.editReply("❌ 残高が不足しています。");
      return;
    }

    const { moves, pocket } = rollPath();
    const multiplier = POCKET_MULTIPLIERS[pocket]!;
    const netDelta   = multiplier === 0 ? -bet : bet * multiplier;

    let finalBalance: number;
    if (netDelta > 0) {
      finalBalance = await creditAmount(guildId, userId, netDelta);
    } else {
      finalBalance = afterDeduct.balance;
    }

    const reason =
      netDelta > 0
        ? `パチンコ当選（ポケット${pocket}・賭け: ${bet}）`
        : `パチンコ外れ（賭け: ${bet}）`;
    await recordTransaction(guildId, userId, netDelta, reason);

    // 演出用待機
    await new Promise<void>((res) => setTimeout(res, 1200));

    const embed = buildResultEmbed(moves, pocket, bet, netDelta, finalBalance, currencyName);
    await interaction.editReply({ embeds: [embed] });
  } finally {
    processing.delete(key);
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const pachinkoCommand = {
  data: new SlashCommandBuilder()
    .setName("pachinko")
    .setDescription("🎰 パチンコ — ガルトンボードでボールを転がして配当を狙え！")
    .setDefaultMemberPermissions(null)
    .addSubcommand((sub) =>
      sub
        .setName("play")
        .setDescription("パチンコをプレイする")
        .addIntegerOption((opt) =>
          opt
            .setName("bet")
            .setDescription(`賭け金（${MIN_BET}〜${MAX_BET.toLocaleString()}）`)
            .setMinValue(MIN_BET)
            .setMaxValue(MAX_BET)
            .setRequired(true),
        ),
    ),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const sub = interaction.options.getSubcommand();
    if (sub === "play") await handlePlay(interaction);
  },
};
