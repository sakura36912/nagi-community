/**
 * /casino — カジノ統計コマンド
 *
 * サブコマンド:
 *   stats [user] : カジノの勝敗履歴をゲーム別・合計で表示する
 */

import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { and, eq, or, sql } from "drizzle-orm";
import { db, transactionsTable } from "@workspace/db";
import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import { getGuildSettings, setCasinoMaxBet } from "../lib/economy";

// ─── Constants ────────────────────────────────────────────────────────────────

const COLOR_NEUTRAL = 0x5865f2;

// ─── Types ────────────────────────────────────────────────────────────────────

type GameKey = "blackjack" | "poker" | "roulette" | "slot" | "highlow";

interface GameStats {
  plays:        number;
  wins:         number;
  totalWagered: number;
  totalPayout:  number;
  netDelta:     number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** reason フィールドから賭け金（整数）を取り出す。形式: 「（賭け: 12345）」 */
const BET_REGEX = /（賭け: (\d+)）/;

function extractBet(reason: string): number {
  const m = BET_REGEX.exec(reason);
  return m ? parseInt(m[1]!, 10) : 0;
}

/**
 * ゲーム別集計をトランザクションログから取得する。
 *
 * 【スロットと他ゲームの ledger 差異】
 *   - BJ / ポーカー / ルーレット:
 *       deductBet で賭け金を引き、勝ち時は creditAmount(bet + winnings) で返す。
 *       recordTransaction に記録する amount = winnings（純利益）。
 *       → payout = bet + amount、net = amount
 *   - スロット:
 *       deductBet で賭け金を引き、勝ち時は creditWinnings(bet * multiplier) のみ返す
 *       （元本は別途戻さない）。
 *       recordTransaction に記録する amount = bet * multiplier（総受取額）。
 *       → payout = amount、net = amount - bet
 */
async function fetchCasinoStats(
  guildId: string,
  userId: string,
): Promise<Record<GameKey, GameStats>> {
  const rows = await db
    .select({ amount: transactionsTable.amount, reason: transactionsTable.reason })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.guildId, guildId),
        eq(transactionsTable.userId, userId),
        or(
          sql`${transactionsTable.reason} LIKE 'BJ%'`,
          sql`${transactionsTable.reason} LIKE 'ポーカー%'`,
          sql`${transactionsTable.reason} LIKE 'ルーレット%'`,
          sql`${transactionsTable.reason} LIKE 'スロット%'`,
          sql`${transactionsTable.reason} LIKE 'ハイアンドロー%'`,
        ),
      ),
    );

  const empty = (): GameStats => ({
    plays: 0, wins: 0, totalWagered: 0, totalPayout: 0, netDelta: 0,
  });

  const stats: Record<GameKey, GameStats> = {
    blackjack: empty(),
    poker:     empty(),
    roulette:  empty(),
    slot:      empty(),
    highlow:   empty(),
  };

  for (const row of rows) {
    const bet    = extractBet(row.reason);
    const amount = row.amount;
    const isWin  = amount > 0;

    let key: GameKey;
    if      (row.reason.startsWith("BJ"))           key = "blackjack";
    else if (row.reason.startsWith("ポーカー"))       key = "poker";
    else if (row.reason.startsWith("ルーレット"))     key = "roulette";
    else if (row.reason.startsWith("スロット"))       key = "slot";
    else if (row.reason.startsWith("ハイアンドロー")) key = "highlow";
    else continue;

    // ゲームごとの ledger 仕様の差異を吸収する
    //
    // スロット:
    //   deductBet で賭け金引き、勝ち時 creditWinnings(bet * multiplier) のみ返す。
    //   amount = bet * multiplier（総受取額）
    //   → payout = amount, net = amount - bet
    //
    // BJ / ポーカー / ルーレット:
    //   deductBet で賭け金引き、勝ち時 creditAmount(bet + winnings) を返す。
    //   amount = winnings（純利益）または 0（BJ引き分け）
    //   → 勝ち: payout = bet + amount, net = amount
    //   → 引き分け(amount=0): payout = bet（賭け金が戻る）, net = 0
    //   → 負け: payout = 0, net = amount
    let payout: number;
    let net: number;
    if (key === "slot") {
      payout = isWin ? amount : 0;
      net    = isWin ? amount - bet : amount;
    } else if (amount === 0) {
      // BJ 引き分け: 賭け金が戻り、純損益はゼロ
      payout = bet;
      net    = 0;
    } else {
      payout = isWin ? bet + amount : 0;
      net    = amount;
    }

    const s = stats[key];
    s.plays++;
    if (isWin)      s.wins++;
    s.totalWagered += bet;
    s.totalPayout  += payout;
    s.netDelta     += net;
  }

  return stats;
}

