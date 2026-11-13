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
import { resolveCasinoLedgerAmounts } from "../lib/casinoResult";
import { handleDealerCasinoSlash } from "./dealerCasino";

// ─── Constants ────────────────────────────────────────────────────────────────

const COLOR_NEUTRAL = 0x5865f2;

// ─── Types ────────────────────────────────────────────────────────────────────

type GameKey = "blackjack" | "poker" | "roulette" | "slot" | "highlow" | "baccarat" | "chinchiro";

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
 * 全ゲームで賭け金を先に控除し、取引履歴の amount には純利益を記録する。
 * 払い出しは結果画面と同じ符号付き表示に揃える。
 *   - 勝ち: 実際の入金額（賭け金 + 純利益）
 *   - 引き分け: 返却された賭け金
 *   - 負け: マイナスの賭け金
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
          sql`${transactionsTable.reason} LIKE 'チンチロ%'`,
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
    chinchiro:  empty(),
  };

  for (const row of rows) {
    const bet = extractBet(row.reason);
    const amount = row.amount;
    const isWin  = amount > 0;

    let key: GameKey;
    if      (row.reason.startsWith("BJ"))           key = "blackjack";
    else if (row.reason.startsWith("ポーカー"))       key = "poker";
    else if (row.reason.startsWith("ルーレット"))     key = "roulette";
    else if (row.reason.startsWith("スロット"))       key = "slot";
    else if (row.reason.startsWith("ハイアンドロー")) key = "highlow";
    else if (row.reason.startsWith("バカラ"))         key = "baccarat";
    else if (row.reason.startsWith("チンチロ"))       key = "chinchiro";
    else continue;

    const { payout, net } = resolveCasinoLedgerAmounts(key, amount, bet, row.reason);

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
        .setDescription(`**${games.map((game) => CASINO_GAME_LABELS[game]).join("・")}** のその他のロール向け上限を ${settingText} に設定しました。\n**本船員：各ゲーム150回 / 日、新入り・漂流者：各ゲーム100回 / 日** が優先されます。複数所持時は本船員を優先します。`)
        .addFields({
          name: "その他のロール向け設定（毎日 0:00 JST リセット）",
          value: CASINO_LIMITED_GAMES
            .map((game) => `${CASINO_GAME_LABELS[game]}: **${configuredByGame.get(game) ?? "無制限"}**`)
            .join("\n"),
        })
        .setFooter({ text: "limit を 0 にしても、本船員・新入り・漂流者のロール別上限は維持されます。" }),
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
    chinchiro:  "🎲 対人チンチロ",
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
  chinchiro:  "🎲 チンチロ",
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
      sql`${transactionsTable.reason} LIKE 'チンチロ%'`,
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
    chinchiro: new Map(),
  };
  // 全体: userId → net 合計
  const totalUser = new Map<string, number>();

  for (const row of rows) {
    const bet = extractBet(row.reason);
    const amount = row.amount;

    let key: GameKey;
    if      (row.reason.startsWith("BJ"))           key = "blackjack";
    else if (row.reason.startsWith("ポーカー"))       key = "poker";
    else if (row.reason.startsWith("ルーレット"))     key = "roulette";
    else if (row.reason.startsWith("スロット"))       key = "slot";
    else if (row.reason.startsWith("ハイアンドロー")) key = "highlow";
    else if (row.reason.startsWith("バカラ"))         key = "baccarat";
    else if (row.reason.startsWith("チンチロ"))       key = "chinchiro";
    else continue;

    const { net } = resolveCasinoLedgerAmounts(key, amount, bet, row.reason);

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
      chinchiro:  toStats(byGameUser.chinchiro),
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
        )
        .addSubcommand((sub) => sub.setName("dealer_room").setDescription("【管理者】賭博場VCとログ先を指定する")
          .addChannelOption((opt) => opt.setName("vc").setDescription("開催を許可する賭博場VC").addChannelTypes(2).setRequired(true))
          .addChannelOption((opt) => opt.setName("log").setDescription("精算ログを投稿するチャンネル").addChannelTypes(0).setRequired(false)))
        .addSubcommand((sub) => sub.setName("game_vc").setDescription("【管理者】丁半・スリーカードポーカー共通のVCを設定する")
          .addChannelOption((opt) => opt.setName("vc").setDescription("両ゲームを開催するVC").addChannelTypes(2).setRequired(true)))
        .addSubcommand((sub) => sub.setName("dealer_roles").setDescription("【管理者】賭博師・賭博統領ロールを設定する")
          .addRoleOption((opt) => opt.setName("dealer").setDescription("賭博師ロール").setRequired(true))
          .addRoleOption((opt) => opt.setName("leader").setDescription("賭博統領ロール").setRequired(true))
          .addRoleOption((opt) => opt.setName("manager").setDescription("追加の管理者ロール").setRequired(false)))
        .addSubcommand((sub) => sub.setName("dealer_rule").setDescription("【管理者】賭博師ゲームのルールを設定する")
          .addStringOption((opt) => opt.setName("key").setDescription("設定項目").setRequired(true).addChoices(
            { name: "最低掛け金", value: "min_bet" }, { name: "最高掛け金", value: "max_bet" },
            { name: "最大参加人数", value: "max_players" }, { name: "丁半の連勝倍率 (カンマ区切り)", value: "streak_multipliers" },
            { name: "丁半の連勝上限倍率", value: "streak_cap" },
            { name: "連勝維持時間（分）", value: "streak_minutes" },
            { name: "ポーカー通常勝利倍率", value: "poker_base_multiplier" },
            { name: "ポーカー A-2-3 ストレート (on/off)", value: "ace_low_straight" },
            { name: "ポーカーのフォールド待機秒数", value: "poker_timeout" },
            { name: "ポーカー役ボーナス (on/off)", value: "bonus_enabled" },
            { name: "ポーカー役別倍率 (JSON)", value: "bonus_multipliers" },
            { name: "ディーラー最低役 (off/high_card/..)", value: "dealer_qualification" },
            { name: "ゲーム稼働 (on/off)", value: "enabled" },
            { name: "賭博師活動pt換算値", value: "activity_points" },
          ))
          .addStringOption((opt) => opt.setName("value").setDescription("設定値").setRequired(true)))
        .addSubcommand((sub) => sub.setName("dealer_status").setDescription("【管理者】賭博師ゲームの設定を確認する")),
    )
    .addSubcommandGroup((group) => group.setName("chohan").setDescription("賭博師が進行する丁半")
      .addSubcommand((sub) => sub.setName("start").setDescription("丁半の参加受付を開始する")))
    .addSubcommand((sub) => sub.setName("close").setDescription("ポーカーの募集を締め切る"))
    .addSubcommand((sub) => sub.setName("next").setDescription("同じゲームで次の募集を開始する"))
    .addSubcommand((sub) => sub.setName("end").setDescription("賭博場の営業を終了する"))
    .addSubcommand((sub) => sub.setName("cancel").setDescription("未精算のゲームを中止し賭け金を返す"))
    .addSubcommand((sub) => sub.setName("status").setDescription("賭博場の進行状況を確認する")),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const sub   = interaction.options.getSubcommand();
    const group = interaction.options.getSubcommandGroup(false);
    if (sub === "stats")   { await handleStats(interaction);         return; }
    if (sub === "wallet")  { await handleWalletSummary(interaction);  return; }
    if (sub === "average") { await handleAverage(interaction);        return; }
    if (group === "setup" && sub === "max_bet") { await handleSetupMaxBet(interaction); return; }
    if (group === "setup" && sub === "play_limit") { await handleSetupPlayLimit(interaction); return; }
    await handleDealerCasinoSlash(interaction);
  },
};
