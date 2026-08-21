/**
 * /highlow — ハイアンドロー
 * 現在のカードより次のカードが高いか低いかを当てる。
 * 正解するたびに受け取り予定額が ×1.5 になる。
 * ブラックジャックと同じカード画像・スート絵文字システムを使用。
 */

import Jimp from "jimp";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  ButtonInteraction,
  Message,
  type ChatInputCommandInteraction,
} from "discord.js";
import { sql } from "drizzle-orm";
import { db, walletsTable } from "@workspace/db";
import {
  getGuildSettings,
  recordTransaction,
  getOrCreateWallet,
  setHighlowWinRate,
} from "../lib/economy";
import {
  addCasinoRound,
  buildCasinoResultFields,
  emptyCasinoResultTotals,
  type CasinoResultTotals,
} from "../lib/casinoResult";
import { dailyLimitReachedMessage, tryStartCasinoPlay } from "../lib/casinoPlayLimits";
import { CASINO_DEFAULT_MAX_BET } from "./casino";
import { getBjCardImages } from "../lib/bjCardImages";
import { downloadImageAsBuffer } from "../lib/gcsStorage";
import type { GuildSettings } from "@workspace/db";

// ─── Types ────────────────────────────────────────────────────────────────────

const SUITS = ["♠", "♥", "♦", "♣"] as const;
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;
type Suit = (typeof SUITS)[number];
type Rank = (typeof RANKS)[number];
interface Card { rank: Rank; suit: Suit }
type SuitEmojis = Record<Suit, string>;

const SUIT_KEY: Record<Suit, string> = {
  "♠": "spade", "♥": "heart", "♦": "diamond", "♣": "club",
};

interface HLGame {
  guildId: string;
  userId: string;
  originalBet: number;   // 最初にウォレットから引いた額
  currentWin: number;    // 現在の受け取り予定額
  currentCard: Card;
  deck: Card[];
  currencyName: string;
  balance: number;
  expiresAt: number;
  suitEmojis: SuitEmojis;
  cardPaths: Map<string, string>;
  cardBuffers: Map<string, Buffer>;
  processing: boolean;
  streak: number;
  winRate: number;
  publicMessage?: Message;
}

type EmbedWithFiles = { embeds: EmbedBuilder[]; files: AttachmentBuilder[] };

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_BET = 1000;
const MAX_BET = 10_000;
const GAME_TTL_MS = 5 * 60 * 1000;

/** 正解ごとに受け取り予定額に掛けるペイアウト倍率 */
const PAYOUT_MULTIPLIER = 1.5;
export const DEFAULT_WIN_RATE = 50;

const COLOR_NEUTRAL = 0x5865f2;
const COLOR_WIN     = 0x57f287;
const COLOR_LOSE    = 0xed4245;

export const HL_PREFIX = "hl:";

// ─── In-memory state ──────────────────────────────────────────────────────────

const activeGames = new Map<string, HLGame>();

function gameKey(guildId: string, userId: string) { return `${guildId}:${userId}`; }