function formatGameStats(s: GameStats, currencyName: string): string {
  if (s.plays === 0) return "データなし";
  const winRate = ((s.wins / s.plays) * 100).toFixed(1);
  const sign    = s.netDelta >= 0 ? "+" : "";
  return [
    `プレイ回数: **${s.plays}**回（勝率 ${winRate}%）`,
    `総賭け金: **${s.totalWagered.toLocaleString()}** ${currencyName}`,
    `総払い戻し: **${s.totalPayout.toLocaleString()}** ${currencyName}`,
    `純損益: **${sign}${s.netDelta.toLocaleString()}** ${currencyName}`,
  ].join("\n");
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const CASINO_DEFAULT_MAX_BET = 100_000;

// ─── /casino setup max_bet ────────────────────────────────────────────────────

async function handleSetupMaxBet(interaction: ChatInputCommandInteraction): Promise<void> {
  const { guildId } = interaction;
  if (!guildId) return;

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "❌ 管理者専用です。", flags: MessageFlags.Ephemeral });
    return;
  }

  const amount = interaction.options.getInteger("amount", true);
  await setCasinoMaxBet(guildId, amount);

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("🎲 カジノ設定")
        .setColor(0x5865f2)
        .addFields({
          name: "賭け金上限",
          value: `**${amount.toLocaleString()}** に設定しました\n（ブラックジャック・ポーカー・ルーレット共通）`,
        })
        .setFooter({ text: "次回ゲームから反映されます" }),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

// ─── /casino stats ────────────────────────────────────────────────────────────

async function handleStats(interaction: ChatInputCommandInteraction): Promise<void> {
  const { guildId } = interaction;
  if (!guildId) return;

  const targetUser = interaction.options.getUser("user") ?? interaction.user;
  const userId     = targetUser.id;

  await interaction.deferReply();

  const [{ currencyName }, stats] = await Promise.all([
    getGuildSettings(guildId),
    fetchCasinoStats(guildId, userId),
  ]);

  // 合計集計
  const totals: GameStats = { plays: 0, wins: 0, totalWagered: 0, totalPayout: 0, netDelta: 0 };
  for (const s of Object.values(stats)) {
    totals.plays        += s.plays;
    totals.wins         += s.wins;
    totals.totalWagered += s.totalWagered;
    totals.totalPayout  += s.totalPayout;
    totals.netDelta     += s.netDelta;
  }

  const GAME_LABELS: Record<GameKey, string> = {
    blackjack: "🃏 ブラックジャック",
    poker:     "🎴 ポーカー",
    roulette:  "🎡 ルーレット",
    slot:      "🎰 スロット",
    highlow:   "🃏 ハイアンドロー",
  };

  const embed = new EmbedBuilder()
    .setTitle(`🎲 カジノ成績 — ${targetUser.displayName}`)
    .setColor(COLOR_NEUTRAL)
    .setThumbnail(targetUser.displayAvatarURL());

  for (const [key, label] of Object.entries(GAME_LABELS) as [GameKey, string][]) {
    embed.addFields({ name: label, value: formatGameStats(stats[key], currencyName) });
  }

  const totalSign    = totals.netDelta >= 0 ? "+" : "";
  const totalWinRate = totals.plays > 0 ? ((totals.wins / totals.plays) * 100).toFixed(1) : "0.0";

  embed.addFields({
    name: "📊 合計",
    value: totals.plays === 0
      ? "まだカジノを利用したことがありません。"
      : [
          `プレイ回数: **${totals.plays}**回（勝率 ${totalWinRate}%）`,
          `総賭け金: **${totals.totalWagered.toLocaleString()}** ${currencyName}`,
          `総払い戻し: **${totals.totalPayout.toLocaleString()}** ${currencyName}`,
          `純損益: **${totalSign}${totals.netDelta.toLocaleString()}** ${currencyName}`,
        ].join("\n"),
  });

  embed.setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

// ─── Command export ───────────────────────────────────────────────────────────

export const casinoCommand = {
  data: new SlashCommandBuilder()
    .setName("casino")
    .setDescription("カジノコマンド")
    .setDefaultMemberPermissions(0)
    .addSubcommand((sub) =>
      sub
        .setName("stats")
        .setDescription("カジノの勝敗履歴をゲーム別・合計で確認する")
        .addUserOption((opt) =>
          opt
            .setName("user")
            .setDescription("確認したいユーザー（省略すると自分）")
            .setRequired(false),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("setup")
        .setDescription("【管理者】カジノの設定を変更する")
        .addSubcommand((sub) =>
          sub
            .setName("max_bet")
            .setDescription("ゲーム共通の賭け金上限を設定する")
            .addIntegerOption((opt) =>
              opt
                .setName("amount")
                .setDescription(`上限額（${CASINO_DEFAULT_MAX_BET.toLocaleString()} 以下）`)
                .setMinValue(100)
                .setMaxValue(CASINO_DEFAULT_MAX_BET)
                .setRequired(true),
            ),
        ),
    ),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const sub   = interaction.options.getSubcommand();
    const group = interaction.options.getSubcommandGroup(false);
    if (sub === "stats") { await handleStats(interaction); return; }
    if (group === "setup" && sub === "max_bet") await handleSetupMaxBet(interaction);
  },
};
