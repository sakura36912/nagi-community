/**
 * /blackjack — ブラックジャック
 * ヒット・スタンド対応。6デッキシュー。
 *
 * サブコマンド:
 *   play          : ゲームを開始する
 *   config suit   : スート絵文字を設定する（管理者専用）
 *   config card   : カード画像を登録する（管理者専用）
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
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { and, eq, sql } from "drizzle-orm";
import { db, walletsTable } from "@workspace/db";
import { getGuildSettings, recordTransaction, getOrCreateWallet, setBjSuitEmoji } from "../lib/economy";
import { CASINO_DEFAULT_MAX_BET } from "./casino";
import { getBjCardImages, setBjCardImage, deleteBjCardImage } from "../lib/bjCardImages";
import { uploadImageFromUrl, downloadImageAsBuffer, deleteGcsObject } from "../lib/gcsStorage";
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

interface BJGame {
  guildId: string;
  userId: string;
  bet: number;
  playerHand: Card[];
  dealerHand: Card[];
  deck: Card[];
  currencyName: string;
  balance: number;
  expiresAt: number;
  suitEmojis: SuitEmojis;
  /** キー: "rank:suit"（例 "A:spade"）、値: Object Storage のオブジェクト名（path）。 */
  cardPaths: Map<string, string>;
  /**
   * カード画像のバッファキャッシュ。
   * キー: "rank:suit"、値: ダウンロード済み Buffer。
   * ヒットのたびに Storage を叩かず、ここから読む。
   */
  cardBuffers: Map<string, Buffer>;
  /** true の間はボタン操作を受け付けない（ヒット処理中の二重押し防止） */
  processing: boolean;
  /** セッション開始からこのゲーム開始時点までの累計収支 */
  sessionDeltaBefore: number;
  /** セッション内のゲーム回数（このゲーム開始時点） */
  sessionGamesBefore: number;
}

type Outcome = "blackjack" | "win" | "push" | "lose";

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_BET = 1000;
const MAX_BET = 10_000;
const GAME_TTL_MS = 5 * 60 * 1000;

const COLOR_NEUTRAL = 0x5865f2;
const COLOR_WIN     = 0x57f287;
const COLOR_LOSE    = 0xed4245;
const COLOR_PUSH    = 0xfee75c;

export const BJ_PREFIX = "bj:";

// ─── In-memory state ──────────────────────────────────────────────────────────

const activeGames = new Map<string, BJGame>();

interface PendingReplay {
  bet: number;
  cardPaths: Map<string, string>;
  currencyName: string;
  suitEmojis: SuitEmojis;
  expiresAt: number;
  /** セッション開始からの累計収支 */
  sessionDelta: number;
  /** セッション内のゲーム回数 */
  sessionGames: number;
}
const pendingReplay = new Map<string, PendingReplay>();
/** replay ボタンの二重押し防止用 */
const processingReplay = new Set<string>();

function gameKey(guildId: string, userId: string) { return `${guildId}:${userId}`; }

setInterval(() => {
  const now = Date.now();
  for (const [key, game] of activeGames)    { if (game.expiresAt < now) activeGames.delete(key); }
  for (const [key, pr]   of pendingReplay)  { if (pr.expiresAt   < now) pendingReplay.delete(key); }
}, 60_000);

// ─── Suit emoji helpers ───────────────────────────────────────────────────────

function resolveSuitEmojis(settings: GuildSettings): SuitEmojis {
  return {
    "♠": settings.bjSuitSpade   ?? "♠️",
    "♥": settings.bjSuitHeart   ?? "♥️",
    "♦": settings.bjSuitDiamond ?? "♦️",
    "♣": settings.bjSuitClub    ?? "♣️",
  };
}

// ─── Card image helpers ───────────────────────────────────────────────────────

interface CardImage { attachment: AttachmentBuilder; filename: string }

/** 1枚のカード画像を Object Storage から取得する（失敗時 null） */
async function fetchOneCardImage(
  card: Card,
  cardPaths: Map<string, string>,
  filenameBase: string,
): Promise<CardImage | null> {
  const key  = `${card.rank}:${SUIT_KEY[card.suit]}`;
  const path = cardPaths.get(key);
  if (!path) return null;
  try {
    const buffer = await downloadImageAsBuffer(path);
    if (!buffer) return null;
    const ext      = path.split(".").pop() ?? "png";
    const filename = `${filenameBase}.${ext}`;
    return { attachment: new AttachmentBuilder(buffer, { name: filename }), filename };
  } catch {
    return null;
  }
}