setInterval(() => {
  const now = Date.now();
  for (const [key, game] of activeGames) {
    if (game.expiresAt < now) activeGames.delete(key);
  }
}, 60_000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveSuitEmojis(settings: GuildSettings): SuitEmojis {
  return {
    "♠": settings.bjSuitSpade   ?? "♠️",
    "♥": settings.bjSuitHeart   ?? "♥️",
    "♦": settings.bjSuitDiamond ?? "♦️",
    "♣": settings.bjSuitClub    ?? "♣️",
  };
}

/** ハイアンドロー用カード値（A=1, 2-10=数値, J=11, Q=12, K=13） */
function hlCardValue(rank: Rank): number {
  if (rank === "A") return 1;
  if (rank === "J") return 11;
  if (rank === "Q") return 12;
  if (rank === "K") return 13;
  return parseInt(rank, 10);
}

function formatCard(c: Card, emojis: SuitEmojis) { return `${c.rank}${emojis[c.suit]}`; }

// ─── Card image helpers ───────────────────────────────────────────────────────

interface CardImage { attachment: AttachmentBuilder; filename: string }

const CARD_HEIGHT = 150;

async function mergeHorizontal(buffers: Buffer[]): Promise<Buffer> {
  const images  = await Promise.all(buffers.map((b) => Jimp.read(b)));
  const targetH = Math.min(
    Math.max(...images.map((img) => img.bitmap.height)),
    CARD_HEIGHT,
  );
  const resized = images.map((img) => {
    const ratio = targetH / img.bitmap.height;
    return img.resize(Math.round(img.bitmap.width * ratio), targetH, Jimp.RESIZE_BICUBIC);
  });
  const totalW = resized.reduce((sum, img) => sum + img.bitmap.width, 0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const canvas  = new (Jimp as any)(totalW, targetH, 0x00000000);
  let x = 0;
  for (const img of resized) { canvas.composite(img, x, 0); x += img.bitmap.width; }
  return canvas.getBufferAsync(Jimp.MIME_PNG);
}

async function cacheCardBuffer(
  card: Card,
  cardPaths: Map<string, string>,
  cardBuffers: Map<string, Buffer>,
): Promise<void> {
  const key  = `${card.rank}:${SUIT_KEY[card.suit]}`;
  if (cardBuffers.has(key)) return;
  const path = cardPaths.get(key);
  if (!path) return;
  try {
    const buf = await downloadImageAsBuffer(path);
    if (buf) cardBuffers.set(key, buf);
  } catch { /* 失敗しても無視 */ }
}

async function buildStripFromCards(
  cards: Card[],
  cardBuffers: Map<string, Buffer>,
  filename: string,
): Promise<CardImage | null> {
  const buffers = cards
    .map((c) => cardBuffers.get(`${c.rank}:${SUIT_KEY[c.suit]}`) ?? null)
    .filter((b): b is Buffer => b !== null);
  if (buffers.length === 0) return null;
  try {
    const merged = await mergeHorizontal(buffers);
    return { attachment: new AttachmentBuilder(merged, { name: filename }), filename };
  } catch { return null; }
}

// ─── Balance helpers ──────────────────────────────────────────────────────────

async function deductBet(
  guildId: string, userId: string, bet: number,
): Promise<{ balance: number } | null> {
  const [row] = await db
    .update(walletsTable)
    .set({ balance: sql`${walletsTable.balance} - ${bet}` })
    .where(sql`${walletsTable.guildId} = ${guildId} AND ${walletsTable.userId} = ${userId} AND ${walletsTable.balance} >= ${bet}`)
    .returning({ balance: walletsTable.balance });
  return row ?? null;
}

async function creditAmount(
  guildId: string, userId: string, amount: number,
): Promise<number> {
  const [row] = await db
    .update(walletsTable)
    .set({ balance: sql`${walletsTable.balance} + ${amount}` })
    .where(sql`${walletsTable.guildId} = ${guildId} AND ${walletsTable.userId} = ${userId}`)
    .returning({ balance: walletsTable.balance });
  return row?.balance ?? 0;
}

// ─── Deck helpers ─────────────────────────────────────────────────────────────

function buildShoe(decks = 6): Card[] {
  const shoe: Card[] = [];
  for (let i = 0; i < decks; i++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) { shoe.push({ rank, suit }); }
    }
  }
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shoe[i], shoe[j]] = [shoe[j]!, shoe[i]!];
  }
  return shoe;
}

function draw(deck: Card[]): [Card, Card[]] { return [deck[0]!, deck.slice(1)]; }

/**
 * 設定された当選確率を、カードの高低関係と矛盾しない形で反映する。
 * 設定値は「正解する確率」として扱う。引き分けは通常の設定値では
 * カード構成に応じて発生するが、0% と 100% では発生しない。
 */
