import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Guild,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StickerFormatType,
  TextChannel,
  ChannelType,
} from "discord.js";
import { and, eq, sql } from "drizzle-orm";
import { db, walletsTable } from "@workspace/db";
import { getGuildSettings, getOrCreateWallet, recordTransaction } from "../lib/economy";
import {
  addCasinoRound,
  buildCasinoResultFields,
  emptyCasinoResultTotals,
  type CasinoResultTotals,
} from "../lib/casinoResult";
import { dailyLimitReachedMessage, tryStartCasinoPlay } from "../lib/casinoPlayLimits";
import {
  getSlotSettings,
  addSlotSticker,
  removeSlotSticker,
  clearSlotStickers,
  addSlotEmoji,
  removeSlotEmoji,
  clearSlotEmojis,
  setSlotEmojiWeight,
  setSlotPayout,
  setSlotWinRate,
  setSlotJackpotChannel,
  resolveMultipliers,
  DEFAULT_MULTIPLIERS,
} from "../lib/slot";

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_BET = 1000;
const MAX_BET = 10_000;
const SYMBOL_COUNT = 4;
const DEFAULT_SYMBOLS = ["🍒", "🍋", "🍊", "🍇"];

export const SLOT_REPLAY_PREFIX = "slot:replay:";
export const SLOT_QUIT_PREFIX   = "slot:quit:";
export const SLOT_WIN_RATE_PREFIX = "slot:win-rate:";

// ─── Session tracking ─────────────────────────────────────────────────────────

interface SlotSession {
  totals: CasinoResultTotals;
  currencyName: string;
}

const activeSessions = new Map<string, SlotSession>();
const processingReplays = new Set<string>();

function sessionKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

// ─── Paylines: 3 horizontal rows + 2 diagonals ───────────────────────────────

const PAYLINE_DEFS = [
  { name: "横 上段", coords: [[0, 0], [0, 1], [0, 2]] },
  { name: "横 中段", coords: [[1, 0], [1, 1], [1, 2]] },
  { name: "横 下段", coords: [[2, 0], [2, 1], [2, 2]] },
  { name: "斜め ↘",  coords: [[0, 0], [1, 1], [2, 2]] },
  { name: "斜め ↙",  coords: [[0, 2], [1, 1], [2, 0]] },
] as const;

// ─── Types ────────────────────────────────────────────────────────────────────

type Sym = string;
type Row = [Sym, Sym, Sym];
type Grid = [Row, Row, Row];
interface PaylineResult { name: string; won: boolean }
import { AutocompleteInteraction } from "discord.js";

interface Command {
  data: { name: string; toJSON: () => unknown };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
}

// ─── Emoji utilities ──────────────────────────────────────────────────────────

function parseEmojiId(input: string): string | null {
  return input.trim().match(/<a?:[^:]+:(\d+)>/)?.[1] ?? null;
}

function resolveEmoji(guild: Guild, emojiId: string): Sym | null {
  const e = guild.emojis.cache.get(emojiId);
  if (!e?.name) return null;
  return e.animated ? `<a:${e.name}:${e.id}>` : `<:${e.name}:${e.id}>`;
}

function extractEmojiId(sym: Sym): string | null {
  return sym.match(/<a?:[^:]+:(\d+)>/)?.[1] ?? null;
}

/** カスタム絵文字の CDN 画像 URL を返す。通常絵文字の場合は null。 */
function emojiCdnUrl(sym: Sym): string | null {
  const id = extractEmojiId(sym);
  if (!id) return null;
  const animated = sym.startsWith("<a:");
  return `https://cdn.discordapp.com/emojis/${id}.${animated ? "gif" : "webp"}?size=256`;
}

// ─── Sticker utilities ────────────────────────────────────────────────────────

interface StickerInfo { name: string; animated: boolean }

/** スティッカーの CDN 画像 URL を返す。 */
function stickerCdnUrl(id: string, animated: boolean): string {
  return `https://cdn.discordapp.com/stickers/${id}.${animated ? "gif" : "png"}?size=512`;
}

/** sym が sticker ID（純数字）かどうか判定。 */
function isStickerSym(sym: Sym): boolean {
  return /^\d+$/.test(sym);
}

/** sym の表示文字列を返す。スティッカーは「🎴」統一、絵文字はそのまま表示。 */
function displaySym(sym: Sym, meta: Map<string, StickerInfo>): string {
  if (isStickerSym(sym)) return "🎴";
  // 絵文字はそのまま（Discord がインライン画像としてレンダリング）
  return sym;
}

/** sym に対応する大きな画像 URL を返す（embed の setImage/setThumbnail 用）。 */
function featuredImageUrl(sym: Sym, meta: Map<string, StickerInfo>): string | null {
  if (isStickerSym(sym)) {
    const info = meta.get(sym);
    return info ? stickerCdnUrl(sym, info.animated) : null;
  }
  return emojiCdnUrl(sym);
}

// ─── Symbol pool & weighted random ───────────────────────────────────────────

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Expand each symbol according to its weight to form the reel pool. */
function buildWeightedPool(
  symbols: Sym[],
  weights: Record<string, number>,
): Sym[] {
  const pool: Sym[] = [];
  for (const sym of symbols) {
    // Sticker mode: sym IS the sticker ID. Emoji mode: extract ID from string.
    const key = isStickerSym(sym) ? sym : (extractEmojiId(sym) ?? sym);
    const w = Math.max(1, weights[key] ?? 1);
    for (let i = 0; i < w; i++) pool.push(sym);
  }
  return pool;
}

