/**
 * /casino — カジノ統計コマンド
 *
 * サブコマンド:
 *   stats [user]   : カジノの勝敗履歴をゲーム別・合計で表示する
 *   wallet         : サーバー内メンバーの保持通貨の中央値・平均値・最大値を表示する（管理者）
 *   average        : 全メンバーの平均収支を1週間・1ヶ月・全期間で表示する（管理者）
 */

import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { and, eq, gte, or, sql } from "drizzle-orm";
import { db, transactionsTable, walletsTable } from "@workspace/db";
import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import { getGuildSettings, setCasinoMaxBet } from "../lib/economy";
import {
  CASINO_GAME_LABELS,
  CASINO_LIMITED_GAMES,
  getCasinoPlayLimits,
  setCasinoPlayLimit,
  type CasinoLimitedGame,
} from "../lib/casinoPlayLimits";

// ─── Constants ────────────────────────────────────────────────────────────────

const COLOR_NEUTRAL = 0x5865f2;

// ─── Types ────────────────────────────────────────────────────────────────────

type GameKey = "blackjack" | "poker" | "roulette" | "slot" | "highlow" | "baccarat";

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
          sql`${transactionsTable.reason} LIKE 'バカラ%'`,
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
    baccarat:  empty(),
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
    else if (row.reason.startsWith("バカラ"))         key = "baccarat";
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

// ─── /casino setup play_limit ─────────────────────────────────────────────────

const PLAY_LIMIT_CHOICES = [
  { name: "🎰 スロット", value: "slot" },
  { name: "🃏 ブラックジャック", value: "blackjack" },
  { name: "🃏 ハイアンドロー", value: "highlow" },
  { name: "🎴 バカラ", value: "baccarat" },
  { name: "🎴 ポーカー", value: "poker" },
  { name: "すべての対象ゲーム", value: "all" },
];

async function handleSetupPlayLimit(interaction: ChatInputCommandInteraction): Promise<void> {
  const { guildId } = interaction;
  if (!guildId) return;
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "❌ 管理者専用です。", flags: MessageFlags.Ephemeral });
    return;
  }

  const selected = interaction.options.getString("game", true);
  const rawLimit = interaction.options.getInteger("limit", true);
  const dailyLimit = rawLimit === 0 ? null : rawLimit;
  const games = selected === "all"
    ? [...CASINO_LIMITED_GAMES]
    : [selected as CasinoLimitedGame];

  await Promise.all(games.map((game) => setCasinoPlayLimit(guildId, game, dailyLimit)));
  const configured = await getCasinoPlayLimits(guildId);
  const configuredByGame = new Map(configured.map((entry) => [entry.game, entry.dailyLimit]));
  const settingText = dailyLimit === null ? "無制限" : `1人あたり **${dailyLimit}回 / 日**`;

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("🎲 カジノ日次プレイ上限")
        .setColor(COLOR_NEUTRAL)
        .setDescription(`**${games.map((game) => CASINO_GAME_LABELS[game]).join("・")}** を ${settingText} に設定しました。`)
        .addFields({
          name: "現在の設定（毎日 0:00 JST リセット）",
          value: CASINO_LIMITED_GAMES
            .map((game) => `${CASINO_GAME_LABELS[game]}: **${configuredByGame.get(game) ?? "無制限"}**`)
            .join("\n"),
        })
        .setFooter({ text: "limit を 0 にすると、そのゲームを無制限に戻せます。" }),
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
    baccarat:  "🎴 バカラ",
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

// ─── /casino average ─────────────────────────────────────────────────────────

interface GameAvgStats {
  userCount: number;
  totalNet:  number;
  avgNet:    number;
}

interface PeriodBreakdown {
  label:  string;
  byGame: Record<GameKey, GameAvgStats>;
  total:  GameAvgStats;
}

const GAME_LABELS_SHORT: Record<GameKey, string> = {
  blackjack: "🃏 BJ",
  poker:     "🎴 ポーカー",
  roulette:  "🎡 ルーレット",
  slot:      "🎰 スロット",
  highlow:   "🃏 ハイロー",
  baccarat:  "🎴 バカラ",
};

/**
 * 指定期間のカジノTXをゲーム別・ユーザー別に集計し、
 * ゲームごとの平均収支と全体平均収支を返す。
 */