export function drawForGuess(
  deck: Card[],
  currentValue: number,
  guess: "high" | "low",
  winRate: number,
): [Card, Card[]] {
  const wins: number[] = [];
  const losses: number[] = [];
  const draws: number[] = [];

  for (let index = 0; index < deck.length; index++) {
    const value = hlCardValue(deck[index]!.rank);
    if (value === currentValue) {
      draws.push(index);
    } else if (guess === "high" ? value > currentValue : value < currentValue) {
      wins.push(index);
    } else {
      losses.push(index);
    }
  }

  const clampedRate = Math.max(0, Math.min(100, winRate));
  const canDraw = wins.length > 0 && losses.length > 0 && draws.length > 0;
  const naturalDrawRate = canDraw ? draws.length / deck.length : 0;
  const drawWeight = naturalDrawRate * 100 * (2 * Math.min(clampedRate, 100 - clampedRate) / 100);
  const winWeight = wins.length > 0
    ? (losses.length > 0 ? clampedRate : 100)
    : 0;
  const lossWeight = losses.length > 0
    ? (wins.length > 0 ? 100 - clampedRate - drawWeight : 100)
    : 0;
  const choices = [
    { indices: draws, weight: drawWeight },
    { indices: wins, weight: winWeight },
    { indices: losses, weight: lossWeight },
  ].filter((choice) => choice.weight > 0);

  const totalWeight = choices.reduce((sum, choice) => sum + choice.weight, 0);
  let roll = Math.random() * totalWeight;
  let selected = choices[choices.length - 1]!.indices;
  for (const choice of choices) {
    roll -= choice.weight;
    if (roll < 0) {
      selected = choice.indices;
      break;
    }
  }

  const selectedIndex = selected[Math.floor(Math.random() * selected.length)]!;
  return [deck[selectedIndex]!, deck.filter((_, index) => index !== selectedIndex)];
}

// ─── Embed builders ───────────────────────────────────────────────────────────

async function buildGameEmbed(game: HLGame): Promise<EmbedWithFiles> {
  const e         = game.suitEmojis;
  const cardImage = await buildStripFromCards([game.currentCard], game.cardBuffers, "current.png");

  const embed = new EmbedBuilder()
    .setTitle("🃏 ハイアンドロー")
    .setColor(COLOR_NEUTRAL)
    .addFields(
      { name: "現在のカード", value: `${formatCard(game.currentCard, e)}　**${hlCardValue(game.currentCard.rank)}**`, inline: true },
      { name: "賭け金",       value: `**${game.originalBet.toLocaleString()}** ${game.currencyName}`, inline: true },
      { name: "連続正解",     value: `**${game.streak}** 回`, inline: true },
      { name: "受け取り予定", value: `**${game.currentWin.toLocaleString()}** ${game.currencyName}`, inline: true },
    )
    .setFooter({ text: "HIGH: 次が高い（A<2<…<10<J<Q<K）  LOW: 次が低い | 5分でタイムアウト" });

  if (cardImage) embed.setImage(`attachment://${cardImage.filename}`);

  return { embeds: [embed], files: cardImage ? [cardImage.attachment] : [] };
}