/** 手札のカード画像を並行取得する */
async function fetchHandImages(
  hand: Card[],
  cardPaths: Map<string, string>,
  prefix: string,
): Promise<(CardImage | null)[]> {
  return Promise.all(hand.map((card, i) => fetchOneCardImage(card, cardPaths, `${prefix}_${i}`)));
}

/** カードストリップの表示高さ（px） */
const CARD_STRIP_HEIGHT = 90;

/**
 * 複数の画像バッファを縦横比を保ったまま同じ高さに揃え、横一列に合成する。
 */
async function mergeHorizontal(buffers: Buffer[]): Promise<Buffer> {
  const images = await Promise.all(buffers.map((b) => Jimp.read(b)));
  const targetH = Math.min(
    Math.max(...images.map((img) => img.bitmap.height)),
    CARD_STRIP_HEIGHT,
  );
  const resized  = images.map((img) => {
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

/**
 * カード1枚のバッファをキャッシュに追加する（未登録 or 取得失敗は無視）。
 */
async function cacheCardBuffer(
  card: Card,
  cardPaths: Map<string, string>,
  cardBuffers: Map<string, Buffer>,
): Promise<void> {
  const key = `${card.rank}:${SUIT_KEY[card.suit]}`;
  if (cardBuffers.has(key)) return; // 既にキャッシュ済み
  const path = cardPaths.get(key);
  if (!path) return;
  try {
    const buf = await downloadImageAsBuffer(path);
    if (buf) cardBuffers.set(key, buf);
  } catch { /* 失敗しても無視 */ }
}

/**
 * 手札全カードのバッファをキャッシュに並行取得する。
 */
async function cacheHandBuffers(
  hand: Card[],
  cardPaths: Map<string, string>,
  cardBuffers: Map<string, Buffer>,
): Promise<void> {
  await Promise.all(hand.map((card) => cacheCardBuffer(card, cardPaths, cardBuffers)));
}

/**
 * キャッシュ済みバッファから手札画像を横一列に合成して返す。
 * 画像が1枚も取得されていない場合は null を返す。
 */
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

function cardPoints(rank: Rank): number {
  if (rank === "A") return 11;
  if (["J", "Q", "K"].includes(rank)) return 10;
  return parseInt(rank, 10);
}

function total(hand: Card[]): number {
  let sum = hand.reduce((s, c) => s + cardPoints(c.rank), 0);
  let aces = hand.filter((c) => c.rank === "A").length;
  while (sum > 21 && aces > 0) { sum -= 10; aces--; }
  return sum;
}

const isBust      = (hand: Card[]) => total(hand) > 21;
const isBlackjack = (hand: Card[]) => hand.length === 2 && total(hand) === 21;

function formatCard(c: Card, emojis: SuitEmojis) { return `${c.rank}${emojis[c.suit]}`; }
function formatHand(hand: Card[], emojis: SuitEmojis, hideSecond = false) {
  return hand.map((c, i) => (hideSecond && i === 1 ? "🎴" : formatCard(c, emojis))).join(" ");
}

// ─── Balance helpers ──────────────────────────────────────────────────────────

async function deductBet(guildId: string, userId: string, bet: number): Promise<{ balance: number } | null> {
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

async function creditAmount(guildId: string, userId: string, amount: number): Promise<number> {
  const [row] = await db
    .update(walletsTable)
    .set({ balance: sql`${walletsTable.balance} + ${amount}` })
    .where(and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId)))
    .returning({ balance: walletsTable.balance });
  return row?.balance ?? 0;
}

// ─── Embeds ───────────────────────────────────────────────────────────────────

type EmbedWithFiles = { embeds: EmbedBuilder[]; files: AttachmentBuilder[] };

/**
 * Discord の embed 上限（1メッセージあたり最大 10）を超えないようカード embed を追加する。
 * 同じ url を持つ embed は Discord がギャラリー形式（格子）でグループ化するため、
 * 画像を小さく横並びで表示できる。
 */
const GALLERY_URL = "https://discord.com";

function appendCardEmbeds(
  embeds: EmbedBuilder[],
  files: AttachmentBuilder[],
  images: (CardImage | null)[],
  maxEmbeds = 10,
): void {
  for (const img of images) {
    if (!img) continue;
    if (embeds.length >= maxEmbeds) break;
    embeds.push(
      new EmbedBuilder()
        .setURL(GALLERY_URL)
        .setImage(`attachment://${img.filename}`),
    );
    files.push(img.attachment);
  }
}

/**
 * ゲーム中の embed を生成する。
 * 手札画像が登録されていれば横一列に合成して embed 上部に表示する。
 * 未登録のカードはテキストにフォールバック。
 */
async function buildGameEmbed(game: BJGame, hideDealer = true): Promise<EmbedWithFiles> {
  const pTotal = total(game.playerHand);
  const dKnown = total([game.dealerHand[0]!]);
  const e      = game.suitEmojis;

  const dealerVisible = hideDealer ? [game.dealerHand[0]!] : game.dealerHand;

  // プレイヤー・ディーラーの手札ストリップ画像を並行生成（キャッシュ済みバッファを使用）
  const [playerStrip, dealerStrip] = await Promise.all([
    buildHandStrip(game.playerHand, game.cardBuffers, "player.png"),
    buildHandStrip(dealerVisible,   game.cardBuffers, "dealer.png"),
  ]);

  const playerValue = playerStrip
    ? `**${pTotal}**`
    : `${formatHand(game.playerHand, e)}　**${pTotal}**`;
  const dealerValue = hideDealer
    ? (dealerStrip ? `🎴　（${dKnown}+?）` : `${formatHand(game.dealerHand, e, true)}　（${dKnown}+?）`)
    : (dealerStrip ? `**${total(game.dealerHand)}**` : `${formatHand(game.dealerHand, e)}　**${total(game.dealerHand)}**`);

  const mainEmbed = new EmbedBuilder()
    .setTitle("🃏 ブラックジャック")
    .setColor(COLOR_NEUTRAL)
    .addFields(
      { name: "あなたの手札", value: playerValue },
      { name: "ディーラーの手札", value: dealerValue },
      {
        name: "賭け金",
        value: `**${game.bet.toLocaleString()}** ${game.currencyName}`,
        inline: true,
      },
      { name: "操作方法", value: "🃏 **ヒット** — 1枚追加　🛑 **スタンド** — このままで勝負" },
    )
    .setFooter({ text: "BJ=1.5倍 / 通常勝利=1倍 / 引き分け=返金 | 5分でタイムアウト" });

  // カード画像（横一列合成）をメイン embed の前（上部）に配置
  // setTitle でラベルを画像上部に表示する
  const embeds: EmbedBuilder[] = [];
  const files: AttachmentBuilder[] = [];

  if (playerStrip) {
    embeds.push(new EmbedBuilder().setTitle("自分").setImage(`attachment://player.png`));
    files.push(playerStrip.attachment);
  }
  if (dealerStrip) {
    embeds.push(new EmbedBuilder().setTitle("ディーラー").setImage(`attachment://dealer.png`));
    files.push(dealerStrip.attachment);
  }
  embeds.push(mainEmbed);

  return { embeds, files };
}

/**
 * 結果表示用の embed を生成する。
 */
async function buildResultEmbed(game: BJGame, outcome: Outcome): Promise<EmbedWithFiles> {
  const TITLE: Record<Outcome, string> = {
    blackjack: "🎉 ブラックジャック！",
    win:       "✅ 勝利！",
    push:      "🤝 引き分け（プッシュ）",
    lose:      "❌ 敗北",
  };
  const COLOR: Record<Outcome, number> = {
    blackjack: COLOR_WIN, win: COLOR_WIN, push: COLOR_PUSH, lose: COLOR_LOSE,
  };
  const { netDelta } = resolveOutcome(game);
  const sign = netDelta > 0 ? "+" : "";
  const e    = game.suitEmojis;

  const [playerStrip, dealerStrip] = await Promise.all([
    buildHandStrip(game.playerHand, game.cardBuffers, "player.png"),
    buildHandStrip(game.dealerHand, game.cardBuffers, "dealer.png"),
  ]);

  const playerValue = playerStrip
    ? `**${total(game.playerHand)}**`
    : `${formatHand(game.playerHand, e)}　**${total(game.playerHand)}**`;
  const dealerValue = dealerStrip
    ? `**${total(game.dealerHand)}**`
    : `${formatHand(game.dealerHand, e)}　**${total(game.dealerHand)}**`;

  const mainEmbed = new EmbedBuilder()
    .setTitle(`🃏 ブラックジャック — ${TITLE[outcome]}`)
    .setColor(COLOR[outcome])
    .addFields(
      { name: "あなたの手札",     value: playerValue },
      { name: "ディーラーの手札", value: dealerValue },
      { name: "収支", value: `${sign}${netDelta.toLocaleString()} ${game.currencyName}`, inline: true },
    )
    .setTimestamp();

  const embeds: EmbedBuilder[] = [];
  const files: AttachmentBuilder[] = [];

  if (playerStrip) {
    embeds.push(new EmbedBuilder().setTitle("自分").setImage(`attachment://player.png`));
    files.push(playerStrip.attachment);
  }
  if (dealerStrip) {
    embeds.push(new EmbedBuilder().setTitle("ディーラー").setImage(`attachment://dealer.png`));
    files.push(dealerStrip.attachment);
  }
  embeds.push(mainEmbed);

  return { embeds, files };
}

// ─── Buttons ──────────────────────────────────────────────────────────────────

function buildButtons(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("bj:hit").setLabel("ヒット").setEmoji("🃏").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("bj:stand").setLabel("スタンド").setEmoji("🛑").setStyle(ButtonStyle.Secondary),
  );
}

function buildResultButtons(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("bj:replay").setLabel("もう一度").setEmoji("🔄").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("bj:quit").setLabel("終了").setEmoji("✋").setStyle(ButtonStyle.Secondary),
  );
}