async function fetchPeriodBreakdown(
  guildId: string,
  label: string,
  since?: Date,
): Promise<PeriodBreakdown> {
  const conditions = [
    eq(transactionsTable.guildId, guildId),
    or(
      sql`${transactionsTable.reason} LIKE 'BJ%'`,
      sql`${transactionsTable.reason} LIKE 'ポーカー%'`,
      sql`${transactionsTable.reason} LIKE 'ルーレット%'`,
      sql`${transactionsTable.reason} LIKE 'スロット%'`,
      sql`${transactionsTable.reason} LIKE 'ハイアンドロー%'`,
      sql`${transactionsTable.reason} LIKE 'バカラ%'`,
    ),
  ];
  if (since) conditions.push(gte(transactionsTable.createdAt, since));

  const rows = await db
    .select({ userId: transactionsTable.userId, amount: transactionsTable.amount, reason: transactionsTable.reason })
    .from(transactionsTable)
    .where(and(...conditions));

  // ゲーム別: userId → net の Map
  const byGameUser: Record<GameKey, Map<string, number>> = {
    blackjack: new Map(), poker: new Map(), roulette: new Map(),
    slot: new Map(), highlow: new Map(), baccarat: new Map(),
  };
  // 全体: userId → net 合計
  const totalUser = new Map<string, number>();

  for (const row of rows) {
    const bet    = extractBet(row.reason);
    const amount = row.amount;

    let key: GameKey;
    if      (row.reason.startsWith("BJ"))           key = "blackjack";
    else if (row.reason.startsWith("ポーカー"))       key = "poker";
    else if (row.reason.startsWith("ルーレット"))     key = "roulette";
    else if (row.reason.startsWith("スロット"))       key = "slot";
    else if (row.reason.startsWith("ハイアンドロー")) key = "highlow";
    else if (row.reason.startsWith("バカラ"))         key = "baccarat";
    else continue;

    let net: number;
    if (key === "slot") {
      net = amount > 0 ? amount - bet : amount;
    } else if (amount === 0) {
      net = 0; // BJ 引き分け
    } else {
      net = amount;
    }

    const gm = byGameUser[key];
    gm.set(row.userId, (gm.get(row.userId) ?? 0) + net);
    totalUser.set(row.userId, (totalUser.get(row.userId) ?? 0) + net);
  }

  const toStats = (m: Map<string, number>): GameAvgStats => {
    const userCount = m.size;
    const totalNet  = [...m.values()].reduce((s, v) => s + v, 0);
    return { userCount, totalNet, avgNet: userCount > 0 ? Math.round(totalNet / userCount) : 0 };
  };

  return {
    label,
    byGame: {
      blackjack: toStats(byGameUser.blackjack),
      poker:     toStats(byGameUser.poker),
      roulette:  toStats(byGameUser.roulette),
      slot:      toStats(byGameUser.slot),
      highlow:   toStats(byGameUser.highlow),
      baccarat:  toStats(byGameUser.baccarat),
    },
    total: toStats(totalUser),
  };
}

async function handleAverage(interaction: ChatInputCommandInteraction): Promise<void> {
  const { guildId } = interaction;
  if (!guildId) return;

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "❌ 管理者専用です。", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const now         = new Date();
  const oneWeekAgo  = new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000);
  const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [settings, weekResult, monthResult, allResult] = await Promise.all([
    getGuildSettings(guildId),
    fetchPeriodBreakdown(guildId, "直近1週間", oneWeekAgo),
    fetchPeriodBreakdown(guildId, "直近1ヶ月", oneMonthAgo),
    fetchPeriodBreakdown(guildId, "全期間"),
  ]);

  const { currencyName } = settings;

  const fmtNet = (n: number) => {
    const sign = n >= 0 ? "+" : "";
    return `${sign}${n.toLocaleString()} ${currencyName}`;
  };

  const buildFieldValue = (p: PeriodBreakdown): string => {
    if (p.total.userCount === 0) return "データなし";

    const gameLines = (Object.keys(GAME_LABELS_SHORT) as GameKey[])
      .map((key) => {
        const s = p.byGame[key];
        if (s.userCount === 0) return null;
        return `${GAME_LABELS_SHORT[key]}: **${fmtNet(s.avgNet)}** (${s.userCount}人)`;
      })
      .filter(Boolean);

    const totalLine = `📊 合計: **${fmtNet(p.total.avgNet)}** (${p.total.userCount}人)`;
    return [...gameLines, totalLine].join("\n");
  };

  const PERIOD_ICONS: Record<string, string> = {
    "直近1週間": "📅",
    "直近1ヶ月": "📅",
    "全期間":     "🏛️",
  };

  const embed = new EmbedBuilder()
    .setTitle("📊 全メンバー平均収支（ゲーム別）")
    .setColor(COLOR_NEUTRAL)
    .addFields(
      { name: `${PERIOD_ICONS[weekResult.label]}  ${weekResult.label}`,   value: buildFieldValue(weekResult)  },
      { name: `${PERIOD_ICONS[monthResult.label]} ${monthResult.label}`,  value: buildFieldValue(monthResult) },
      { name: `${PERIOD_ICONS[allResult.label]}  ${allResult.label}`,     value: buildFieldValue(allResult)   },
    )
    .setFooter({ text: "平均収支 = 期間内の純損益合計 ÷ そのゲームのプレイ人数" })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