async function buildResultEmbed(
  game: HLGame,
  nextCard: Card,
  result: "win" | "lose" | "draw",
  totals?: CasinoResultTotals,
): Promise<EmbedWithFiles> {
  const e = game.suitEmojis;
  await cacheCardBuffer(nextCard, game.cardPaths, game.cardBuffers);
  const cardImage = await buildStripFromCards([game.currentCard, nextCard], game.cardBuffers, "result.png");

  if (result === "win") {
    const newWin   = Math.floor(game.currentWin * PAYOUT_MULTIPLIER);
    const netDelta = newWin - game.originalBet;
    const sign     = netDelta >= 0 ? "+" : "";
    const embed  = new EmbedBuilder()
      .setTitle("🃏 ハイアンドロー — ✅ 正解！")
      .setColor(COLOR_WIN)
      .addFields(
        { name: "前のカード",     value: `${formatCard(game.currentCard, e)}　**${hlCardValue(game.currentCard.rank)}**`, inline: true },
        { name: "次のカード",     value: `${formatCard(nextCard, e)}　**${hlCardValue(nextCard.rank)}**`, inline: true },
        { name: "\u200B",         value: "\u200B", inline: true },
        { name: "連続正解",       value: `**${game.streak + 1}** 回`, inline: true },
        { name: "受け取り予定",   value: `**${newWin.toLocaleString()}** ${game.currencyName}`, inline: true },
        { name: "収支（予定）",   value: `${sign}**${netDelta.toLocaleString()}** ${game.currencyName}`, inline: true },
      )
      .setFooter({ text: "受け取るか、続けるかを選んでください" });
    if (cardImage) embed.setImage(`attachment://${cardImage.filename}`);
    return { embeds: [embed], files: cardImage ? [cardImage.attachment] : [] };
  } else if (result === "draw") {
    const embed = new EmbedBuilder()
      .setTitle("🃏 ハイアンドロー — 🤝 引き分け")
      .setColor(0xf0c040)
      .addFields(
        { name: "前のカード", value: `${formatCard(game.currentCard, e)}　**${hlCardValue(game.currentCard.rank)}**`, inline: true },
        { name: "次のカード", value: `${formatCard(nextCard, e)}　**${hlCardValue(nextCard.rank)}**`, inline: true },
        { name: "\u200B",     value: "\u200B", inline: true },
        { name: "賭け金",       value: `**${game.originalBet.toLocaleString()}** ${game.currencyName}`, inline: true },
        { name: "収支",         value: "このラウンドは変動なし", inline: true },
      )
      .setFooter({ text: "賭け金はそのままです。「もう一度プレイ」で次の予想へ進みます" });
    if (cardImage) embed.setImage(`attachment://${cardImage.filename}`);
    return { embeds: [embed], files: cardImage ? [cardImage.attachment] : [] };
  } else {
    const embed = new EmbedBuilder()
      .setTitle("🃏 ハイアンドロー — ❌ 不正解")
      .setColor(COLOR_LOSE)
      .addFields(
        { name: "前のカード", value: `${formatCard(game.currentCard, e)}　**${hlCardValue(game.currentCard.rank)}**`, inline: true },
        { name: "次のカード", value: `${formatCard(nextCard, e)}　**${hlCardValue(nextCard.rank)}**`, inline: true },
        { name: "\u200B",     value: "\u200B", inline: true },
        ...buildCasinoResultFields(
          totals ?? addCasinoRound(emptyCasinoResultTotals(), game.originalBet, 0),
          game.currencyName,
        ),
      );
    if (cardImage) embed.setImage(`attachment://${cardImage.filename}`);
    return { embeds: [embed], files: cardImage ? [cardImage.attachment] : [] };
  }
}

// ─── Button builders ──────────────────────────────────────────────────────────

function buildGuessButtons(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("hl:high").setLabel("HIGH").setEmoji("⬆️").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("hl:low").setLabel("LOW").setEmoji("⬇️").setStyle(ButtonStyle.Danger),
  );
}

export function buildContinueButtons(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("hl:continue").setLabel("続ける").setEmoji("🔄").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("hl:collect").setLabel("受け取る").setEmoji("💰").setStyle(ButtonStyle.Success),
  );
}

export function buildDrawReplayButton(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("hl:continue").setLabel("もう一度プレイ").setEmoji("🔄").setStyle(ButtonStyle.Primary),
  );
}

// ─── /highlow play ────────────────────────────────────────────────────────────

async function handlePlay(interaction: ChatInputCommandInteraction): Promise<void> {
  const { guildId } = interaction;
  if (!guildId) return;

  await interaction.deferReply();

  const userId = interaction.user.id;
  const bet    = interaction.options.getInteger("bet", true);

  const [settings, , cardPaths] = await Promise.all([
    getGuildSettings(guildId),
    getOrCreateWallet(guildId, userId),
    getBjCardImages(guildId),
  ]);

  const maxBet = settings.casinoMaxBet ?? CASINO_DEFAULT_MAX_BET;

  if (bet < MIN_BET) {
    await interaction.editReply(`❌ 最低賭け金は **${MIN_BET.toLocaleString()}** ${settings.currencyName} です。`);
    return;
  }
  if (bet > maxBet) {
    await interaction.editReply(`❌ 最大賭け金は **${maxBet.toLocaleString()}** ${settings.currencyName} です。`);
    return;
  }

  const key = gameKey(guildId, userId);
  if (activeGames.has(key)) {
    await interaction.editReply("❌ 既にゲーム中です。現在のゲームを終了してください。");
    return;
  }

  const playStart = await tryStartCasinoPlay(guildId, userId, "highlow", bet);
  if (!playStart.ok && playStart.reason === "daily_limit_reached") {
    await interaction.editReply(dailyLimitReachedMessage("highlow", playStart.limit));
    return;
  }
  if (!playStart.ok) {
    await interaction.editReply(`❌ 残高が不足しています。`);
    return;
  }
  const afterDeduct = { balance: playStart.balance };

  const suitEmojis  = resolveSuitEmojis(settings);
  const deck        = buildShoe(6);
  const [firstCard, remainingDeck] = draw(deck);
  const cardBuffers = new Map<string, Buffer>();
  await cacheCardBuffer(firstCard, cardPaths, cardBuffers);

  const game: HLGame = {
    guildId, userId,
    originalBet: bet,
    currentWin:  Math.floor(bet * PAYOUT_MULTIPLIER),
    currentCard: firstCard,
    deck: remainingDeck,
    currencyName: settings.currencyName,
    balance: afterDeduct.balance,
    expiresAt: Date.now() + GAME_TTL_MS,
    suitEmojis, cardPaths, cardBuffers,
    processing: false,
    streak: 0,
    winRate: settings.highlowWinRate ?? DEFAULT_WIN_RATE,
  };

  activeGames.set(key, game);
  const { embeds, files } = await buildGameEmbed(game);
  const msg = await interaction.editReply({ embeds, files, components: [] });
  game.publicMessage = msg as Message;
  await interaction.followUp({ components: [buildGuessButtons()], flags: MessageFlags.Ephemeral });
}

