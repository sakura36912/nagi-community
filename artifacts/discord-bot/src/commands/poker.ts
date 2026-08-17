/**
 * /poker — 5カードドロー ビデオポーカー（ジャックスオアベター形式）
 *
 * フロー:
 *   1. /poker play <bet> → 5枚配る (deal フェーズ)
 *   2. カードボタンをクリックでホールド/アンホールド切り替え
 *   3. "ドロー" ボタンでアンホールド牌を交換 → 役判定 → 結果表示
 *
 * カード画像はブラックジャックと同じ Object Storage 画像を使用。
 */

import Jimp from "jimp";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { and, eq, sql } from "drizzle-orm";
import { db, walletsTable } from "@workspace/db";
import { getGuildSettings, getOrCreateWallet, recordTransaction } from "../lib/economy";
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

interface PokerGame {
  guildId: string;
  userId: string;
  bet: number;
  hand: Card[];           // 5枚
  deck: Card[];
  held: boolean[];        // hand の各インデックスがホールド中か
  phase: "deal" | "done";
  currencyName: string;
  expiresAt: number;
  suitEmojis: SuitEmojis;
  /** キー: "rank:suit"（例 "A:spade"）、値: Object Storage のオブジェクト名（path）。 */
  cardPaths: Map<string, string>;
  /** カード画像のバッファキャッシュ。キー: "rank:suit"、値: Buffer。 */
  cardBuffers: Map<string, Buffer>;
}

type HandRank =
  | "royal_flush"
  | "straight_flush"
  | "four_of_a_kind"
  | "full_house"
  | "flush"
  | "straight"
  | "three_of_a_kind"
  | "two_pair"
  | "jacks_or_better"
  | "nothing";

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_BET = 10;
const MAX_BET = 100_000;
const GAME_TTL_MS = 5 * 60 * 1000;

const COLOR_NEUTRAL = 0x5865f2;
const COLOR_WIN     = 0x57f287;
const COLOR_LOSE    = 0xed4245;

export const POKER_PREFIX = "poker:";

const CARD_STRIP_HEIGHT = 90;

// 払い戻し倍率（ベット × 倍率 が純利益）
const PAYOUT: Record<HandRank, number> = {
  royal_flush:      250,
  straight_flush:    50,
  four_of_a_kind:    25,
  full_house:         9,
  flush:              6,
  straight:           4,
  three_of_a_kind:    3,
  two_pair:           2,
  jacks_or_better:    1,
  nothing:            0,
};

const HAND_LABEL: Record<HandRank, string> = {
  royal_flush:      "🏆 ロイヤルフラッシュ",
  straight_flush:   "✨ ストレートフラッシュ",
  four_of_a_kind:   "🎯 フォーオブアカインド",
  full_house:       "🏠 フルハウス",
  flush:            "💧 フラッシュ",
  straight:         "➡️ ストレート",
  three_of_a_kind:  "3️⃣ スリーオブアカインド",
  two_pair:         "✌️ ツーペア",
  jacks_or_better:  "🃏 ジャックスオアベター",
  nothing:          "❌ 役なし",
};

// ─── In-memory state ──────────────────────────────────────────────────────────

const activeGames = new Map<string, PokerGame>();

function gameKey(guildId: string, userId: string) { return `${guildId}:${userId}`; }

setInterval(() => {
  const now = Date.now();
  for (const [k, g] of activeGames) { if (g.expiresAt < now) activeGames.delete(k); }
}, 60_000);

// ─── Deck helpers ─────────────────────────────────────────────────────────────

function buildDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push({ rank, suit });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  return deck;
}

function draw(deck: Card[]): [Card, Card[]] { return [deck[0]!, deck.slice(1)]; }

// ─── Card display helpers ─────────────────────────────────────────────────────

function resolveSuitEmojis(settings: GuildSettings): SuitEmojis {
  return {
    "♠": settings.bjSuitSpade   ?? "♠️",
    "♥": settings.bjSuitHeart   ?? "♥️",
    "♦": settings.bjSuitDiamond ?? "♦️",
    "♣": settings.bjSuitClub    ?? "♣️",
  };
}

function fmtCard(c: Card, emojis: SuitEmojis): string {
  return `${c.rank}${emojis[c.suit]}`;
}

// ─── Card image helpers ───────────────────────────────────────────────────────

interface CardImage { attachment: AttachmentBuilder; filename: string }