// ─── /casino wallet ───────────────────────────────────────────────────────────

async function handleWalletSummary(interaction: ChatInputCommandInteraction): Promise<void> {
  const { guildId } = interaction;
  if (!guildId) return;

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "❌ 管理者専用です。", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const [settings, rows] = await Promise.all([
    getGuildSettings(guildId),
    db
      .select({ balance: walletsTable.balance })
      .from(walletsTable)
      .where(eq(walletsTable.guildId, guildId)),
  ]);

  const balances = rows.map((r) => r.balance).filter((b) => b > 0);

  if (balances.length === 0) {
    await interaction.editReply({ content: "まだ通貨データがありません。" });
    return;
  }

  balances.sort((a, b) => a - b);

  const count = balances.length;
  const total = balances.reduce((s, v) => s + v, 0);
  const mean  = Math.round(total / count);
  const max   = balances[count - 1]!;
  const min   = balances[0]!;

  // 中央値（奇数: 中央, 偶数: 中央2値の平均）
  const mid    = Math.floor(count / 2);
  const median = count % 2 === 1
    ? balances[mid]!
    : Math.round((balances[mid - 1]! + balances[mid]!) / 2);

  const { currencyName } = settings;
  const fmt = (n: number) => `**${n.toLocaleString()}** ${currencyName}`;

  const embed = new EmbedBuilder()
    .setTitle("💰 サーバー内通貨分布")
    .setColor(COLOR_NEUTRAL)
    .addFields(
      { name: "対象人数",   value: `**${count.toLocaleString()}** 人`, inline: true },
      { name: "合計",       value: fmt(total),                         inline: true },
      { name: "\u200b",     value: "\u200b",                           inline: true },
      { name: "平均値",     value: fmt(mean),                          inline: true },
      { name: "中央値",     value: fmt(median),                        inline: true },
      { name: "最大値",     value: fmt(max),                           inline: true },
      { name: "最小値",     value: fmt(min),                           inline: true },
    )
    .setFooter({ text: "残高 0 のメンバーは除外しています" })
    .setTimestamp();

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
    .addSubcommand((sub) =>
      sub
        .setName("wallet")
        .setDescription("【管理者】サーバー内メンバーの保持通貨の中央値・平均値・最大値を表示する"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("average")
        .setDescription("【管理者】全メンバーの平均収支を1週間・1ヶ月・全期間で表示する"),
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
        )
        .addSubcommand((sub) =>
          sub
            .setName("play_limit")
            .setDescription("ゲームごとの1人あたり日次プレイ上限を設定する")
            .addStringOption((opt) =>
              opt
                .setName("game")
                .setDescription("上限を設定するゲーム")
                .addChoices(...PLAY_LIMIT_CHOICES)
                .setRequired(true),
            )
            .addIntegerOption((opt) =>
              opt
                .setName("limit")
                .setDescription("1人あたりの上限回数。0で無制限")
                .setMinValue(0)
                .setMaxValue(10_000)
                .setRequired(true),
            ),
        ),
    ),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const sub   = interaction.options.getSubcommand();
    const group = interaction.options.getSubcommandGroup(false);
    if (sub === "stats")   { await handleStats(interaction);         return; }
    if (sub === "wallet")  { await handleWalletSummary(interaction);  return; }
    if (sub === "average") { await handleAverage(interaction);        return; }
    if (group === "setup" && sub === "max_bet") { await handleSetupMaxBet(interaction); return; }
    if (group === "setup" && sub === "play_limit") await handleSetupPlayLimit(interaction);
  },
};
