import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { and, eq, sql } from "drizzle-orm";
import { db, walletsTable } from "@workspace/db";
import { getGuildSettings, getOrCreateWallet, recordTransaction } from "../lib/economy";

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_BET = 10;
const MAX_BET = 100_000;

/**
 * Number of distinct symbols per spin.
 * 4 symbols → each payline hits at 6.25%, giving ~28% overall win rate.
 */
const SYMBOL_COUNT = 4;

/** Fallback unicode symbols when the guild has fewer than SYMBOL_COUNT emojis. */
const DEFAULT_SYMBOLS = ["🍒", "🍋", "🍊", "🍇"];

/**
 * Net profit as a multiplier of `bet` for each number of winning paylines.
 * Index = winning paylines (0–5).
 *
 * Estimated return rate ~86% with 4 symbols.
 *
 *   0 lines → lose bet  (-1×)
 *   1 line  → +1× bet
 *   2 lines → +5× bet
 *   3 lines → +11× bet
 *   4 lines → +19× bet
 *   5 lines → +34× bet  (jackpot)
 */
const NET_MULTIPLIER = [-1, 1, 5, 11, 19, 34] as const;

// ─── 5 paylines: 3 horizontal rows + 2 diagonals ─────────────────────────────

/** Each payline is three [row, col] coordinates. */
const PAYLINE_DEFS = [
  { name: "横 上段", coords: [[0, 0], [0, 1], [0, 2]] },
  { name: "横 中段", coords: [[1, 0], [1, 1], [1, 2]] },
  { name: "横 下段", coords: [[2, 0], [2, 1], [2, 2]] },
  { name: "斜め ↘",  coords: [[0, 0], [1, 1], [2, 2]] },
  { name: "斜め ↙",  coords: [[0, 2], [1, 1], [2, 0]] },
] as const;

// ─── Types ────────────────────────────────────────────────────────────────────

type Sym = string; // "<:name:id>" | "<a:name:id>" | unicode
type Row = [Sym, Sym, Sym];
type Grid = [Row, Row, Row];

interface PaylineResult {
  name: string;
  won: boolean;
}

// ─── Symbol selection ─────────────────────────────────────────────────────────

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function pickSymbolPool(interaction: ChatInputCommandInteraction): Sym[] {
  const guild = interaction.guild;
  const custom: Sym[] = guild
    ? [...guild.emojis.cache.values()]
        .filter((e) => !e.managed && !!e.name)
        .map((e) =>
          e.animated ? `<a:${e.name}:${e.id}>` : `<:${e.name}:${e.id}>`,
        )
    : [];

  const pool =
    custom.length >= SYMBOL_COUNT
      ? shuffle(custom)
      : [...custom, ...DEFAULT_SYMBOLS.filter((d) => !custom.includes(d))];

  return pool.slice(0, SYMBOL_COUNT);
}

function pickOne(symbols: Sym[]): Sym {
  return symbols[Math.floor(Math.random() * symbols.length)]!;
}

// ─── Spin & evaluate ──────────────────────────────────────────────────────────

function spinGrid(symbols: Sym[]): Grid {
  const row = (): Row => [pickOne(symbols), pickOne(symbols), pickOne(symbols)];
  return [row(), row(), row()];
}

function evaluatePaylines(grid: Grid): PaylineResult[] {
  return PAYLINE_DEFS.map(({ name, coords }) => {
    const [a, b, c] = coords.map(([r, c]) => grid[r]![c]!);
    return { name, won: a === b && b === c };
  });
}

// ─── Balance helpers ──────────────────────────────────────────────────────────

async function deductBet(
  guildId: string,
  userId: string,
  bet: number,
): Promise<{ balance: number } | null> {
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

async function creditWinnings(
  guildId: string,
  userId: string,
  amount: number,
): Promise<number> {
  const [row] = await db
    .update(walletsTable)
    .set({ balance: sql`${walletsTable.balance} + ${amount}` })
    .where(and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId)))
    .returning({ balance: walletsTable.balance });
  return row?.balance ?? 0;
}

// ─── Display helpers ──────────────────────────────────────────────────────────

const BLANK = "⬛";

function buildSpinningEmbed(bet: number, currencyName: string): EmbedBuilder {
  const blank = `${BLANK}  ${BLANK}  ${BLANK}`;
  return new EmbedBuilder()
    .setTitle("🎰 スロット 3×3")
    .setDescription(`${blank}\n${blank}\n${blank}\n\n*回転中...*`)
    .setColor(0xfaa61a)
    .setFooter({ text: `賭け: ${bet.toLocaleString()} ${currencyName}` });
}