// ─── Game logic ───────────────────────────────────────────────────────────────

function dealerPlay(game: BJGame): BJGame {
  let { dealerHand, deck } = game;
  while (total(dealerHand) < 17) {
    const [card, rest] = draw(deck);
    dealerHand = [...dealerHand, card]; deck = rest;
  }
  return { ...game, dealerHand, deck };
}

function resolveOutcome(game: BJGame): { outcome: Outcome; netDelta: number } {
  const pTotal = total(game.playerHand);
  const dTotal = total(game.dealerHand);
  const pBJ = isBlackjack(game.playerHand);
  const dBJ = isBlackjack(game.dealerHand);

  if (pBJ && dBJ)                                return { outcome: "push",      netDelta: 0 };
  if (pBJ)                                       return { outcome: "blackjack",  netDelta: Math.floor(game.bet * 1.5) };
  if (dBJ)                                       return { outcome: "lose",       netDelta: -game.bet };
  if (isBust(game.playerHand))                   return { outcome: "lose",       netDelta: -game.bet };
  if (isBust(game.dealerHand) || pTotal > dTotal) return { outcome: "win",       netDelta: game.bet };
  if (pTotal === dTotal)                          return { outcome: "push",       netDelta: 0 };
  return { outcome: "lose", netDelta: -game.bet };
}