// ─── Button handler ───────────────────────────────────────────────────────────

export async function handleHighlowButton(interaction: ButtonInteraction): Promise<void> {
  const { guildId, user } = interaction;
  if (!guildId) return;

  const key  = gameKey(guildId, user.id);
  const game = activeGames.get(key);

  if (!game || game.expiresAt < Date.now()) {
    const timedOutGame = game; // 期限切れの場合はデータが残っている
    activeGames.delete(key);

    const embeds = timedOutGame
      ? [
          new EmbedBuilder()
            .setTitle("⏱️ ハイアンドロー — タイムアウト")
            .setColor(COLOR_LOSE)
            .addFields(
              { name: "連続正解",   value: `**${timedOutGame.streak}** 回`, inline: true },
              ...buildCasinoResultFields(
                addCasinoRound(emptyCasinoResultTotals(), timedOutGame.originalBet, 0),
                timedOutGame.currencyName,
              ),
            )
            .setFooter({ text: "/highlow play で新しいゲームを始めてください。" }),
        ]
      : [];

    await interaction.update({
      content: timedOutGame ? "" : "⏱️ ゲームがタイムアウトまたはリセットされました。`/highlow play` で新しいゲームを始めてください。",
      embeds,
      files: [],
      components: [],
    });
    return;
  }
  if (game.userId !== user.id) {
    await interaction.reply({ content: "このゲームはあなたのものではありません。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (game.processing) {
    await interaction.deferUpdate();
    return;
  }

  const action = interaction.customId.slice(HL_PREFIX.length);

  // ─── HIGH / LOW ───────────────────────────────────────────────────────────

  if (action === "high" || action === "low") {
    game.processing = true;
    activeGames.set(key, game);

    // 即座に acknowledge してから重い処理を行う
    await interaction.deferUpdate();

    const currentValue         = hlCardValue(game.currentCard.rank);
    const [nextCard, newDeck]  = drawForGuess(game.deck, currentValue, action, game.winRate);
    const nextValue            = hlCardValue(nextCard.rank);
    const isDraw               = nextValue === currentValue;
    const won                  = !isDraw && (action === "high" ? nextValue > currentValue : nextValue < currentValue);

    if (isDraw) {
      // 引き分け → カードを更新。賭け金は維持し、明示的なボタンから次の予想へ進む。
      const { embeds, files } = await buildResultEmbed(game, nextCard, "draw");
      game.currentCard = nextCard;
      game.deck        = newDeck;
      game.processing  = false;
      activeGames.set(key, game);
      await game.publicMessage?.edit({ content: "", embeds, files, components: [] });
      await interaction.editReply({ embeds: [], files: [], content: "", components: [buildDrawReplayButton()] });
      return;
    }

    if (!won) {
      // 不正解 → ゲーム終了
      activeGames.delete(key);
      await recordTransaction(guildId, user.id, -game.originalBet, `ハイアンドロー敗北（賭け: ${game.originalBet}）`).catch(() => {});
      const { embeds, files } = await buildResultEmbed(
        game,
        nextCard,
        "lose",
        addCasinoRound(emptyCasinoResultTotals(), game.originalBet, 0),
      );
      await game.publicMessage?.edit({ content: "", embeds, files, components: [] });
      await interaction.editReply({ embeds: [], files: [], content: "", components: [] });
      return;
    }

    // 正解 → 結果表示（ゲーム状態は buildResultEmbed の後に更新）
    const { embeds, files } = await buildResultEmbed(game, nextCard, "win");
    game.streak++;
    game.currentWin  = Math.floor(game.currentWin * PAYOUT_MULTIPLIER);
    game.currentCard = nextCard;
    game.deck        = newDeck;
    game.processing  = false;
    activeGames.set(key, game);

    await game.publicMessage?.edit({ content: "", embeds, files, components: [] });
    await interaction.editReply({ embeds: [], files: [], content: "", components: [buildContinueButtons()] });

  // ─── COLLECT ──────────────────────────────────────────────────────────────

  } else if (action === "collect") {
    game.processing = true;
    activeGames.delete(key);

    await creditAmount(guildId, user.id, game.currentWin);
    const netDelta     = game.currentWin - game.originalBet;
    await recordTransaction(guildId, user.id, netDelta, `ハイアンドロー勝利（賭け: ${game.originalBet}）`).catch(() => {});

    const totals = addCasinoRound(emptyCasinoResultTotals(), game.originalBet, game.currentWin);
    const embed = new EmbedBuilder()
      .setTitle("🃏 ハイアンドロー — 💰 受け取り")
      .setColor(COLOR_WIN)
      .addFields(
        { name: "連続正解",   value: `**${game.streak}** 回`, inline: true },
        ...buildCasinoResultFields(totals, game.currencyName),
      );

    await interaction.deferUpdate();
    await game.publicMessage?.edit({ content: "", embeds: [embed], files: [], components: [] });
    await interaction.editReply({ embeds: [], files: [], content: "", components: [] });

  // ─── CONTINUE ─────────────────────────────────────────────────────────────

  } else if (action === "continue") {
    game.processing = true;
    activeGames.set(key, game);
    await interaction.deferUpdate();

    game.processing = false;
    activeGames.set(key, game);

    const { embeds, files } = await buildGameEmbed(game);
    await game.publicMessage?.edit({ content: "", embeds, files, components: [] });
    await interaction.editReply({ embeds: [], files: [], content: "", components: [buildGuessButtons()] });
  }
}

async function handleConfigProbability(interaction: ChatInputCommandInteraction): Promise<void> {
  const { guildId } = interaction;
  if (!guildId) return;

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "❌ 管理者専用です。", flags: MessageFlags.Ephemeral });
    return;
  }

  const winRate = interaction.options.getInteger("percent", true);
  await setHighlowWinRate(guildId, winRate);
  await interaction.reply({
    content: `✅ ハイアンドローの当選確率を **${winRate}%** に設定しました。次回ゲームから反映されます。`,
    flags: MessageFlags.Ephemeral,
  });
}

