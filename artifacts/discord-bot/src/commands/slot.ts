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
} from "../lib/slot";

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_BET = 10;
const MAX_BET = 100_000;
const SYMBOL_COUNT = 4; // distinct symbols per spin
const DEFAULT_SYMBOLS = ["🍒", "🍋", "🍊", "🍇"];

/**
 * Net profit as a multiplier of `bet` for each number of winning paylines.
 * Index = winning paylines (0–5).  Estimated return rate ≈ 86%.
 */
const NET_MULTIPLIER = [-1, 1, 5, 11, 19, 34] as const;

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

// ─── Emoji parsing ────────────────────────────────────────────────────────────

/** Extract emoji ID from a raw input string like `<:name:123>` or `<a:name:123>`. */
function parseEmojiId(input: string): string | null {
  const match = input.trim().match(/<a?:[^:]+:(\d+)>/);
  return match?.[1] ?? null;
}

/** Resolve an emoji ID to a display string using the guild's emoji cache. */
function resolveEmoji(guild: Guild, emojiId: string): Sym | null {
  const e = guild.emojis.cache.get(emojiId);
  if (!e || !e.name) return null;
  return e.animated ? `<a:${e.name}:${e.id}>` : `<:${e.name}:${e.id}>`;
}

// ─── Symbol pool selection ────────────────────────────────────────────────────

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

async function pickSymbolPool(
  interaction: ChatInputCommandInteraction,
): Promise<Sym[]> {
  const guild = interaction.guild!;
  const settings = await getSlotSettings(guild.id);

  // Fixed mode: use pinned emojis (skip any that were deleted from the server).
  if (settings.fixedEmojiIds.length > 0) {
    const resolved = settings.fixedEmojiIds
      .map((id) => resolveEmoji(guild, id))
      .filter((s): s is Sym => s !== null);

    if (resolved.length >= 2) {
      // Pad with defaults if fewer than SYMBOL_COUNT survived resolution.
      if (resolved.length < SYMBOL_COUNT) {
        const needed = SYMBOL_COUNT - resolved.length;
        resolved.push(...DEFAULT_SYMBOLS.slice(0, needed));
      }
      return resolved.slice(0, SYMBOL_COUNT);
    }
    // Fall through to auto mode if too few valid emojis remain.
  }

  // Auto mode: pick from all guild custom emojis.
  const custom: Sym[] = [...guild.emojis.cache.values()]
    .filter((e) => !e.managed && !!e.name)
    .map((e) => (e.animated ? `<a:${e.name}:${e.id}>` : `<:${e.name}:${e.id}>`));

  const pool =
    custom.length >= SYMBOL_COUNT
      ? shuffle(custom)
      : [...custom, ...DEFAULT_SYMBOLS.filter((d) => !custom.includes(d))];

  return pool.slice(0, SYMBOL_COUNT);
}

// ─── Spin & evaluate ──────────────────────────────────────────────────────────

function pickOne(symbols: Sym[]): Sym {
  return symbols[Math.floor(Math.random() * symbols.length)]!;
}

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
  const b = `${BLANK}  ${BLANK}  ${BLANK}`;
  return new EmbedBuilder()
    .setTitle("🎰 スロット 3×3")
    .setDescription(`${b}\n${b}\n${b}\n\n*回転中...*`)
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
    paylines
      .filter((p) => p.won && p.name.startsWith("横"))
      .map((p) => p.name),
  );
  const rowLabels = ["横 上段", "横 中段", "横 下段"];
  const gridLines = grid.map((row, i) =>
    row.join("  ") + (rowWins.has(rowLabels[i]!) ? "  ✨" : ""),
  );
  const diagWins = paylines.filter((p) => p.won && p.name.startsWith("斜め"));
  const diagLine = diagWins.map((p) => `✨ ${p.name}`).join("　　");
  const gridBlock = gridLines.join("\n") + (diagLine ? "\n" + diagLine : "");

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

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(`${gridBlock}\n\n${resultText}`)
    .setColor(color)
    .setFooter({ text: `残高: ${finalBalance.toLocaleString()} ${currencyName}` });
}