async function finishGame(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  game: BJGame,
): Promise<void> {
  const { outcome, netDelta } = resolveOutcome(game);
  const { guildId, userId, bet } = game;

  let finalBalance = game.balance;
  if (outcome === "push")       finalBalance = await creditAmount(guildId, userId, bet);
  else if (outcome === "blackjack") finalBalance = await creditAmount(guildId, userId, bet + netDelta);
  else if (outcome === "win")   finalBalance = await creditAmount(guildId, userId, bet + netDelta);

  const logReason: Record<Outcome, string> = {
    blackjack: `BJ（賭け: ${bet}）`, win: `BJ勝利（賭け: ${bet}）`,
    push: `BJ引き分け（賭け: ${bet}）`, lose: `BJ敗北（賭け: ${bet}）`,
  };
  // push (netDelta === 0) も記録することで /casino stats のプレイ回数・賭け金集計に含める
  await recordTransaction(guildId, userId, netDelta, logReason[outcome]).catch(() => {});

  const key = gameKey(guildId, userId);
  activeGames.delete(key);

  // セッション累計を引き継ぐ（ゲームオブジェクトに開始前の累計を持たせている）
  const sessionDelta = game.sessionDeltaBefore + netDelta;
  const sessionGames = game.sessionGamesBefore + 1;

  const replayBet = game.bet;
  pendingReplay.set(key, {
    bet: replayBet,
    cardPaths: game.cardPaths,
    currencyName: game.currencyName,
    suitEmojis: game.suitEmojis,
    expiresAt: Date.now() + GAME_TTL_MS,
    sessionDelta,
    sessionGames,
  });

  // dealerPlay で引いた新しいカードをキャッシュに追加（結果画面で画像表示するため）
  await cacheHandBuffers(game.dealerHand, game.cardPaths, game.cardBuffers);
  const { embeds, files } = await buildResultEmbed(game, outcome);
  await interaction.editReply({ content: "", embeds, files, components: [buildResultButtons()] });
}