async function cacheCardBuffer(
  card: Card,
  cardPaths: Map<string, string>,
  cardBuffers: Map<string, Buffer>,
): Promise<void> {
  const key = `${card.rank}:${SUIT_KEY[card.suit]}`;
  if (cardBuffers.has(key)) return;
  const path = cardPaths.get(key);
  if (!path) return;
  try {
    const buf = await downloadImageAsBuffer(path);
    if (buf) cardBuffers.set(key, buf);
  } catch { /* 失敗しても無視 */ }
}

async function cacheHandBuffers(
  hand: Card[],
  cardPaths: Map<string, string>,
  cardBuffers: Map<string, Buffer>,
): Promise<void> {
  await Promise.all(hand.map((card) => cacheCardBuffer(card, cardPaths, cardBuffers)));
}

async function mergeHorizontal(buffers: Buffer[]): Promise<Buffer> {
  const images = await Promise.all(buffers.map((b) => Jimp.read(b)));
  const targetH = Math.min(
    Math.max(...images.map((img) => img.bitmap.height)),
    CARD_STRIP_HEIGHT,
  );
  const resized = images.map((img) => {
    const ratio = targetH / img.bitmap.height;
    return img.resize(Math.round(img.bitmap.width * ratio), targetH, Jimp.RESIZE_BICUBIC);
  });
  const totalW = resized.reduce((sum, img) => sum + img.bitmap.width, 0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const canvas = new (Jimp as any)(totalW, targetH, 0x00000000);
  let x = 0;
  for (const img of resized) { canvas.composite(img, x, 0); x += img.bitmap.width; }
  return canvas.getBufferAsync(Jimp.MIME_PNG);
}

async function buildHandStrip(
  hand: Card[],
  cardBuffers: Map<string, Buffer>,
  filename: string,
): Promise<CardImage | null> {
  const buffers = hand
    .map((card) => cardBuffers.get(`${card.rank}:${SUIT_KEY[card.suit]}`) ?? null)
    .filter((b): b is Buffer => b !== null);
  if (buffers.length === 0) return null;
  try {
    const merged = await mergeHorizontal(buffers);
    return { attachment: new AttachmentBuilder(merged, { name: filename }), filename };
  } catch {
    return null;
  }
}

// ─── Hand evaluation ──────────────────────────────────────────────────────────

const RANK_ORDER: Record<Rank, number> = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7,
  "8": 8, "9": 9, "10": 10, J: 11, Q: 12, K: 13, A: 14,
};

function evaluate(hand: Card[]): HandRank {
  const vals = hand.map((c) => RANK_ORDER[c.rank]).sort((a, b) => a - b);
  const suits = hand.map((c) => c.suit);
  const isFlush = suits.every((s) => s === suits[0]);
  const isStraight =
    (vals[4]! - vals[0]! === 4 && new Set(vals).size === 5)
    || (vals.join(",") === "2,3,4,5,14"); // A ロー

  const rankCounts = new Map<number, number>();
  for (const v of vals) rankCounts.set(v, (rankCounts.get(v) ?? 0) + 1);
  const counts = [...rankCounts.values()].sort((a, b) => b - a);

  if (isFlush && isStraight && vals[0] === 10) return "royal_flush";
  if (isFlush && isStraight)                    return "straight_flush";
  if (counts[0] === 4)                          return "four_of_a_kind";
  if (counts[0] === 3 && counts[1] === 2)       return "full_house";
  if (isFlush)                                  return "flush";
  if (isStraight)                               return "straight";
  if (counts[0] === 3)                          return "three_of_a_kind";
  if (counts[0] === 2 && counts[1] === 2)       return "two_pair";
  if (counts[0] === 2) {
    const pairVal = [...rankCounts.entries()].find(([, n]) => n === 2)?.[0] ?? 0;
    if (pairVal >= 11) return "jacks_or_better";
  }
  return "nothing";
}

// ─── Balance helpers ──────────────────────────────────────────────────────────

async function deductBet(guildId: string, userId: string, bet: number) {
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

async function creditAmount(guildId: string, userId: string, amount: number) {
  const [row] = await db
    .update(walletsTable)
    .set({ balance: sql`${walletsTable.balance} + ${amount}` })
    .where(and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId)))
    .returning({ balance: walletsTable.balance });
  return row?.balance ?? 0;
}