function pickOne(pool: Sym[]): Sym {
  return pool[Math.floor(Math.random() * pool.length)]!;
}

async function pickSymbolPool(
  guild: Guild,
): Promise<{
  symbols: Sym[];
  weights: Record<string, number>;
  meta: Map<string, StickerInfo>;
  mode: "sticker" | "fixed" | "auto";
}> {
  const settings = await getSlotSettings(guild.id);
  const weights = settings.emojiWeights ?? {};
  const meta = new Map<string, StickerInfo>();

  // ── Sticker mode (priority) ──────────────────────────────────────────────
  if (settings.stickerIds.length >= 2) {
    // Fetch sticker cache; populate meta map.
    const stickers = guild.stickers.cache.size > 0
      ? guild.stickers.cache
      : await guild.stickers.fetch().catch(() => guild.stickers.cache);

    const valid = settings.stickerIds.filter((id) => stickers.has(id));
    if (valid.length >= 2) {
      for (const id of valid) {
        const s = stickers.get(id)!;
        meta.set(id, {
          name: s.name,
          animated: s.format === StickerFormatType.APNG || s.format === StickerFormatType.GIF,
        });
      }
      return { symbols: valid, weights, meta, mode: "sticker" };
    }
  }

  // ── Emoji fixed mode ─────────────────────────────────────────────────────
  if (settings.fixedEmojiIds.length > 0) {
    // キャッシュにない絵文字は個別に fetch してキャッシュを補完する
    const uncachedIds = settings.fixedEmojiIds.filter((id) => !guild.emojis.cache.has(id));
    if (uncachedIds.length > 0) {
      await Promise.all(uncachedIds.map((id) => guild.emojis.fetch(id).catch(() => null)));
    }

    const resolved = settings.fixedEmojiIds
      .map((id) => resolveEmoji(guild, id))
      .filter((s): s is Sym => s !== null);

    if (resolved.length >= 2) {
      // 固定絵文字モードは登録数をそのまま使う（上限カットなし）
      // 2 未満のときだけデフォルト絵文字で補完
      const padded =
        resolved.length < 2
          ? [...resolved, ...DEFAULT_SYMBOLS.slice(0, 2 - resolved.length)]
          : resolved;
      return { symbols: padded, weights, meta, mode: "fixed" };
    }
  }

  // ── Auto mode: all guild custom emojis ───────────────────────────────────
  const symbols = getAutomaticSymbols(guild);
  return { symbols: shuffle(symbols).slice(0, SYMBOL_COUNT), weights, meta, mode: "auto" };
}

/** オート絵柄モードで候補になる絵柄全体を返す。 */
function getAutomaticSymbols(guild: Guild): Sym[] {
  const custom: Sym[] = [...guild.emojis.cache.values()]
    .filter((e) => !e.managed && !!e.name)
    .map((e) => (e.animated ? `<a:${e.name}:${e.id}>` : `<:${e.name}:${e.id}>`));

  return custom.length >= SYMBOL_COUNT
    ? custom
    : [...custom, ...DEFAULT_SYMBOLS.filter((d) => !custom.includes(d))];
}

// ─── Spin & evaluate ──────────────────────────────────────────────────────────

function spinGrid(pool: Sym[]): Grid {
  const row = (): Row => [pickOne(pool), pickOne(pool), pickOne(pool)];
  return [row(), row(), row()];
}

export function evaluatePaylines(grid: Grid): PaylineResult[] {
  return PAYLINE_DEFS.map(({ name, coords }) => {
    const [a, b, c] = coords.map(([r, c]) => grid[r]![c]!);
    return { name, won: a === b && b === c };
  });
}

/**
 * 当選率が設定されているときは、少なくとも1ライン当選する確率を制御する。
 * 当たり・外れそれぞれでは元の絵柄重みに従うため、既存の配当設定はそのまま使われる。
 */
export function spinGridWithWinRate(pool: Sym[], winRate: number | null): Grid {
  if (winRate === null) return spinGrid(pool);

  const targetWin = Math.random() < winRate / 100;
  for (let attempt = 0; attempt < 250; attempt++) {
    const grid = spinGrid(pool);
    const won = evaluatePaylines(grid).some((line) => line.won);
    if (won === targetWin) return grid;
  }

  // 極端な重み設定でも選択された結果を守るための安全な最終手段。
  const symbols = [...new Set(pool)];
  if (targetWin) {
    const sym = pool[0]!;
    const grid = spinGrid(pool);
    grid[0] = [sym, sym, sym];
    return grid;
  }
  if (symbols.length >= 2) {
    const [a, b] = symbols;
    return [
      [a!, b!, a!],
      [b!, a!, b!],
      [b!, a!, b!],
    ];
  }
  return spinGrid(pool);
}

// ─── Balance helpers ──────────────────────────────────────────────────────────

async function deductBet(
  guildId: string, userId: string, bet: number,
): Promise<{ balance: number } | null> {
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

async function creditWinnings(
  guildId: string, userId: string, amount: number,
): Promise<number> {
  const [row] = await db
    .update(walletsTable)
    .set({ balance: sql`${walletsTable.balance} + ${amount}` })
    .where(and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId)))
    .returning({ balance: walletsTable.balance });
  return row?.balance ?? 0;
}

