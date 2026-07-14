import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  Guild,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { and, eq, sql } from "drizzle-orm";
import { db, walletsTable } from "@workspace/db";
import { getGuildSettings, getOrCreateWallet, recordTransaction } from "../lib/economy";
import {
  getSlotSettings,
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
interface Command {
  data: { name: string; toJSON: () => unknown };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
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
function buildWeightedPool(symbols: Sym[], weights: Record<string, number>): Sym[] {
  const pool: Sym[] = [];
  for (const sym of symbols) {
    const id = extractEmojiId(sym);
    const w = Math.max(1, id ? (weights[id] ?? 1) : 1);
    for (let i = 0; i < w; i++) pool.push(sym);
  }
  return pool;
}

function pickOne(pool: Sym[]): Sym {
  return pool[Math.floor(Math.random() * pool.length)]!;
}

async function pickSymbolPool(
  interaction: ChatInputCommandInteraction,
): Promise<{ symbols: Sym[]; weights: Record<string, number> }> {
  const guild = interaction.guild!;
  const settings = await getSlotSettings(guild.id);
  const weights = settings.emojiWeights ?? {};

  // Fixed mode: use pinned emoji IDs, resolve to display strings.
  if (settings.fixedEmojiIds.length > 0) {
    const resolved = settings.fixedEmojiIds
      .map((id) => resolveEmoji(guild, id))
      .filter((s): s is Sym => s !== null);

    if (resolved.length >= 2) {
      const padded =
        resolved.length < SYMBOL_COUNT
          ? [...resolved, ...DEFAULT_SYMBOLS.slice(0, SYMBOL_COUNT - resolved.length)]
          : resolved.slice(0, SYMBOL_COUNT);
      return { symbols: padded, weights };
    }
  }

  // Auto mode: all guild custom emojis.
  const custom: Sym[] = [...guild.emojis.cache.values()]
    .filter((e) => !e.managed && !!e.name)
    .map((e) => (e.animated ? `<a:${e.name}:${e.id}>` : `<:${e.name}:${e.id}>`));

  const base =
    custom.length >= SYMBOL_COUNT
      ? shuffle(custom)
      : [...custom, ...DEFAULT_SYMBOLS.filter((d) => !custom.includes(d))];

  return { symbols: base.slice(0, SYMBOL_COUNT), weights };
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
  const b = `${BLANK}　　${BLANK}　　${BLANK}`;
  return new EmbedBuilder()
    .setTitle("🎰 スロット 3×3")
    .setDescription(`${b}\n\n${b}\n\n${b}\n\n*回転中...*`)
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
  const rowWins = new Set(
    paylines.filter((p) => p.won && p.name.startsWith("横")).map((p) => p.name),
  );
  const rowLabels = ["横 上段", "横 中段", "横 下段"];
  const gridLines = grid.map(
    (row, i) => row.join("　　") + (rowWins.has(rowLabels[i]!) ? "　✨" : ""),
  );
  const diagWins = paylines.filter((p) => p.won && p.name.startsWith("斜め"));
  const diagLine = diagWins.map((p) => `✨ ${p.name}`).join("　　");
  const gridBlock = gridLines.join("\n\n") + (diagLine ? "\n\n" + diagLine : "");

  // 大きく表示する絵柄: 当選時は当選ライン上の絵柄、ハズレ時は中央マス
  let featuredSym: Sym = grid[1]![1]!;
  if (wins > 0) {
    const wonPayline = paylines.find((p) => p.won);
    if (wonPayline) {
      const def = PAYLINE_DEFS.find((d) => d.name === wonPayline.name);
      if (def) featuredSym = grid[def.coords[0]![0]!]![def.coords[0]![1]!]!;
    }
  }
  const featuredUrl = emojiCdnUrl(featuredSym);

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
    title = wins >= 3 ? "🎰 スロット 3×3 — 大当たり！" : "🎰 スロット 3×3 — 当たり！";
    color = wins >= 3 ? 0xf1c40f : 0x57f287;
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(`${gridBlock}\n\n${resultText}`)
    .setColor(color)
    .setFooter({ text: `残高: ${finalBalance.toLocaleString()} ${currencyName}` });

  if (featuredUrl) embed.setThumbnail(featuredUrl);
  return embed;
}

function buildSetupEmbed(
  guild: Guild,
  fixedEmojiIds: string[],
  emojiWeights: Record<string, number>,
  payoutMultipliers: number[],
): EmbedBuilder {
  const multipliers = resolveMultipliers(payoutMultipliers);
  const mode = fixedEmojiIds.length === 0 ? "🔄 自動（全ギルド絵文字から抽選）" : "📌 固定";

  // Symbol list with weights.
  let symbolsValue: string;
  if (fixedEmojiIds.length === 0) {
    symbolsValue = "*未登録（自動モード）*";
  } else {
    symbolsValue = fixedEmojiIds
      .map((id) => {
        const sym = resolveEmoji(guild, id);
        const w = emojiWeights[id] ?? 1;
        const bar = "█".repeat(Math.min(w, 10)) + (w > 10 ? `…${w}` : "");
        return sym ? `${sym} \`${bar}\` ×${w}` : `*(削除済み: ${id})*`;
      })
      .join("\n");
  }

  // Payout table.
  const payoutLines = [1, 2, 3, 4, 5].map((n) => {
    const m = multipliers[n] ?? DEFAULT_MULTIPLIERS[n];
    const label = n === 5 ? `${n}ライン 🎰` : `${n}ライン`;
    return `\`${label}\` → +${m}× bet`;
  });
  payoutLines.unshift("`0ライン` → -1× bet（固定）");

  const totalWeight = fixedEmojiIds.reduce(
    (sum, id) => sum + (emojiWeights[id] ?? 1), 0,
  );
  const probLines = fixedEmojiIds.length > 0
    ? fixedEmojiIds.map((id) => {
        const sym = resolveEmoji(guild, id);
        const w = emojiWeights[id] ?? 1;
        const pct = totalWeight > 0 ? ((w / totalWeight) * 100).toFixed(1) : "0.0";
        return sym ? `${sym} ${pct}%` : `*(削除済み)* ${pct}%`;
      }).join("  ")
    : "*固定モードでのみ表示*";

  return new EmbedBuilder()
    .setTitle("🎰 スロット — 設定")
    .setColor(0x5865f2)
    .addFields(
      { name: "モード", value: mode, inline: true },
      { name: "絵柄数", value: `${fixedEmojiIds.length || "自動"} 種類`, inline: true },
      { name: "\u200b", value: "\u200b", inline: true },
      { name: "絵柄と出現重み", value: symbolsValue },
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

  const { symbols, weights } = await pickSymbolPool(interaction);
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
  await interaction.editReply({
    embeds: [buildResultEmbed(grid, paylines, wins, netDelta, finalBalance, bet, currencyName)],
  });
}

async function handleSetupAdd(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild!;
  const emojiId = parseEmojiId(interaction.options.getString("emoji", true));
  if (!emojiId) {
    await interaction.reply({ content: "❌ カスタム絵文字を入力してください。", flags: MessageFlags.Ephemeral });
    return;
  }
  // キャッシュになくても API から取得して確認する（キャッシュが未充填の場合に備える）
  const emoji = guild.emojis.cache.get(emojiId) ?? await guild.emojis.fetch(emojiId).catch(() => null);
  if (!emoji) {
    await interaction.reply({ content: "❌ このサーバーに登録されていない絵文字です。", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const s = await addSlotEmoji(guild.id, emojiId);
  await interaction.editReply({ embeds: [buildSetupEmbed(guild, s.fixedEmojiIds, s.emojiWeights, s.payoutMultipliers)] });
}

async function handleSetupRemove(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild!;
  const emojiId = parseEmojiId(interaction.options.getString("emoji", true));
  if (!emojiId) {
    await interaction.reply({ content: "❌ カスタム絵文字を入力してください。", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const s = await removeSlotEmoji(guild.id, emojiId);
  await interaction.editReply({ embeds: [buildSetupEmbed(guild, s.fixedEmojiIds, s.emojiWeights, s.payoutMultipliers)] });
}

async function handleSetupWeight(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild!;
  const emojiId = parseEmojiId(interaction.options.getString("emoji", true));
  const weight = interaction.options.getInteger("weight", true);

  if (!emojiId) {
    await interaction.reply({ content: "❌ カスタム絵文字を入力してください。", flags: MessageFlags.Ephemeral });
    return;
  }

  // Check emoji is in the fixed list.
  const current = await getSlotSettings(guild.id);
  if (!current.fixedEmojiIds.includes(emojiId)) {
    await interaction.reply({
      content: "❌ 先に `/slot setup add` でその絵文字を登録してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const s = await setSlotEmojiWeight(guild.id, emojiId, weight);
  await interaction.editReply({
    content: `✅ 重みを **×${weight}** に設定しました。`,
    embeds: [buildSetupEmbed(guild, s.fixedEmojiIds, s.emojiWeights, s.payoutMultipliers)],
  });
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
    embeds: [buildSetupEmbed(guild, s.fixedEmojiIds, s.emojiWeights, s.payoutMultipliers)],
  });
}

async function handleSetupList(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild!;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const s = await getSlotSettings(guild.id);
  await interaction.editReply({ embeds: [buildSetupEmbed(guild, s.fixedEmojiIds, s.emojiWeights, s.payoutMultipliers)] });
}

async function handleSetupClear(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild!;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const s = await clearSlotEmojis(guild.id);
  await interaction.editReply({
    content: "✅ 絵柄設定をリセットしました。配当倍率はそのまま残ります。",
    embeds: [buildSetupEmbed(guild, s.fixedEmojiIds, s.emojiWeights, s.payoutMultipliers)],
  });
}

// ─── Command definition ───────────────────────────────────────────────────────

export const slotCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("slot")
    .setDescription("3×3スロット 🎰 ｜ 横3・斜め2の計5ライン")
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
            .setDescription("絵柄を追加登録します")
            .addStringOption((opt) =>
              opt.setName("emoji").setDescription("追加するサーバー絵文字").setRequired(true),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("remove")
            .setDescription("絵柄を削除します")
            .addStringOption((opt) =>
              opt.setName("emoji").setDescription("削除するサーバー絵文字").setRequired(true),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("weight")
            .setDescription("絵柄の出現重みを設定します（確率調整）")
            .addStringOption((opt) =>
              opt.setName("emoji").setDescription("対象の絵文字").setRequired(true),
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
    .setDefaultMemberPermissions(null) as SlashCommandBuilder,

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
};
