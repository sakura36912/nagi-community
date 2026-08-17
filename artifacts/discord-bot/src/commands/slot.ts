import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  Guild,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StickerFormatType,
} from "discord.js";
import { and, eq, sql } from "drizzle-orm";
import { db, walletsTable } from "@workspace/db";
import { getGuildSettings, getOrCreateWallet, recordTransaction } from "../lib/economy";
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
  resolveMultipliers,
  DEFAULT_MULTIPLIERS,
} from "../lib/slot";

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_BET = 10;
const MAX_BET = 100_000;
const SYMBOL_COUNT = 4;
const DEFAULT_SYMBOLS = ["🍒", "🍋", "🍊", "🍇"];

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
  interaction: ChatInputCommandInteraction,
): Promise<{ symbols: Sym[]; weights: Record<string, number>; meta: Map<string, StickerInfo> }> {
  const guild = interaction.guild!;
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
      return { symbols: valid, weights, meta };
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
      const padded =
        resolved.length < SYMBOL_COUNT
          ? [...resolved, ...DEFAULT_SYMBOLS.slice(0, SYMBOL_COUNT - resolved.length)]
          : resolved.slice(0, SYMBOL_COUNT);
      return { symbols: padded, weights, meta };
    }
  }

  // ── Auto mode: all guild custom emojis ───────────────────────────────────
  const custom: Sym[] = [...guild.emojis.cache.values()]
    .filter((e) => !e.managed && !!e.name)
    .map((e) => (e.animated ? `<a:${e.name}:${e.id}>` : `<:${e.name}:${e.id}>`));

  const base =
    custom.length >= SYMBOL_COUNT
      ? shuffle(custom)
      : [...custom, ...DEFAULT_SYMBOLS.filter((d) => !custom.includes(d))];

  return { symbols: base.slice(0, SYMBOL_COUNT), weights, meta };
}

// ─── Spin & evaluate ──────────────────────────────────────────────────────────

function spinGrid(pool: Sym[]): Grid {
  const row = (): Row => [pickOne(pool), pickOne(pool), pickOne(pool)];
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
    .setColor(color);

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

// ─── Subcommand handlers ──────────────────────────────────────────────────────

async function handlePlay(interaction: ChatInputCommandInteraction): Promise<void> {
  const bet = interaction.options.getInteger("bet", true);
  const { guildId } = interaction;
  if (!guildId) return;
  const userId = interaction.user.id;

  const [, { currencyName }, slotSettings] = await Promise.all([
    getOrCreateWallet(guildId, userId),
    getGuildSettings(guildId),
    getSlotSettings(guildId),
  ]);

  await interaction.reply({ embeds: [buildSpinningEmbed(bet, currencyName)] });

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

  const { symbols, weights, meta } = await pickSymbolPool(interaction);
  const pool = buildWeightedPool(symbols, weights);
  const grid = spinGrid(pool);
  const paylines = evaluatePaylines(grid);
  const wins = paylines.filter((p) => p.won).length;

  const multipliers = resolveMultipliers(slotSettings.payoutMultipliers);
  const multiplier = multipliers[Math.min(wins, 5)] ?? -1;
  const netDelta = Math.floor(bet * multiplier);

  let finalBalance = afterDeduct.balance;
  if (netDelta > 0) {
    finalBalance = await creditWinnings(guildId, userId, netDelta);
  }

  if (netDelta !== 0) {
    await recordTransaction(
      guildId, userId, netDelta,
      wins > 0
        ? `スロット${wins}ライン当選（賭け: ${bet}）`
        : `スロットハズレ（賭け: ${bet}）`,
    );
  }

  await new Promise((res) => setTimeout(res, 1300));
  const { content, embed } = buildResult(grid, paylines, wins, netDelta, finalBalance, bet, currencyName, meta);
  await interaction.editReply({ content, embeds: [embed] });
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
            .setDescription(`賭け金額（${MIN_BET}〜${MAX_BET.toLocaleString()}）`)
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
          sub.setName("list").setDescription("現在の設定を表示します"),
        )
        .addSubcommand((sub) =>
          sub.setName("clear").setDescription("絵柄設定をリセットします（配当倍率は保持）"),
        ),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,

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
      if (sub === "add")     { await handleSetupAdd(interaction); return; }
      if (sub === "remove")  { await handleSetupRemove(interaction); return; }
      if (sub === "weight")  { await handleSetupWeight(interaction); return; }
      if (sub === "payout")  { await handleSetupPayout(interaction); return; }
      if (sub === "list")    { await handleSetupList(interaction); return; }
      if (sub === "clear")   { await handleSetupClear(interaction); return; }
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