// ─── Button handler ───────────────────────────────────────────────────────────

export async function handleBlackjackButton(interaction: ButtonInteraction): Promise<void> {
  const { guildId, user } = interaction;
  if (!guildId) return;

  const key    = gameKey(guildId, user.id);
  const action = interaction.customId.slice(BJ_PREFIX.length);

  // ─── replay / quit は activeGames にゲームがない状態で呼ばれる ───────────────
  if (action === "replay") {
    // 二重押し防止: すでに処理中なら無視
    if (processingReplay.has(key)) {
      await interaction.deferUpdate();
      return;
    }
    processingReplay.add(key);
    await interaction.deferUpdate();
    const pr = pendingReplay.get(key);
    pendingReplay.delete(key);

    if (!pr || pr.expiresAt < Date.now()) {
      processingReplay.delete(key);
      await interaction.editReply({ components: [] });
      return;
    }

    const afterDeduct = await deductBet(guildId, user.id, pr.bet);
    if (!afterDeduct) {
      processingReplay.delete(key);
      await interaction.editReply({ components: [] });
      await interaction.followUp({
        content: `❌ 残高が不足しているためリプレイできません（賭け金: **${pr.bet.toLocaleString()}** ${pr.currencyName}）。`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    let deck = buildShoe();
    let playerHand: Card[] = [], dealerHand: Card[] = [], card: Card;
    [card, deck] = draw(deck); playerHand = [...playerHand, card];
    [card, deck] = draw(deck); dealerHand = [...dealerHand, card];
    [card, deck] = draw(deck); playerHand = [...playerHand, card];
    [card, deck] = draw(deck); dealerHand = [...dealerHand, card];

    const cardBuffers = new Map<string, Buffer>();
    await cacheHandBuffers([...playerHand, ...dealerHand], pr.cardPaths, cardBuffers);

    const newGame: BJGame = {
      guildId, userId: user.id, bet: pr.bet, playerHand, dealerHand, deck,
      currencyName: pr.currencyName,
      balance: afterDeduct.balance, expiresAt: Date.now() + GAME_TTL_MS,
      suitEmojis: pr.suitEmojis, cardPaths: pr.cardPaths, cardBuffers, processing: false,
      sessionDeltaBefore: pr.sessionDelta,
      sessionGamesBefore: pr.sessionGames,
    };

    if (isBlackjack(playerHand)) {
      processingReplay.delete(key);
      await finishGame(interaction, dealerPlay(newGame));
      return;
    }

    activeGames.set(key, newGame);
    processingReplay.delete(key);
    const { embeds, files } = await buildGameEmbed(newGame, true);
    await interaction.editReply({ content: "", embeds, files, components: [buildButtons()] });
    return;
  }

  if (action === "quit") {
    const pr = pendingReplay.get(key);
    pendingReplay.delete(key);
    await interaction.update({ components: [] });
    // セッション収支をフォローアップで表示（1ゲーム以上プレイ済みの場合）
    if (pr && pr.sessionGames > 0) {
      const sign  = pr.sessionDelta >= 0 ? "+" : "";
      const color = pr.sessionDelta >= 0 ? 0x57f287 : 0xed4245;
      const embed = new EmbedBuilder()
        .setTitle("🃏 ブラックジャック — セッション終了")
        .setColor(color)
        .addFields(
          { name: "プレイ回数", value: `${pr.sessionGames} 回`,                                          inline: true },
          { name: "合計収支",   value: `${sign}${pr.sessionDelta.toLocaleString()} ${pr.currencyName}`, inline: true },
        );
      await interaction.followUp({ embeds: [embed] });
    }
    return;
  }

  // ─── hit / stand / double は activeGames にゲームが必要 ─────────────────────
  const game = activeGames.get(key);

  if (!game || game.expiresAt < Date.now()) {
    activeGames.delete(key);
    await interaction.update({
      content: "⏱️ ゲームがタイムアウトまたはリセットされました。`/blackjack play` で新しいゲームを始めてください。",
      embeds: [],
      files: [],
      components: [],
    });
    return;
  }
  if (game.userId !== user.id) {
    await interaction.reply({ content: "このゲームはあなたのものではありません。", flags: MessageFlags.Ephemeral });
    return;
  }

  // ヒット処理中の二重押しを無視
  if (game.processing) {
    await interaction.deferUpdate();
    return;
  }

  await interaction.deferUpdate();

  if (action === "hit") {
    // 処理中フラグを立てて即 Map に反映（二重押し防止）
    game.processing = true;
    activeGames.set(key, game);

    // 現在の手札画像を維持したまま「更新中」を表示
    const { embeds: curEmbeds, files: curFiles } = await buildGameEmbed(game, true);
    await interaction.editReply({ content: "🔄 更新中...", embeds: curEmbeds, files: curFiles, components: [] });

    const [card, newDeck] = draw(game.deck);
    game.playerHand = [...game.playerHand, card];
    game.deck = newDeck;
    // 新しく引いたカード1枚のみ追加取得（既存カードはキャッシュ済み）
    await cacheCardBuffer(card, game.cardPaths, game.cardBuffers);

    if (isBust(game.playerHand) || total(game.playerHand) === 21) {
      await finishGame(interaction, dealerPlay(game));
      return;
    }

    game.processing = false;
    activeGames.set(key, game);

    const { embeds, files } = await buildGameEmbed(game, true);
    await interaction.editReply({ content: "", embeds, files, components: [buildButtons()] });

  } else if (action === "stand") {
    game.processing = true;
    activeGames.set(key, game);
    const { embeds: curEmbeds, files: curFiles } = await buildGameEmbed(game, true);
    await interaction.editReply({ content: "🔄 更新中...", embeds: curEmbeds, files: curFiles, components: [] });
    await finishGame(interaction, dealerPlay(game));

  } else if (action === "quit") {
    pendingReplay.delete(key);
    await interaction.update({ components: [] });
  }
}

// ─── /blackjack play ──────────────────────────────────────────────────────────

async function handlePlay(interaction: ChatInputCommandInteraction): Promise<void> {
  const { guildId } = interaction;
  if (!guildId) return;
  const userId = interaction.user.id;
  const bet = interaction.options.getInteger("bet", true);

  const key = gameKey(guildId, userId);
  if (activeGames.has(key)) {
    await interaction.reply({ content: "すでにゲームが進行中です。先のゲームを終わらせてください。", flags: MessageFlags.Ephemeral });
    return;
  }

  // DB 処理が 3 秒を超える可能性があるため、先に defer して Discord タイムアウトを防ぐ
  await interaction.deferReply();

  const [, settings, rawCardImages] = await Promise.all([
    getOrCreateWallet(guildId, userId),
    getGuildSettings(guildId),
    getBjCardImages(guildId),
  ]);

  const maxBet = settings.casinoMaxBet ?? CASINO_DEFAULT_MAX_BET;
  if (bet > maxBet) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("🃏 ブラックジャック")
          .setDescription(`❌ 賭け金が上限（**${maxBet.toLocaleString()}** ${settings.currencyName}）を超えています。`)
          .setColor(COLOR_LOSE),
      ],
    });
    return;
  }

  const suitEmojis = resolveSuitEmojis(settings);
  const cardPaths = rawCardImages;

  const afterDeduct = await deductBet(guildId, userId, bet);
  if (!afterDeduct) {
    await interaction.editReply({
      embeds: [new EmbedBuilder().setTitle("🃏 ブラックジャック").setDescription("❌ 残高が不足しています。").setColor(COLOR_LOSE)],
    });
    return;
  }

  let deck = buildShoe();
  let playerHand: Card[] = [], dealerHand: Card[] = [], card: Card;
  [card, deck] = draw(deck); playerHand = [...playerHand, card];
  [card, deck] = draw(deck); dealerHand = [...dealerHand, card];
  [card, deck] = draw(deck); playerHand = [...playerHand, card];
  [card, deck] = draw(deck); dealerHand = [...dealerHand, card];

  // 初期4枚の画像をゲーム開始時にまとめてキャッシュ（以降 Storage を叩かない）
  const cardBuffers = new Map<string, Buffer>();
  await cacheHandBuffers([...playerHand, ...dealerHand], cardPaths, cardBuffers);

  const game: BJGame = {
    guildId, userId, bet, playerHand, dealerHand, deck,
    currencyName: settings.currencyName,
    balance: afterDeduct.balance, expiresAt: Date.now() + GAME_TTL_MS,
    suitEmojis, cardPaths, cardBuffers, processing: false,
    sessionDeltaBefore: 0, sessionGamesBefore: 0,
  };

  if (isBlackjack(playerHand)) {
    await finishGame(interaction, dealerPlay(game));
    return;
  }

  activeGames.set(key, game);
  const { embeds, files } = await buildGameEmbed(game, true);
  await interaction.editReply({ embeds, files, components: [buildButtons()] });
}

