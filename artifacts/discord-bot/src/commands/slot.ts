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
const SLOT_SYMBOL_COUNT = 5; // number of distinct symbols per session

// When the guild has fewer than SLOT_SYMBOL_COUNT custom emojis, fill the rest
// with these unicode fallbacks.
const DEFAULT_SYMBOLS = ["🍒", "🍋", "🍊", "🍇", "⭐"];

/**
 * Profit multiplier on the bet for each outcome type.
 *   three → profit = bet × 5   (return bet + 5× profit  = 6× total)
 *   two   → profit = bet × 0.5 (return bet + 0.5× profit = 1.5× total)
 *   none  → profit = -bet      (lose entire bet)
 *
 * Expected return ≈ 96% with 5 equally-weighted symbols.
 */
const PAYOUT_THREE = 5;
const PAYOUT_TWO_FRAC_NUM = 1;
const PAYOUT_TWO_FRAC_DEN = 2;

// ─── Helpers ──────────────────────────────────────────────────────────────────

type Symbol = string; // "<:name:id>", "<a:name:id>", or unicode

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Pick SLOT_SYMBOL_COUNT symbols, preferring the guild's custom emojis. */
function pickSymbols(interaction: ChatInputCommandInteraction): Symbol[] {
  const guild = interaction.guild;
  const custom: Symbol[] = guild
    ? [...guild.emojis.cache.values()]
        .filter((e) => !e.managed && e.name)
        .map((e) =>
          e.animated
            ? `<a:${e.name}:${e.id}>`
            : `<:${e.name}:${e.id}>`,
        )
    : [];

  const pool =
    custom.length >= SLOT_SYMBOL_COUNT
      ? shuffle(custom)
      : [...custom, ...DEFAULT_SYMBOLS.filter((d) => !custom.includes(d))];

  return pool.slice(0, SLOT_SYMBOL_COUNT);
}

function pickReel(symbols: Symbol[]): Symbol {
  return symbols[Math.floor(Math.random() * symbols.length)]!;
}

type Reels = [Symbol, Symbol, Symbol];

function spinReels(symbols: Symbol[]): Reels {
  return [pickReel(symbols), pickReel(symbols), pickReel(symbols)];
}

type Outcome =
  | { kind: "three"; netDelta: number }
  | { kind: "two"; netDelta: number }
  | { kind: "none"; netDelta: number };

function evaluate(reels: Reels, bet: number): Outcome {
  const [a, b, c] = reels;
  if (a === b && b === c) {
    return { kind: "three", netDelta: Math.floor(bet * PAYOUT_THREE) };
  }
  if (a === b || b === c || a === c) {
    return {
      kind: "two",
      netDelta: Math.floor((bet * PAYOUT_TWO_FRAC_NUM) / PAYOUT_TWO_FRAC_DEN),
    };
  }
  return { kind: "none", netDelta: -bet };
}

function reelLine(reels: Reels, spinning = false): string {
  if (spinning) return "⬛ \\| ⬛ \\| ⬛";
  return `${reels[0]} \\| ${reels[1]} \\| ${reels[2]}`;
}

// ─── Balance operations ───────────────────────────────────────────────────────

/**
 * Atomically deduct `bet` from the user's wallet.
 * Returns the updated wallet, or null if the balance was insufficient.
 */
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

/** Add `amount` to the user's wallet (used for winnings). */
async function creditWinnings(
  guildId: string,
  userId: string,
  amount: number,
): Promise<number> {
  const [row] = await db
    .update(walletsTable)
    .set({ balance: sql`${walletsTable.balance} + ${amount}` })
    .where(
      and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId)),
    )
    .returning({ balance: walletsTable.balance });
  return row?.balance ?? 0;
}

// ─── Embed builders ───────────────────────────────────────────────────────────

function buildSpinningEmbed(bet: number, currencyName: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("🎰 スロット")
    .setDescription(`**[ ⬛ | ⬛ | ⬛ ]**\n\n*回転中...*`)
    .setColor(0xfaa61a)
    .setFooter({ text: `賭け: ${bet.toLocaleString()} ${currencyName}` });
}

function buildResultEmbed(
  reels: Reels,
  outcome: Outcome,
  finalBalance: number,
  bet: number,
  currencyName: string,
): EmbedBuilder {
  const line = reelLine(reels);

  let color: number;
  let resultText: string;
  let title: string;

  if (outcome.kind === "three") {
    color = 0xf1c40f;
    title = "🎰 スロット — 大当たり！";
    resultText = `🎊 **3枚揃い！** +${outcome.netDelta.toLocaleString()} ${currencyName}`;
  } else if (outcome.kind === "two") {
    color = 0x57f287;
    title = "🎰 スロット — 当たり！";
    resultText = `✨ **2枚揃い！** +${outcome.netDelta.toLocaleString()} ${currencyName}`;
  } else {
    color = 0xed4245;
    title = "🎰 スロット — ハズレ";
    resultText = `💸 ハズレ… **-${bet.toLocaleString()} ${currencyName}**`;
  }

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(`**[ ${line} ]**\n\n${resultText}`)
    .setColor(color)
    .setFooter({
      text: `残高: ${finalBalance.toLocaleString()} ${currencyName}`,
    });
}

// ─── Command ──────────────────────────────────────────────────────────────────

interface Command {
  data: { name: string; toJSON: () => unknown };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

export const slotCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("slot")
    .setDescription("スロットマシンで賭けをします 🎰")
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
    const guildId = interaction.guildId;
    const userId = interaction.user.id;

    // Ensure wallet exists.
    await getOrCreateWallet(guildId, userId);
    const [guildSettings] = await Promise.all([getGuildSettings(guildId)]);
    const { currencyName } = guildSettings;

    // Show spinning animation first.
    await interaction.reply({
      embeds: [buildSpinningEmbed(bet, currencyName)],
    });

    // Atomically deduct the bet.
    const afterDeduct = await deductBet(guildId, userId, bet);
    if (!afterDeduct) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("🎰 スロット")
            .setDescription("❌ 残高が不足しています。")
            .setColor(0xed4245),
        ],
      });
      return;
    }

    // Spin the reels.
    const symbols = pickSymbols(interaction);
    const reels = spinReels(symbols);
    const outcome = evaluate(reels, bet);

    // Credit winnings if positive.
    let finalBalance = afterDeduct.balance;
    if (outcome.netDelta > 0) {
      finalBalance = await creditWinnings(guildId, userId, outcome.netDelta);
    }

    // Record transaction.
    const txAmount = outcome.netDelta; // negative for loss, positive for win
    if (txAmount !== 0) {
      const reason =
        outcome.kind === "three"
          ? `スロット大当たり（賭け: ${bet}）`
          : outcome.kind === "two"
            ? `スロット当たり（賭け: ${bet}）`
            : `スロットハズレ（賭け: ${bet}）`;
      await recordTransaction(guildId, userId, txAmount, reason);
    }

    // Small delay so the "spinning" embed is visible.
    await new Promise((res) => setTimeout(res, 1200));

    await interaction.editReply({
      embeds: [buildResultEmbed(reels, outcome, finalBalance, bet, currencyName)],
    });
  },
};