// ─── Embeds ───────────────────────────────────────────────────────────────────

const BLANK = "⬛";

function buildSpinningEmbed(bet: number, currencyName: string): EmbedBuilder {
  const b = `${BLANK}　　　　${BLANK}　　　　${BLANK}`;
  return new EmbedBuilder()
    .setTitle("🎰 スロット 3×3")
    .setDescription(`${b}\n\n${b}\n\n${b}\n\n*回転中...*`)
    .setColor(0xfaa61a)
    .setFooter({ text: `賭け: ${bet.toLocaleString()} ${currencyName}` });
}

function buildResult(
  grid: Grid,
  paylines: PaylineResult[],
  wins: number,
  netDelta: number,
  finalBalance: number,
  bet: number,
  currencyName: string,
  meta: Map<string, StickerInfo>,
  totals: CasinoResultTotals,
): { content: string; embed: EmbedBuilder } {
  const rowWins = new Set(
    paylines.filter((p) => p.won && p.name.startsWith("横")).map((p) => p.name),
  );
  const rowLabels = ["横 上段", "横 中段", "横 下段"];

  // グリッドを content に（絵文字のみ → Discord がジャンボ表示）
  const gridLines = grid.map((row) => row.map((s) => displaySym(s, meta)).join(" "));
  const content = gridLines.join("\n");

  const diagWins = paylines.filter((p) => p.won && p.name.startsWith("斜め"));

  let resultText: string;
  let title: string;
  let color: number;

  if (wins === 0) {
    title = "🎰 スロット 3×3 — ハズレ";
    color = 0xed4245;
    resultText = `❌ ハズレ… **-${bet.toLocaleString()} ${currencyName}**`;
  } else {
    const wonNames = paylines.filter((p) => p.won).map((p) => p.name);
    const profit = Math.abs(netDelta);
    // 当選ライン（横・斜め）を embed に表示
    const rowWinLines = wonNames.filter((n) => n.startsWith("横")).map((n) => {
      const i = rowLabels.indexOf(n);
      return i >= 0 ? `${n}（${["上", "中", "下"][i]}段）` : n;
    });
    const diagWinLines = diagWins.map((p) => p.name);
    const winLines = [...rowWinLines, ...diagWinLines].map((n) => `　✨ ${n}`).join("\n");
    resultText =
      `**${wins}ライン当選！ +${profit.toLocaleString()} ${currencyName}**\n` + winLines;
    title = wins >= 3 ? "🎰 スロット 3×3 — 大当たり！" : "🎰 スロット 3×3 — 当たり！";
    color = wins >= 3 ? 0xf1c40f : 0x57f287;
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(resultText)
    .setColor(color)
    .addFields(...buildCasinoResultFields(totals, currencyName));

  return { content, embed };
}

function buildSetupEmbed(
  guild: Guild,
  settings: { stickerIds: string[]; fixedEmojiIds: string[]; emojiWeights: Record<string, number>; payoutMultipliers: number[] },
): EmbedBuilder {
  const { stickerIds, fixedEmojiIds, emojiWeights, payoutMultipliers } = settings;
  const multipliers = resolveMultipliers(payoutMultipliers);

  // ── Sticker mode ──────────────────────────────────────────────────────────
  const useStickerMode = stickerIds.length > 0;
  const mode = useStickerMode ? "🎴 スタンプ固定" : fixedEmojiIds.length === 0 ? "🔄 自動（絵文字）" : "📌 絵文字固定";
  const symbolCount = useStickerMode ? stickerIds.length : fixedEmojiIds.length || "自動";

  let symbolsValue: string;
  if (useStickerMode) {
    const stickers = guild.stickers.cache;
    symbolsValue = stickerIds.map((id) => {
      const s = stickers.get(id);
      const w = emojiWeights[id] ?? 1;
      const bar = "█".repeat(Math.min(w, 10)) + (w > 10 ? `…${w}` : "");
      return s ? `🎴 **${s.name}** \`${bar}\` ×${w}` : `*(削除済み: ${id})* \`${bar}\` ×${w}`;
    }).join("\n");
  } else if (fixedEmojiIds.length === 0) {
    symbolsValue = "*未登録（自動モード）*";
  } else {
    symbolsValue = fixedEmojiIds.map((id) => {
      const sym = resolveEmoji(guild, id);
      const w = emojiWeights[id] ?? 1;
      const bar = "█".repeat(Math.min(w, 10)) + (w > 10 ? `…${w}` : "");
      return sym ? `${sym} \`${bar}\` ×${w}` : `*(削除済み: ${id})*`;
    }).join("\n");
  }

  // Payout table.
  const payoutLines = [1, 2, 3, 4, 5].map((n) => {
    const m = multipliers[n] ?? DEFAULT_MULTIPLIERS[n];
    const label = n === 5 ? `${n}ライン 🎰` : `${n}ライン`;
    return `\`${label}\` → +${m}× bet`;
  });
  payoutLines.unshift("`0ライン` → -1× bet（固定）");

  const activeIds = useStickerMode ? stickerIds : fixedEmojiIds;
  const totalWeight = activeIds.reduce((sum, id) => sum + (emojiWeights[id] ?? 1), 0);
  const probLines = activeIds.length > 0
    ? activeIds.map((id) => {
        const w = emojiWeights[id] ?? 1;
        const pct = totalWeight > 0 ? ((w / totalWeight) * 100).toFixed(1) : "0.0";
        if (useStickerMode) {
          const s = guild.stickers.cache.get(id);
          return s ? `🎴${s.name} ${pct}%` : `*(削除済み)* ${pct}%`;
        }
        const sym = resolveEmoji(guild, id);
        return sym ? `${sym} ${pct}%` : `*(削除済み)* ${pct}%`;
      }).join("  ")
    : "*固定モードでのみ表示*";

  return new EmbedBuilder()
    .setTitle("🎰 スロット — 設定")
    .setColor(0x5865f2)
    .addFields(
      { name: "モード", value: mode, inline: true },
      { name: "絵柄数", value: `${symbolCount} 種類`, inline: true },
      { name: "\u200b", value: "\u200b", inline: true },
      { name: "絵柄と出現重み", value: symbolsValue || "*なし*" },
      { name: "各絵柄の出現確率", value: probLines },
      { name: "当選配当", value: payoutLines.join("\n") },
    )
    .setFooter({ text: "weight: 出現重み（高いほど出やすい）| bet × multiplier が利益" });
}

function buildWinRateButtons(
  guildId: string,
  selectedRate: number | null,
): ActionRowBuilder<ButtonBuilder>[] {
  const rates = [5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const rateButtons = rates.map((rate) =>
    new ButtonBuilder()
      .setCustomId(`${SLOT_WIN_RATE_PREFIX}${guildId}:${rate}`)
      .setLabel(`${rate}%`)
      .setStyle(selectedRate === rate ? ButtonStyle.Success : ButtonStyle.Secondary),
  );
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(rateButtons.slice(0, 5)),
    new ActionRowBuilder<ButtonBuilder>().addComponents(rateButtons.slice(5, 10)),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...rateButtons.slice(10),
      new ButtonBuilder()
        .setCustomId(`${SLOT_WIN_RATE_PREFIX}${guildId}:reset`)
        .setLabel("従来方式に戻す")
        .setStyle(selectedRate === null ? ButtonStyle.Primary : ButtonStyle.Secondary),
    ),
  ];
}