// ─── /blackjack config suit ───────────────────────────────────────────────────

const SUIT_LABEL: Record<string, string> = {
  spade: "♠️ スペード", heart: "♥️ ハート", diamond: "♦️ ダイヤ", club: "♣️ クラブ",
};
const SUIT_CHOICES = [
  { name: "♠️ スペード", value: "spade" }, { name: "♥️ ハート", value: "heart" },
  { name: "♦️ ダイヤ", value: "diamond" }, { name: "♣️ クラブ", value: "club" },
];
const RANK_CHOICES = RANKS.map((r) => ({ name: r, value: r }));

async function handleConfigSuit(interaction: ChatInputCommandInteraction): Promise<void> {
  const { guildId } = interaction;
  if (!guildId) return;
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "❌ 管理者専用です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const suit  = interaction.options.getString("suit", true) as "spade" | "heart" | "diamond" | "club";
  const emoji = interaction.options.getString("emoji")?.trim() || null;
  await setBjSuitEmoji(guildId, suit, emoji);
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("🃏 ブラックジャック — スート絵文字設定")
        .setColor(COLOR_NEUTRAL)
        .addFields({ name: SUIT_LABEL[suit] ?? suit, value: `→ ${emoji ?? "デフォルト（Unicode絵文字）"}` })
        .setFooter({ text: emoji ? "次回ゲームから反映されます" : "デフォルトにリセットしました" }),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

// ─── /blackjack config card ───────────────────────────────────────────────────

async function handleConfigCard(interaction: ChatInputCommandInteraction): Promise<void> {
  const { guildId } = interaction;
  if (!guildId) return;
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "❌ 管理者専用です。", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const rank       = interaction.options.getString("rank", true);
  const suit       = interaction.options.getString("suit", true);
  const attachment = interaction.options.getAttachment("image", true);

  if (!attachment.contentType?.startsWith("image/")) {
    await interaction.editReply("❌ 画像ファイルを添付してください（PNG / JPG / GIF）。");
    return;
  }

  const extMap: Record<string, string> = {
    "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
  };
  const ext        = extMap[attachment.contentType] ?? "png";
  const objectName = `bj-cards/${guildId}/${suit}/${rank}.${ext}`;

  try {
    await uploadImageFromUrl(attachment.url, objectName, attachment.contentType);
  } catch (err) {
    await interaction.editReply(`❌ 画像のアップロードに失敗しました: ${String(err)}`);
    return;
  }

  // objectName を image_url カラムに保存（URLではなくストレージパス）
  await setBjCardImage(guildId, rank, suit, objectName);

  const suitLabel = SUIT_LABEL[suit] ?? suit;
  // 確認用に画像を添付して返信
  const imgBuf    = await downloadImageAsBuffer(objectName);
  const files     = imgBuf ? [new AttachmentBuilder(imgBuf, { name: `card.${ext}` })] : [];
  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle("🃏 ブラックジャック — カード画像設定")
        .setColor(COLOR_NEUTRAL)
        .setDescription(`**${rank} ${suitLabel}** の画像を登録しました`)
        .setImage(files.length ? `attachment://card.${ext}` : null)
        .setFooter({ text: "次回ゲームから反映されます" }),
    ],
    files,
  });
}