function buildSetupEmbed(guild: Guild, fixedEmojiIds: string[]): EmbedBuilder {
  const mode = fixedEmojiIds.length === 0 ? "自動（全ギルド絵文字から抽選）" : "固定";
  const symbols =
    fixedEmojiIds.length === 0
      ? "*未登録*"
      : fixedEmojiIds
          .map((id, i) => {
            const sym = resolveEmoji(guild, id);
            return sym ? `${i + 1}. ${sym}` : `${i + 1}. *(削除済み: ${id})*`;
          })
          .join("\n");

  return new EmbedBuilder()
    .setTitle("🎰 スロット — 絵柄設定")
    .setColor(0x5865f2)
    .addFields(
      { name: "モード", value: mode, inline: true },
      { name: "登録数", value: `${fixedEmojiIds.length} 種類`, inline: true },
      { name: "登録済み絵柄", value: symbols },
    )
    .setFooter({ text: "4種類以上登録すると固定モードが有効になります" });
}

// ─── Subcommand handlers ──────────────────────────────────────────────────────

async function handlePlay(interaction: ChatInputCommandInteraction): Promise<void> {
  const bet = interaction.options.getInteger("bet", true);
  const { guildId } = interaction;
  if (!guildId) return;
  const userId = interaction.user.id;

  const [, { currencyName }] = await Promise.all([
    getOrCreateWallet(guildId, userId),
    getGuildSettings(guildId),
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

  const symbols = await pickSymbolPool(interaction);
  const grid = spinGrid(symbols);
  const paylines = evaluatePaylines(grid);
  const wins = paylines.filter((p) => p.won).length;
  const multiplier = NET_MULTIPLIER[Math.min(wins, 5)]!;
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
  const raw = interaction.options.getString("emoji", true);
  const emojiId = parseEmojiId(raw);

  if (!emojiId) {
    await interaction.reply({
      content: "❌ カスタム絵文字を入力してください（例: `:emoji_name:`）。Unicode絵文字は使用できません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!guild.emojis.cache.has(emojiId)) {
    await interaction.reply({
      content: "❌ このサーバーに登録されていない絵文字です。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const settings = await addSlotEmoji(guild.id, emojiId);
  await interaction.editReply({ embeds: [buildSetupEmbed(guild, settings.fixedEmojiIds)] });
}

async function handleSetupRemove(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild!;
  const raw = interaction.options.getString("emoji", true);
  const emojiId = parseEmojiId(raw);

  if (!emojiId) {
    await interaction.reply({
      content: "❌ カスタム絵文字を入力してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const settings = await removeSlotEmoji(guild.id, emojiId);
  await interaction.editReply({ embeds: [buildSetupEmbed(guild, settings.fixedEmojiIds)] });
}

async function handleSetupList(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild!;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const settings = await getSlotSettings(guild.id);
  await interaction.editReply({ embeds: [buildSetupEmbed(guild, settings.fixedEmojiIds)] });
}

async function handleSetupClear(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild!;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const settings = await clearSlotEmojis(guild.id);
  await interaction.editReply({
    content: "✅ 絵柄設定をリセットしました。自動モードに戻ります。",
    embeds: [buildSetupEmbed(guild, settings.fixedEmojiIds)],
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
        .setDescription("スロット絵柄の管理（管理者）")
        .addSubcommand((sub) =>
          sub
            .setName("add")
            .setDescription("絵柄を追加登録します")
            .addStringOption((opt) =>
              opt
                .setName("emoji")
                .setDescription("追加するサーバー絵文字（絵文字を直接入力）")
                .setRequired(true),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("remove")
            .setDescription("絵柄を削除します")
            .addStringOption((opt) =>
              opt
                .setName("emoji")
                .setDescription("削除するサーバー絵文字")
                .setRequired(true),
            ),
        )
        .addSubcommand((sub) =>
          sub.setName("list").setDescription("登録済みの絵柄一覧を表示します"),
        )
        .addSubcommand((sub) =>
          sub.setName("clear").setDescription("絵柄設定をリセットし、自動モードに戻します"),
        ),
    )
    .setDefaultMemberPermissions(null) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId || !interaction.guild) {
      await interaction.reply({
        content: "このコマンドはサーバー内でのみ使用できます。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();

    if (group === "setup") {
      // Admin-only gate for setup subcommands.
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({
          content: "❌ このサブコマンドは管理者のみ使用できます。",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (sub === "add")    await handleSetupAdd(interaction);
      else if (sub === "remove") await handleSetupRemove(interaction);
      else if (sub === "list")   await handleSetupList(interaction);
      else if (sub === "clear")  await handleSetupClear(interaction);
      return;
    }

    // play
    await handlePlay(interaction);
  },
};