/** 設定済みの絵柄重み・配当から、払い戻し率（賭け金返却分を含む）を推定する。 */
async function estimatePayoutRate(
  guild: Guild,
  multipliers: number[],
  configuredWinRate: number | null,
): Promise<number> {
  const samples = 5_000;
  const selected = await pickSymbolPool(guild);
  const automaticSymbols = selected.mode === "auto" ? getAutomaticSymbols(guild) : null;
  const fixedPool = buildWeightedPool(selected.symbols, selected.weights);
  let totalPayout = 0;
  let winningPayout = 0;
  let winningCount = 0;

  for (let i = 0; i < samples; i++) {
    // オート絵柄モードは実際の各スピンと同様、候補から4種類を新たに選ぶ。
    const pool = automaticSymbols
      ? buildWeightedPool(shuffle(automaticSymbols).slice(0, SYMBOL_COUNT), selected.weights)
      : fixedPool;
    const wins = evaluatePaylines(spinGrid(pool)).filter((line) => line.won).length;
    const payout = wins > 0 ? 1 + (multipliers[Math.min(wins, 5)] ?? 0) : 0;
    totalPayout += payout;
    if (wins > 0) {
      winningPayout += payout;
      winningCount++;
    }
  }

  if (configuredWinRate === null) return (totalPayout / samples) * 100;
  if (winningCount === 0) return 0;
  return (configuredWinRate / 100) * (winningPayout / winningCount) * 100;
}

async function buildWinRateSetupEmbed(
  guild: Guild,
  settings: Awaited<ReturnType<typeof getSlotSettings>>,
): Promise<EmbedBuilder> {
  const multipliers = resolveMultipliers(settings.payoutMultipliers);
  const payoutRate = await estimatePayoutRate(guild, multipliers, settings.winRate);
  const winRateText = settings.winRate === null
    ? "従来方式（絵柄の出現重みから決定）"
    : `**${settings.winRate}%**`;

  return new EmbedBuilder()
    .setTitle("🎰 スロット — 当選確率設定")
    .setColor(0x5865f2)
    .addFields(
      { name: "当選確率", value: winRateText, inline: true },
      { name: "推定払い戻し率", value: `**${payoutRate.toFixed(1)}%**`, inline: true },
      { name: "\u200b", value: "\u200b", inline: true },
      {
        name: "計算方法",
        value: "払い戻し率は、現在の絵柄重み・配当倍率と選択中の当選確率から算出した推定値です。賭け金の返却分を含みます。",
      },
    )
    .setFooter({ text: "ボタンを押すと、次回スピンから当選確率が反映されます。" });
}

// ─── Button rows & session summary ───────────────────────────────────────────

function buildActionRow(userId: string, bet: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${SLOT_REPLAY_PREFIX}${userId}:${bet}`)
      .setLabel("もう一度")
      .setEmoji("🎰")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${SLOT_QUIT_PREFIX}${userId}:${bet}`)
      .setLabel("終了")
      .setStyle(ButtonStyle.Secondary),
  );
}