// ─── UI builders ─────────────────────────────────────────────────────────────

function buildCardRows(hand: Card[], held: boolean[], emojis: SuitEmojis): ActionRowBuilder<ButtonBuilder>[] {
  const cardRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    hand.map((c, i) =>
      new ButtonBuilder()
        .setCustomId(`poker:hold:${i}`)
        .setLabel(held[i] ? `🔒 ${fmtCard(c, emojis)}` : fmtCard(c, emojis))
        .setStyle(held[i] ? ButtonStyle.Success : ButtonStyle.Secondary),
    ),
  );
  const drawRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("poker:draw")
      .setLabel("ドロー")
      .setEmoji("🃏")
      .setStyle(ButtonStyle.Primary),
  );
  return [cardRow, drawRow];
}

async function buildDealContent(game: PokerGame): Promise<{ embeds: EmbedBuilder[]; files: AttachmentBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] }> {
  const heldCount = game.held.filter(Boolean).length;
  const holdDesc = heldCount === 0
    ? "カードをクリックしてホールド、「ドロー」で残りを交換"
    : `${heldCount}枚ホールド中`;

  const cardImage = await buildHandStrip(game.hand, game.cardBuffers, "hand.png");

  const embed = new EmbedBuilder()
    .setTitle("🃏 ポーカー — カードを選んでドロー")
    .setColor(COLOR_NEUTRAL)
    .addFields(
      { name: "賭け金", value: `**${game.bet.toLocaleString()}** ${game.currencyName}`, inline: true },
      { name: "状態",   value: holdDesc, inline: true },
    )
    .setFooter({ text: "役・配当: J以上ペア×1 | 2ペア×2 | スリー×3 | ストレート×4 | フラッシュ×6 | フルハウス×9 | フォーカ×25 | SF×50 | RF×250 | 5分でタイムアウト" });

  if (cardImage) embed.setImage(`attachment://${cardImage.filename}`);

  return {
    embeds: [embed],
    files: cardImage ? [cardImage.attachment] : [],
    components: buildCardRows(game.hand, game.held, game.suitEmojis),
  };
}

async function buildResultContent(game: PokerGame, handRank: HandRank, netDelta: number): Promise<{ embeds: EmbedBuilder[]; files: AttachmentBuilder[] }> {
  const multiplier = PAYOUT[handRank];
  const isWin = multiplier > 0;
  const sign = netDelta > 0 ? "+" : "";

  const cardImage = await buildHandStrip(game.hand, game.cardBuffers, "result.png");

  const embed = new EmbedBuilder()
    .setTitle(`🃏 ポーカー — ${HAND_LABEL[handRank]}`)
    .setColor(isWin ? COLOR_WIN : COLOR_LOSE)
    .addFields(
      { name: "収支",   value: `${sign}${netDelta.toLocaleString()} ${game.currencyName}`, inline: true },
      ...(multiplier > 0 ? [{ name: "倍率", value: `${multiplier}x`, inline: true }] : []),
    )
    .setTimestamp();

  if (cardImage) embed.setImage(`attachment://${cardImage.filename}`);

  return {
    embeds: [embed],
    files: cardImage ? [cardImage.attachment] : [],
  };
}

// ─── Finish game ──────────────────────────────────────────────────────────────

async function finishGame(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  game: PokerGame,
): Promise<void> {
  const handRank = evaluate(game.hand);
  const multiplier = PAYOUT[handRank];
  const { guildId, userId, bet } = game;

  // ドロー後のカードをキャッシュに追加
  await cacheHandBuffers(game.hand, game.cardPaths, game.cardBuffers);

  let netDelta: number;
  if (multiplier === 0) {
    netDelta = -bet;
  } else {
    const winnings = bet * multiplier;
    await creditAmount(guildId, userId, bet + winnings);
    netDelta = winnings;
  }

  if (netDelta !== 0) {
    const reason = `ポーカー ${HAND_LABEL[handRank]}（賭け: ${bet}）`;
    await recordTransaction(guildId, userId, netDelta, reason).catch(() => {});
  }

  activeGames.delete(gameKey(guildId, userId));

  const { embeds, files } = await buildResultContent(game, handRank, netDelta);
  await interaction.editReply({ embeds, files, components: [] });
}

// ─── Button handler ───────────────────────────────────────────────────────────