// ─── Command export ───────────────────────────────────────────────────────────

export const highlowCommand = {
  data: new SlashCommandBuilder()
    .setName("highlow")
    .setDescription("ハイアンドロー — 次のカードが高いか低いかを当てる")
    .setDefaultMemberPermissions(0)
    .addSubcommand((sub) =>
      sub
        .setName("play")
        .setDescription("ゲームを開始する")
        .addIntegerOption((opt) =>
          opt
            .setName("bet")
            .setDescription(`賭け金（${MIN_BET.toLocaleString()}〜${MAX_BET.toLocaleString()}）`)
            .setRequired(true)
            .setMinValue(MIN_BET)
            .setMaxValue(MAX_BET),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("config")
        .setDescription("【管理者】ハイアンドローの設定を変更する")
        .addSubcommand((sub) =>
          sub
            .setName("probability")
            .setDescription("当選確率を設定する")
            .addIntegerOption((opt) =>
              opt
                .setName("percent")
                .setDescription("当選確率（0〜100%）")
                .setMinValue(0)
                .setMaxValue(100)
                .setRequired(true),
            ),
        ),
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    const sub = interaction.options.getSubcommand();
    if (sub === "play") await handlePlay(interaction);
    if (interaction.options.getSubcommandGroup(false) === "config" && sub === "probability") {
      await handleConfigProbability(interaction);
    }
  },
};