function buildSessionSummaryEmbed(
  totals: CasinoResultTotals,
  currencyName: string,
): EmbedBuilder {
  const color = totals.totalNet > 0 ? 0x57f287 : totals.totalNet < 0 ? 0xed4245 : 0x99aab5;
  return new EmbedBuilder()
    .setTitle("🎰 スロット — セッション終了")
    .setColor(color)
    .addFields(
      ...buildCasinoResultFields(totals, currencyName),
      { name: "プレイ回数", value: `${totals.games} 回`, inline: true },
    );
}

// ─── Shared spin core ─────────────────────────────────────────────────────────

/**
 * ベット控除 → スピン → 結果表示。
 * スラッシュコマンドとボタンリプレイの両方から呼ばれる。
 * 呼び出し元が reply / update を済ませた後に呼ぶこと。
 */
async function spinAndReply(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  bet: number,
): Promise<void> {
  const { guildId } = interaction;
  if (!guildId || !interaction.guild) return;
  const userId = interaction.user.id;
  const key = sessionKey(guildId, userId);

  const [, { currencyName }, slotSettings] = await Promise.all([
    getOrCreateWallet(guildId, userId),
    getGuildSettings(guildId),
    getSlotSettings(guildId),
  ]);

  // セッションがなければ新規作成（スラッシュコマンド初回）
  if (!activeSessions.has(key)) {
    activeSessions.set(key, { totals: emptyCasinoResultTotals(), currencyName });
  }

  const playStart = await tryStartCasinoPlay(guildId, userId, "slot", bet);
  if (!playStart.ok && playStart.reason === "daily_limit_reached") {
    activeSessions.delete(key);
    await interaction.editReply({
      content: dailyLimitReachedMessage("slot", playStart.limit),
      embeds: [],
      components: [],
    });
    return;
  }
  if (!playStart.ok) {
    // 残高不足 → セッション終了してサマリー表示
    const session = activeSessions.get(key);
    activeSessions.delete(key);
    const embeds: EmbedBuilder[] = [
      new EmbedBuilder()
        .setTitle("🎰 スロット 3×3")
        .setDescription("❌ 残高が不足しています。")
        .setColor(0xed4245),
    ];
    if (session && session.totals.games > 0) {
      embeds.push(buildSessionSummaryEmbed(session.totals, session.currencyName));
    }
    await interaction.editReply({ content: "", embeds, components: [] });
    return;
  }
  const afterDeduct = { balance: playStart.balance };

  const { symbols, weights, meta } = await pickSymbolPool(interaction.guild);
  const pool = buildWeightedPool(symbols, weights);
  const grid = spinGridWithWinRate(pool, slotSettings.winRate);
  const paylines = evaluatePaylines(grid);
  const wins = paylines.filter((p) => p.won).length;

  const multipliers = resolveMultipliers(slotSettings.payoutMultipliers);
  const multiplier = multipliers[Math.min(wins, 5)] ?? -1;
  const profit = wins > 0 ? Math.max(0, Math.floor(bet * multiplier)) : 0;
  const payout = profit > 0 ? bet + profit : 0;
  const netDelta = payout - bet;

  let finalBalance = afterDeduct.balance;
  if (payout > 0) {
    finalBalance = await creditWinnings(guildId, userId, payout);
  }

  if (netDelta !== 0) {
    await recordTransaction(
      guildId, userId, netDelta,
      wins > 0
        ? `スロット${wins}ライン当選（賭け: ${bet}）`
        : `スロットハズレ（賭け: ${bet}）`,
    );
  }

  // セッション累計を更新
  const session = activeSessions.get(key)!;
  session.totals = addCasinoRound(session.totals, bet, payout);

  const { content, embed } = buildResult(
    grid, paylines, wins, netDelta, finalBalance, bet, currencyName, meta, session.totals,
  );
  await interaction.editReply({
    content,
    embeds: [embed],
    components: [buildActionRow(userId, bet)],
  });

  // ─── ジャックポット（5ライン全当選）通知 ─────────────────────────────────
  if (wins === 5 && slotSettings.jackpotChannelId) {
    try {
      const notifyCh = await interaction.client.channels
        .fetch(slotSettings.jackpotChannelId)
        .catch(() => null);
      if (notifyCh && notifyCh.type === ChannelType.GuildText) {
        const profit = Math.abs(netDelta);
        await (notifyCh as TextChannel).send({
          embeds: [
            new EmbedBuilder()
              .setTitle("🎰🎉 ジャックポット！")
              .setDescription(
                `<@${userId}> が **5ライン全当選** を達成しました！\n` +
                `獲得: **+${profit.toLocaleString()} ${currencyName}**`,
              )
              .setColor(0xf1c40f)
              .setTimestamp(),
          ],
        });
      }
    } catch { /* 通知失敗は握りつぶす */ }
  }
}

// ─── Subcommand handlers ──────────────────────────────────────────────────────

async function handlePlay(interaction: ChatInputCommandInteraction): Promise<void> {
  const bet = interaction.options.getInteger("bet", true);
  const { guildId } = interaction;
  if (!guildId) return;
  const userId = interaction.user.id;

  const { currencyName } = await getGuildSettings(guildId);

  // セッションをリセット（新規プレイ）
  activeSessions.set(sessionKey(guildId, userId), {
    totals: emptyCasinoResultTotals(),
    currencyName,
  });

  await interaction.reply({ embeds: [buildSpinningEmbed(bet, currencyName)], flags: MessageFlags.Ephemeral });
  await new Promise((res) => setTimeout(res, 1300));
  await spinAndReply(interaction, bet);
}