// ─── /blackjack config list ───────────────────────────────────────────────────

const SUIT_DISPLAY: Record<string, string> = {
  spade: "♠️ スペード", heart: "♥️ ハート", diamond: "♦️ ダイヤ", club: "♣️ クラブ",
};

async function handleConfigList(interaction: ChatInputCommandInteraction): Promise<void> {
  const { guildId } = interaction;
  if (!guildId) return;
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "❌ 管理者専用です。", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const cardImages = await getBjCardImages(guildId);

  const registeredCount = cardImages.size;
  const totalCount = SUITS.length * RANKS.length;

  const embed = new EmbedBuilder()
    .setTitle("🃏 ブラックジャック — カード画像一覧")
    .setColor(COLOR_NEUTRAL)
    .setDescription(`登録済み: **${registeredCount}** / ${totalCount} 枚`);

  for (const suit of ["spade", "heart", "diamond", "club"] as const) {
    const lines = RANKS.map((rank) => {
      const key = `${rank}:${suit}`;
      return cardImages.has(key) ? `✅ ${rank}` : `❌ ${rank}（未設定）`;
    });
    embed.addFields({ name: SUIT_DISPLAY[suit] ?? suit, value: lines.join("\n"), inline: true });
  }

  await interaction.editReply({ embeds: [embed] });
}