function buildResultEmbed(
  grid: Grid,
  paylines: PaylineResult[],
  wins: number,
  netDelta: number,
  finalBalance: number,
  bet: number,
  currencyName: string,
): EmbedBuilder {
  // ── Grid display ───────────────────────────────────────────────────────────
  // Mark horizontal wins with a trailing ✨ on the row.
  const rowWinNames = new Set(
    paylines
      .filter((p) => p.won && p.name.startsWith("横"))
      .map((p) => p.name),
  );
  const rowLabels = ["横 上段", "横 中段", "横 下段"];
  const gridLines = grid.map((row, i) => {
    const cells = row.join("  ");
    const marker = rowWinNames.has(rowLabels[i]!) ? "  ✨" : "";
    return cells + marker;
  });

  // Diagonal wins shown below grid.
  const diagWins = paylines.filter((p) => p.won && p.name.startsWith("斜め"));
  const diagLine =
    diagWins.length > 0 ? diagWins.map((p) => `✨ ${p.name}`).join("　　") : "";

  const gridBlock = gridLines.join("\n") + (diagLine ? "\n" + diagLine : "");

  // ── Result text ────────────────────────────────────────────────────────────
  let resultText: string;
  let title: string;
  let color: number;

  if (wins === 0) {
    title = "🎰 スロット 3×3 — ハズレ";
    color = 0xed4245;
    resultText = `💸 ハズレ… **-${bet.toLocaleString()} ${currencyName}**`;
  } else {
    const wonNames = paylines.filter((p) => p.won).map((p) => p.name);
    const profit = Math.abs(netDelta);
    resultText =
      `🎊 **${wins}ライン当選！ +${profit.toLocaleString()} ${currencyName}**\n` +
      wonNames.map((n) => `　✨ ${n}`).join("\n");

    if (wins >= 3) {
      title = "🎰 スロット 3×3 — 大当たり！";
      color = 0xf1c40f;
    } else {
      title = "🎰 スロット 3×3 — 当たり！";
      color = 0x57f287;
    }
  }

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(`${gridBlock}\n\n${resultText}`)
    .setColor(color)
    .setFooter({ text: `残高: ${finalBalance.toLocaleString()} ${currencyName}` });
}

// ─── Command definition ───────────────────────────────────────────────────────

interface Command {
  data: { name: string; toJSON: () => unknown };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

export const slotCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("slot")
    .setDescription(
      "3×3スロット 🎰 ｜ 横3・斜め2 の計5ライン ｜ 揃ったライン数で配当",
    )
    .addIntegerOption((opt) =>
      opt
        .setName("bet")
        .setDescription(`賭け金額（${MIN_BET}〜${MAX_BET.toLocaleString()}）`)
        .setRequired(true)
        .setMinValue(MIN_BET)
        .setMaxValue(MAX_BET),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({
        content: "このコマンドはサーバー内でのみ使用できます。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const bet = interaction.options.getInteger("bet", true);
    const { guildId } = interaction;
    const userId = interaction.user.id;

    // Ensure wallet exists, load guild settings.
    const [, { currencyName }] = await Promise.all([
      getOrCreateWallet(guildId, userId),
      getGuildSettings(guildId),
    ]);

    // 1. Show spinning state immediately.
    await interaction.reply({ embeds: [buildSpinningEmbed(bet, currencyName)] });

    // 2. Atomically deduct bet (fails if insufficient balance).
    const afterDeduct = await deductBet(guildId, userId, bet);
    if (!afterDeduct) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("🎰 スロット 3×3")
            .setDescription("❌ 残高が不足しています。")
            .setColor(0xed4245),
        ],
      });
      return;
    }

    // 3. Spin the 3×3 grid and evaluate paylines.
    const symbols = pickSymbolPool(interaction);
    const grid = spinGrid(symbols);
    const paylines = evaluatePaylines(grid);
    const wins = paylines.filter((p) => p.won).length;

    const multiplier = NET_MULTIPLIER[Math.min(wins, 5)]!;
    const netDelta = Math.floor(bet * multiplier);

    // 4. Credit winnings if positive.
    let finalBalance = afterDeduct.balance;
    if (netDelta > 0) {
      finalBalance = await creditWinnings(guildId, userId, netDelta);
    }

    // 5. Record transaction.
    if (netDelta !== 0) {
      await recordTransaction(
        guildId,
        userId,
        netDelta,
        wins > 0
          ? `スロット${wins}ライン当選（賭け: ${bet}）`
          : `スロットハズレ（賭け: ${bet}）`,
      );
    }

    // 6. Brief pause so the spinning animation is visible, then show result.
    await new Promise((res) => setTimeout(res, 1300));

    await interaction.editReply({
      embeds: [
        buildResultEmbed(
          grid,
          paylines,
          wins,
          netDelta,
          finalBalance,
          bet,
          currencyName,
        ),
      ],
    });
  },
};