// ─── Button handlers ──────────────────────────────────────────────────────────

function parseSlotButtonPayload(customId: string, prefix: string): { ownerId: string; bet: number } | null {
  const payload = customId.slice(prefix.length);
  const colonIdx = payload.indexOf(":");
  if (colonIdx === -1) return null;
  const ownerId = payload.slice(0, colonIdx);
  const bet = Number(payload.slice(colonIdx + 1));
  if (!Number.isFinite(bet)) return null;
  return { ownerId, bet };
}

export async function handleSlotPlayAgainBtn(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseSlotButtonPayload(interaction.customId, SLOT_REPLAY_PREFIX);
  if (!parsed) { await interaction.deferUpdate(); return; }
  const { ownerId, bet } = parsed;

  if (interaction.user.id !== ownerId) {
    await interaction.reply({ content: "❌ このボタンはコマンドを実行した本人のみ使用できます。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (bet < MIN_BET || bet > MAX_BET) { await interaction.deferUpdate(); return; }

  const { guildId } = interaction;
  if (!guildId) { await interaction.deferUpdate(); return; }

  const key = sessionKey(guildId, ownerId);
  if (processingReplays.has(key)) {
    await interaction.deferUpdate();
    return;
  }
  processingReplays.add(key);

  const { currencyName } = await getGuildSettings(guildId);
  try {
    await interaction.update({ embeds: [buildSpinningEmbed(bet, currencyName)], components: [], content: "" });
    await new Promise((res) => setTimeout(res, 1300));
    await spinAndReply(interaction, bet);
  } finally {
    processingReplays.delete(key);
  }
}

export async function handleSlotQuitBtn(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseSlotButtonPayload(interaction.customId, SLOT_QUIT_PREFIX);
  if (!parsed) { await interaction.deferUpdate(); return; }
  const { ownerId } = parsed;

  if (interaction.user.id !== ownerId) {
    await interaction.reply({ content: "❌ このボタンはコマンドを実行した本人のみ使用できます。", flags: MessageFlags.Ephemeral });
    return;
  }

  const { guildId } = interaction;
  if (!guildId) { await interaction.deferUpdate(); return; }

  const key = sessionKey(guildId, interaction.user.id);
  if (processingReplays.has(key)) {
    await interaction.reply({ content: "🔄 リプレイ処理中です。少し待ってください。", flags: MessageFlags.Ephemeral });
    return;
  }
  const session = activeSessions.get(key);
  activeSessions.delete(key);

  if (!session || session.totals.games === 0) {
    await interaction.update({ components: [] });
    return;
  }

  await interaction.update({
    components: [],
    embeds: [buildSessionSummaryEmbed(session.totals, session.currencyName)],
    content: "",
  });
}

export async function handleSlotWinRateBtn(interaction: ButtonInteraction): Promise<void> {
  const { guildId, guild } = interaction;
  if (!guildId || !guild) {
    await interaction.deferUpdate();
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "❌ この設定は管理者のみ変更できます。", flags: MessageFlags.Ephemeral });
    return;
  }

  const payload = interaction.customId.slice(SLOT_WIN_RATE_PREFIX.length);
  const separator = payload.indexOf(":");
  const targetGuildId = payload.slice(0, separator);
  const rawRate = payload.slice(separator + 1);
  if (separator === -1 || targetGuildId !== guildId) {
    await interaction.deferUpdate();
    return;
  }

  const winRate = rawRate === "reset" ? null : Number(rawRate);
  if (winRate !== null && (!Number.isInteger(winRate) || winRate < 0 || winRate > 100)) {
    await interaction.deferUpdate();
    return;
  }

  await interaction.deferUpdate();
  const settings = await setSlotWinRate(guildId, winRate);
  const embed = await buildWinRateSetupEmbed(guild, settings);
  await interaction.editReply({
    embeds: [embed],
    components: buildWinRateButtons(guildId, settings.winRate),
  });
}

/** 入力値が絵文字文字列か sticker ID かを判定してキーを返す */
function parseSymbolInput(input: string): { type: "emoji"; emojiId: string } | { type: "sticker"; stickerId: string } | null {
  const emojiId = parseEmojiId(input);
  if (emojiId) return { type: "emoji", emojiId };
  if (/^\d+$/.test(input)) return { type: "sticker", stickerId: input };
  return null;
}

async function handleSetupAdd(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild!;
  const input = interaction.options.getString("symbol", true).trim();
  const parsed = parseSymbolInput(input);

  if (!parsed) {
    await interaction.reply({ content: "❌ サーバー絵文字またはスタンプ名を選択してください。", flags: MessageFlags.Ephemeral });
    return;
  }

  if (parsed.type === "emoji") {
    const emoji = guild.emojis.cache.get(parsed.emojiId) ?? await guild.emojis.fetch(parsed.emojiId).catch(() => null);
    if (!emoji) {
      await interaction.reply({ content: "❌ このサーバーに登録されていない絵文字です。", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const s = await addSlotEmoji(guild.id, parsed.emojiId);
    await interaction.editReply({ content: `✅ ${input} を絵柄に登録しました。`, embeds: [buildSetupEmbed(guild, s)] });
    return;
  }

  // sticker
  const stickers = guild.stickers.cache.size > 0 ? guild.stickers.cache : await guild.stickers.fetch().catch(() => guild.stickers.cache);
  const sticker = stickers.get(parsed.stickerId) ?? await guild.stickers.fetch(parsed.stickerId).catch(() => null);
  if (!sticker) {
    await interaction.reply({ content: "❌ このサーバーに登録されていないスタンプです。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (sticker.format === StickerFormatType.Lottie) {
    await interaction.reply({ content: "❌ Lottie形式のスタンプは非対応です（PNG / APNG / GIF のみ）。", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const s = await addSlotSticker(guild.id, parsed.stickerId);
  await interaction.editReply({ content: `✅ **${sticker.name}** を絵柄に登録しました。`, embeds: [buildSetupEmbed(guild, s)] });
}

async function handleSetupRemove(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild!;
  const input = interaction.options.getString("symbol", true).trim();
  const parsed = parseSymbolInput(input);

  if (!parsed) {
    await interaction.reply({ content: "❌ 有効な絵文字またはスタンプを選択してください。", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const s = parsed.type === "emoji"
    ? await removeSlotEmoji(guild.id, parsed.emojiId)
    : await removeSlotSticker(guild.id, parsed.stickerId);
  await interaction.editReply({ content: "✅ 絵柄を削除しました。", embeds: [buildSetupEmbed(guild, s)] });
}

async function handleSetupWeight(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild!;
  const input = interaction.options.getString("symbol", true).trim();
  const weight = interaction.options.getInteger("weight", true);
  const parsed = parseSymbolInput(input);

  if (!parsed) {
    await interaction.reply({ content: "❌ 有効な絵文字またはスタンプを選択してください。", flags: MessageFlags.Ephemeral });
    return;
  }

  const key = parsed.type === "emoji" ? parsed.emojiId : parsed.stickerId;
  const current = await getSlotSettings(guild.id);
  const registered = parsed.type === "emoji"
    ? current.fixedEmojiIds.includes(key)
    : current.stickerIds.includes(key);

  if (!registered) {
    await interaction.reply({ content: "❌ 先に `/slot setup add` でその絵柄を登録してください。", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const s = await setSlotEmojiWeight(guild.id, key, weight);
  await interaction.editReply({ content: `✅ 重みを **×${weight}** に設定しました。`, embeds: [buildSetupEmbed(guild, s)] });
}

async function handleSetupPayout(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild!;
  const lines = interaction.options.getInteger("lines", true);
  const multiplier = interaction.options.getInteger("multiplier", true);

  if (lines < 1 || lines > 5) {
    await interaction.reply({ content: "❌ lines は 1〜5 で指定してください。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (multiplier < 0) {
    await interaction.reply({ content: "❌ multiplier は 0 以上の整数を指定してください。", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const s = await setSlotPayout(guild.id, lines, multiplier);
  await interaction.editReply({
    content: `✅ **${lines}ライン当選** の倍率を **+${multiplier}×** に設定しました。`,
    embeds: [buildSetupEmbed(guild, s)],
  });
}

async function handleSetupProbability(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild!;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const settings = await getSlotSettings(guild.id);
  const embed = await buildWinRateSetupEmbed(guild, settings);
  await interaction.editReply({
    embeds: [embed],
    components: buildWinRateButtons(guild.id, settings.winRate),
  });
}

async function handleSetupList(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild!;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  // スティッカーキャッシュを確保
  if (guild.stickers.cache.size === 0) await guild.stickers.fetch().catch(() => null);
  const s = await getSlotSettings(guild.id);
  await interaction.editReply({ embeds: [buildSetupEmbed(guild, s)] });
}

async function handleSetupClear(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild!;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await clearSlotStickers(guild.id);
  const s = await clearSlotEmojis(guild.id);
  await interaction.editReply({
    content: "✅ 絵柄設定をリセットしました。配当倍率はそのまま残ります。",
    embeds: [buildSetupEmbed(guild, s)],
  });
}

async function handleSetupJackpotChannel(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild!;
  const channel = interaction.options.getChannel("channel", false);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!channel) {
    // チャンネル未指定 → 通知を解除
    await setSlotJackpotChannel(guild.id, null);
    await interaction.editReply({ content: "✅ ジャックポット通知チャンネルを解除しました。" });
    return;
  }

  if (channel.type !== ChannelType.GuildText) {
    await interaction.editReply({ content: "❌ テキストチャンネルを指定してください。" });
    return;
  }

  await setSlotJackpotChannel(guild.id, channel.id);
  await interaction.editReply({
    content: `✅ ジャックポット通知チャンネルを <#${channel.id}> に設定しました。\n5ライン全当選が出た際にそのチャンネルへ通知します。`,
  });
}

// ─── Command definition ───────────────────────────────────────────────────────

export const slotCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("slot")
    .setDescription("3×3スロット 🎰 ｜ 横3・斜め2の計5ライン")
    .setDefaultMemberPermissions(0)
    .addSubcommand((sub) =>
      sub
        .setName("play")
        .setDescription("スロットを回す")
        .addIntegerOption((opt) =>
          opt
            .setName("bet")
            .setDescription(`賭け金額（${MIN_BET.toLocaleString()}〜${MAX_BET.toLocaleString()}）`)
            .setRequired(true)
            .setMinValue(MIN_BET)
            .setMaxValue(MAX_BET),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("setup")
        .setDescription("スロット設定（管理者）")
        .addSubcommand((sub) =>
          sub
            .setName("add")
            .setDescription("絵文字またはスタンプを絵柄に登録します")
            .addStringOption((opt) =>
              opt.setName("symbol").setDescription("絵文字 or スタンプ名で検索").setRequired(true).setAutocomplete(true),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("remove")
            .setDescription("絵柄を削除します")
            .addStringOption((opt) =>
              opt.setName("symbol").setDescription("絵文字 or スタンプ名で検索").setRequired(true).setAutocomplete(true),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("weight")
            .setDescription("絵柄の出現重みを設定します（確率調整）")
            .addStringOption((opt) =>
              opt.setName("symbol").setDescription("絵文字 or スタンプ名で検索").setRequired(true).setAutocomplete(true),
            )
            .addIntegerOption((opt) =>
              opt
                .setName("weight")
                .setDescription("出現重み（1=基準、5=5倍出やすい、20=最大）")
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(20),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("payout")
            .setDescription("当選ライン数ごとの配当倍率を設定します")
            .addIntegerOption((opt) =>
              opt
                .setName("lines")
                .setDescription("当選ライン数（1〜5）")
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(5),
            )
            .addIntegerOption((opt) =>
              opt
                .setName("multiplier")
                .setDescription("賭け金に対する純利益の倍率（例: 3 → 賭け金+3倍の利益）")
                .setRequired(true)
                .setMinValue(0)
                .setMaxValue(1000),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("probability")
            .setDescription("ボタンで当選確率を設定し、払い戻し率を確認します"),
        )
        .addSubcommand((sub) =>
          sub.setName("list").setDescription("現在の設定を表示します"),
        )
        .addSubcommand((sub) =>
          sub.setName("clear").setDescription("絵柄設定をリセットします（配当倍率は保持）"),
        )
        .addSubcommand((sub) =>
          sub
            .setName("jackpot-channel")
            .setDescription("5ライン全当選（ジャックポット）の通知チャンネルを設定します")
            .addChannelOption((opt) =>
              opt
                .setName("channel")
                .setDescription("通知先テキストチャンネル（省略で通知解除）")
                .setRequired(false),
            ),
        ),
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId || !interaction.guild) {
      await interaction.reply({ content: "このコマンドはサーバー内でのみ使用できます。", flags: MessageFlags.Ephemeral });
      return;
    }

    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();

    if (group === "setup") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: "❌ このサブコマンドは管理者のみ使用できます。", flags: MessageFlags.Ephemeral });
        return;
      }
      if (sub === "add")              { await handleSetupAdd(interaction); return; }
      if (sub === "remove")           { await handleSetupRemove(interaction); return; }
      if (sub === "weight")           { await handleSetupWeight(interaction); return; }
      if (sub === "payout")           { await handleSetupPayout(interaction); return; }
      if (sub === "probability")      { await handleSetupProbability(interaction); return; }
      if (sub === "list")             { await handleSetupList(interaction); return; }
      if (sub === "clear")            { await handleSetupClear(interaction); return; }
      if (sub === "jackpot-channel")  { await handleSetupJackpotChannel(interaction); return; }
      return;
    }

    await handlePlay(interaction);
  },

  async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    if (!interaction.guild) return;
    const sub = interaction.options.getSubcommand(false);
    const focused = interaction.options.getFocused().toLowerCase();

    // キャッシュ確保（並列）
    const [emojis, stickers] = await Promise.all([
      interaction.guild.emojis.cache.size > 0
        ? Promise.resolve(interaction.guild.emojis.cache)
        : interaction.guild.emojis.fetch().catch(() => interaction.guild!.emojis.cache),
      interaction.guild.stickers.cache.size > 0
        ? Promise.resolve(interaction.guild.stickers.cache)
        : interaction.guild.stickers.fetch().catch(() => interaction.guild!.stickers.cache),
    ]);

    let choices: { name: string; value: string }[] = [];

    if (sub === "remove" || sub === "weight") {
      // 登録済みのみ
      const settings = await getSlotSettings(interaction.guild.id);

      // 登録済み絵文字
      for (const id of settings.fixedEmojiIds) {
        const e = emojis.get(id);
        if (!e?.name) continue;
        const sym = e.animated ? `<a:${e.name}:${e.id}>` : `<:${e.name}:${e.id}>`;
        if (e.name.toLowerCase().includes(focused)) choices.push({ name: `${sym} ${e.name}`, value: sym });
      }
      // 登録済みスタンプ
      for (const id of settings.stickerIds) {
        const s = stickers.get(id);
        if (!s) continue;
        if (s.name.toLowerCase().includes(focused)) choices.push({ name: `🎴 ${s.name}`, value: id });
      }
    } else {
      // add: 全絵文字＋全スタンプ
      for (const e of emojis.values()) {
        if (!e.name || e.managed) continue;
        if (!e.name.toLowerCase().includes(focused)) continue;
        const sym = e.animated ? `<a:${e.name}:${e.id}>` : `<:${e.name}:${e.id}>`;
        choices.push({ name: `${sym} ${e.name}`, value: sym });
      }
      for (const s of stickers.values()) {
        if (s.format === StickerFormatType.Lottie) continue;
        if (!s.name.toLowerCase().includes(focused)) continue;
        choices.push({ name: `🎴 ${s.name}`, value: s.id });
      }
    }

    await interaction.respond(choices.slice(0, 25));
  },
};