// ─── /blackjack config delete ─────────────────────────────────────────────────

async function handleConfigDelete(interaction: ChatInputCommandInteraction): Promise<void> {
  const { guildId } = interaction;
  if (!guildId) return;
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "❌ 管理者専用です。", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const rank = interaction.options.getString("rank", true);
  const suit = interaction.options.getString("suit", true);

  // DB から登録済みのオブジェクトパスを取得する
  const cardImages = await getBjCardImages(guildId);
  const key        = `${rank}:${suit}`;
  const objectPath = cardImages.get(key);

  if (!objectPath) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("🃏 ブラックジャック — カード画像削除")
          .setColor(COLOR_LOSE)
          .setDescription(`**${rank} ${SUIT_DISPLAY[suit] ?? suit}** の画像は登録されていません。`),
      ],
    });
    return;
  }

  // GCS（Object Storage）から削除してから DB レコードを削除する
  await deleteGcsObject(objectPath);
  await deleteBjCardImage(guildId, rank, suit);

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle("🃏 ブラックジャック — カード画像削除")
        .setColor(COLOR_NEUTRAL)
        .setDescription(`**${rank} ${SUIT_DISPLAY[suit] ?? suit}** の画像を削除しました。`)
        .setFooter({ text: "次回ゲームからデフォルト（画像なし）に戻ります" }),
    ],
  });
}

// ─── Command export ───────────────────────────────────────────────────────────

export const blackjackCommand = {
  data: new SlashCommandBuilder()
    .setName("blackjack")
    .setDescription("ブラックジャック")
    .setDefaultMemberPermissions(0)
    .addSubcommand((sub) =>
      sub.setName("play")
        .setDescription("ブラックジャック — 21を目指せ！BJ=1.5倍・通常勝利=1倍")
        .addIntegerOption((opt) =>
          opt.setName("bet").setDescription(`賭け金（${MIN_BET.toLocaleString()}〜${MAX_BET.toLocaleString()}）`)
            .setMinValue(MIN_BET).setMaxValue(MAX_BET).setRequired(true),
        ),
    )
    .addSubcommandGroup((group) =>
      group.setName("config").setDescription("【管理者】ブラックジャックの見た目を設定する")
        .addSubcommand((sub) =>
          sub.setName("suit").setDescription("スートの絵文字を設定する")
            .addStringOption((opt) =>
              opt.setName("suit").setDescription("設定するスート").setRequired(true).addChoices(...SUIT_CHOICES),
            )
            .addStringOption((opt) =>
              opt.setName("emoji").setDescription("絵文字文字列（省略するとリセット）").setRequired(false),
            ),
        )
        .addSubcommand((sub) =>
          sub.setName("card").setDescription("カード画像を登録する（1枚ずつ添付）")
            .addStringOption((opt) =>
              opt.setName("rank").setDescription("カードのランク").setRequired(true).addChoices(...RANK_CHOICES),
            )
            .addStringOption((opt) =>
              opt.setName("suit").setDescription("カードのスート").setRequired(true).addChoices(...SUIT_CHOICES),
            )
            .addAttachmentOption((opt) =>
              opt.setName("image").setDescription("カードの画像ファイル（PNG / JPG / GIF / WebP）").setRequired(true),
            ),
        )
        .addSubcommand((sub) =>
          sub.setName("list").setDescription("登録済みカード画像の一覧を表示する"),
        )
        .addSubcommand((sub) =>
          sub.setName("delete").setDescription("登録済みカード画像を削除してデフォルトに戻す")
            .addStringOption((opt) =>
              opt.setName("rank").setDescription("カードのランク").setRequired(true).addChoices(...RANK_CHOICES),
            )
            .addStringOption((opt) =>
              opt.setName("suit").setDescription("カードのスート").setRequired(true).addChoices(...SUIT_CHOICES),
            ),
        ),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const sub   = interaction.options.getSubcommand();
    const group = interaction.options.getSubcommandGroup(false);
    if (sub === "play") { await handlePlay(interaction); return; }
    if (group === "config") {
      if (sub === "suit") await handleConfigSuit(interaction);
      else if (sub === "card") await handleConfigCard(interaction);
      else if (sub === "list") await handleConfigList(interaction);
      else if (sub === "delete") await handleConfigDelete(interaction);
    }
  },
};