export async function handlePokerButton(interaction: ButtonInteraction): Promise<void> {
  const { guildId, user } = interaction;
  if (!guildId) return;

  const key = gameKey(guildId, user.id);
  const game = activeGames.get(key);

  if (!game || game.expiresAt < Date.now()) {
    activeGames.delete(key);
    await interaction.reply({
      content: "ゲームが見つかりません（タイムアウトの可能性あり）。`/poker play` で新しいゲームを始めてください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (game.userId !== user.id) {
    await interaction.reply({ content: "このゲームはあなたのものではありません。", flags: MessageFlags.Ephemeral });
    return;
  }

  if (game.phase === "done") {
    await interaction.deferUpdate();
    return;
  }

  await interaction.deferUpdate();

  const action = interaction.customId.slice(POKER_PREFIX.length);

  if (action.startsWith("hold:")) {
    const idx = parseInt(action.slice(5), 10);
    if (idx >= 0 && idx < 5) {
      game.held[idx] = !game.held[idx];
      activeGames.set(key, game);
      const { embeds, files, components } = await buildDealContent(game);
      await interaction.editReply({ embeds, files, components });
    }
    return;
  }

  if (action === "draw") {
    let { deck } = game;
    const newCards: Card[] = [];
    for (let i = 0; i < 5; i++) {
      if (!game.held[i]) {
        const [card, rest] = draw(deck);
        game.hand[i] = card;
        newCards.push(card);
        deck = rest;
      }
    }
    game.deck = deck;
    game.phase = "done";
    activeGames.set(key, game);
    await finishGame(interaction, game);
  }
}

// ─── /poker play ──────────────────────────────────────────────────────────────

async function handlePlay(interaction: ChatInputCommandInteraction): Promise<void> {
  const { guildId } = interaction;
  if (!guildId) return;
  const userId = interaction.user.id;
  const bet = interaction.options.getInteger("bet", true);

  const key = gameKey(guildId, userId);
  if (activeGames.has(key)) {
    await interaction.reply({
      content: "すでにゲームが進行中です。先のゲームを終わらせてください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();

  const [, settings, cardPathsRaw] = await Promise.all([
    getOrCreateWallet(guildId, userId),
    getGuildSettings(guildId),
    getBjCardImages(guildId),
  ]);

  const { currencyName } = settings;
  const maxBet = settings.casinoMaxBet ?? CASINO_DEFAULT_MAX_BET;
  if (bet > maxBet) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("🃏 ポーカー")
          .setDescription(`❌ 賭け金が上限（**${maxBet.toLocaleString()}** ${currencyName}）を超えています。`)
          .setColor(COLOR_LOSE),
      ],
    });
    return;
  }

  const afterDeduct = await deductBet(guildId, userId, bet);
  if (!afterDeduct) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("🃏 ポーカー")
          .setDescription("❌ 残高が不足しています。")
          .setColor(COLOR_LOSE),
      ],
    });
    return;
  }

  const cardPaths = cardPathsRaw;
  const suitEmojis = resolveSuitEmojis(settings);

  let deck = buildDeck();
  const hand: Card[] = [];
  for (let i = 0; i < 5; i++) {
    const [card, rest] = draw(deck);
    hand.push(card);
    deck = rest;
  }

  const cardBuffers = new Map<string, Buffer>();
  await cacheHandBuffers(hand, cardPaths, cardBuffers);

  const game: PokerGame = {
    guildId,
    userId,
    bet,
    hand,
    deck,
    held: [false, false, false, false, false],
    phase: "deal",
    currencyName,
    expiresAt: Date.now() + GAME_TTL_MS,
    suitEmojis,
    cardPaths,
    cardBuffers,
  };

  activeGames.set(key, game);

  const { embeds, files, components } = await buildDealContent(game);
  await interaction.editReply({ embeds, files, components });
}

// ─── Command export ───────────────────────────────────────────────────────────

export const pokerCommand = {
  data: new SlashCommandBuilder()
    .setName("poker")
    .setDescription("5カードドロー — ホールドしてドロー、役で最大250倍！")
    .setDefaultMemberPermissions(0)
    .addIntegerOption((opt) =>
      opt
        .setName("bet")
        .setDescription(`賭け金（${MIN_BET}〜${MAX_BET.toLocaleString()}）`)
        .setMinValue(MIN_BET)
        .setMaxValue(MAX_BET)
        .setRequired(true),
    ),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await handlePlay(interaction);
  },
};
