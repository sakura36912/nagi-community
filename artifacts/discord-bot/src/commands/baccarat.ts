/**
 * /baccarat — バカラ（ポンテ・バンコ式）
 *
 * フロー:
 *   1. /baccarat play bet:<金額> でコマンド実行
 *   2. プレイヤー・バンカーそれぞれ2枚配布して表示
 *   3. ボタンでベット先（player/banker/tie）を選択
 *   4. 標準バカラルールで3枚目自動処理 → 結果表示
 *
 * 配当:
 *   Player 勝利: 1:1
 *   Banker 勝利: 0.95:1（5%コミッション）
 *   Tie:        8:1
 *   プレイヤー/バンカーベットでタイ → プッシュ（賭け金返却）
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
type BetOn = "player" | "banker" | "tie";
type GameResult = "player" | "banker" | "tie";

const SUIT_KEY: Record<Suit, string> = {
  "♠": "spade", "♥": "heart", "♦": "diamond", "♣": "club",
};

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_BET = 1000;
const MAX_BET = 10_000;
const SESSION_TTL_MS = 5 * 60 * 1000; // 5分

const COLOR_WIN     = 0x57f287;
const COLOR_LOSE    = 0xed4245;
const COLOR_PUSH    = 0xfee75c;
const COLOR_NEUTRAL = 0x5865f2;

const CARD_STRIP_HEIGHT = 90;

export const BACCARAT_PREFIX = "baccarat:bet:";

// ─── Session ─────────────────────────────────────────────────────────────────

interface BaccaratSession {
  guildId: string;
  userId: string;
  bet: number;
  playerHand: Card[];
  bankerHand: Card[];
  deck: Card[];
  cardPaths: Map<string, string>;
  cardBuffers: Map<string, Buffer>;
  suitEmojis: SuitEmojis;
  currencyName: string;
  expiresAt: number;
  processing: boolean;
}

const sessions = new Map<string, BaccaratSession>();

function cleanExpiredSessions(): void {
  const now = Date.now();
  for (const [key, s] of sessions) {
    if (s.expiresAt < now) sessions.delete(key);
  }
}

// ─── Deck helpers ─────────────────────────────────────────────────────────────

function buildShoe(decks = 8): Card[] {
  const shoe: Card[] = [];
  for (let i = 0; i < decks; i++)
    for (const suit of SUITS)
      for (const rank of RANKS)
        shoe.push({ rank, suit });
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shoe[i], shoe[j]] = [shoe[j]!, shoe[i]!];
  }
  return shoe;
}

function drawCard(deck: Card[]): [Card, Card[]] { return [deck[0]!, deck.slice(1)]; }

function cardValue(rank: Rank): number {
  if (rank === "A") return 1;
  if (["10", "J", "Q", "K"].includes(rank)) return 0;
  return parseInt(rank, 10);
}

function handTotal(hand: Card[]): number {
  return hand.reduce((sum, c) => sum + cardValue(c.rank), 0) % 10;
}

// ─── Third-card rules ─────────────────────────────────────────────────────────

function playBaccarat(
  playerHand: Card[],
  bankerHand: Card[],
  deck: Card[],
): { player: Card[]; banker: Card[]; deck: Card[] } {
  let ph = [...playerHand];
  let bh = [...bankerHand];
  let d  = deck;

  const pTotal = handTotal(ph);
  const bTotal = handTotal(bh);

  // ナチュラル（8 or 9）→ 追加なし
  if (pTotal >= 8 || bTotal >= 8) {
    return { player: ph, banker: bh, deck: d };
  }

  // プレイヤーのサードカード
  let playerDrew = false;
  let playerThird: number | null = null;
  if (pTotal <= 5) {
    const [card, rest] = drawCard(d);
    ph = [...ph, card];
    d  = rest;
    playerDrew = true;
    playerThird = cardValue(card.rank);
  }

  // バンカーのサードカード
  const bNew = handTotal(bh);
  let bankerDraws: boolean;

  if (!playerDrew) {
    bankerDraws = bNew <= 5;
  } else {
    const p3 = playerThird!;
    if (bNew <= 2) {
      bankerDraws = true;
    } else if (bNew === 3) {
      bankerDraws = p3 !== 8;
    } else if (bNew === 4) {
      bankerDraws = p3 >= 2 && p3 <= 7;
    } else if (bNew === 5) {
      bankerDraws = p3 >= 4 && p3 <= 7;
    } else if (bNew === 6) {
      bankerDraws = p3 === 6 || p3 === 7;
    } else {
      bankerDraws = false;
    }
  }

  if (bankerDraws) {
    const [card, rest] = drawCard(d);
    bh = [...bh, card];
    d  = rest;
  }

  return { player: ph, banker: bh, deck: d };
}

function resolveResult(player: Card[], banker: Card[]): GameResult {
  const p = handTotal(player);
  const b = handTotal(banker);
  if (p === b) return "tie";
  return p > b ? "player" : "banker";
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

// ─── Card image helpers ───────────────────────────────────────────────────────

interface CardImage { attachment: AttachmentBuilder; filename: string }

function resolveSuitEmojis(settings: GuildSettings): SuitEmojis {
  return {
    "♠": settings.bjSuitSpade   ?? "♠️",
    "♥": settings.bjSuitHeart   ?? "♥️",
    "♦": settings.bjSuitDiamond ?? "♦️",
    "♣": settings.bjSuitClub    ?? "♣️",
  };
}

function fmtCard(c: Card, e: SuitEmojis): string { return `${c.rank}${e[c.suit]}`; }
function fmtHand(hand: Card[], e: SuitEmojis): string {
  return hand.map((c) => fmtCard(c, e)).join(" ");
}

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
  } catch { /* 無視 */ }
}

async function cacheHandBuffers(
  hand: Card[],
  cardPaths: Map<string, string>,
  cardBuffers: Map<string, Buffer>,
): Promise<void> {
  await Promise.all(hand.map((c) => cacheCardBuffer(c, cardPaths, cardBuffers)));
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
    .map((c) => cardBuffers.get(`${c.rank}:${SUIT_KEY[c.suit]}`) ?? null)
    .filter((b): b is Buffer => b !== null);
  if (buffers.length === 0) return null;
  try {
    const merged = await mergeHorizontal(buffers);
    return { attachment: new AttachmentBuilder(merged, { name: filename }), filename };
  } catch {
    return null;
  }
}

// ─── Button builder ───────────────────────────────────────────────────────────

function buildBetButtons(sessionId: string, disabled = false): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${BACCARAT_PREFIX}player:${sessionId}`)
      .setLabel("🔵 プレイヤー (1:1)")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`${BACCARAT_PREFIX}banker:${sessionId}`)
      .setLabel("🔴 バンカー (0.95:1)")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`${BACCARAT_PREFIX}tie:${sessionId}`)
      .setLabel("🤝 タイ (8:1)")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  );
}

// ─── Embed builders ───────────────────────────────────────────────────────────

async function buildInitialEmbeds(
  session: BaccaratSession,
): Promise<{ embeds: EmbedBuilder[]; files: AttachmentBuilder[] }> {
  const { playerHand, bankerHand, suitEmojis, cardBuffers, bet, currencyName } = session;

  const pTotal = handTotal(playerHand);
  const bTotal = handTotal(bankerHand);

  const [playerStrip, bankerStrip] = await Promise.all([
    buildHandStrip(playerHand, cardBuffers, "p_init.png"),
    buildHandStrip(bankerHand, cardBuffers, "b_init.png"),
  ]);

  const pValue = playerStrip ? `**${pTotal}**` : `${fmtHand(playerHand, suitEmojis)}　**${pTotal}**`;
  const bValue = bankerStrip ? `**${bTotal}**` : `${fmtHand(bankerHand, suitEmojis)}　**${bTotal}**`;

  const mainEmbed = new EmbedBuilder()
    .setTitle("🎴 バカラ — どちらに賭けますか？")
    .setColor(COLOR_NEUTRAL)
    .setDescription(`賭け金: **${bet.toLocaleString()}** ${currencyName}`)
    .addFields(
      { name: "🔵 プレイヤー", value: pValue, inline: true },
      { name: "🔴 バンカー",   value: bValue, inline: true },
    )
    .setFooter({ text: "5分以内にベット先を選んでください" });

  const embeds: EmbedBuilder[] = [];
  const files: AttachmentBuilder[] = [];

  if (playerStrip) {
    embeds.push(new EmbedBuilder().setTitle("🔵 プレイヤー").setImage("attachment://p_init.png"));
    files.push(playerStrip.attachment);
  }
  if (bankerStrip) {
    embeds.push(new EmbedBuilder().setTitle("🔴 バンカー").setImage("attachment://b_init.png"));
    files.push(bankerStrip.attachment);
  }
  embeds.push(mainEmbed);

  return { embeds, files };
}

interface BaccaratResult {
  player: Card[];
  banker: Card[];
  result: GameResult;
  betOn: BetOn;
  bet: number;
  netDelta: number;
  currencyName: string;
}

async function buildResultEmbeds(
  res: BaccaratResult,
  suitEmojis: SuitEmojis,
  cardBuffers: Map<string, Buffer>,
): Promise<{ embeds: EmbedBuilder[]; files: AttachmentBuilder[] }> {
  const pTotal = handTotal(res.player);
  const bTotal = handTotal(res.banker);

  const [playerStrip, bankerStrip] = await Promise.all([
    buildHandStrip(res.player, cardBuffers, "player.png"),
    buildHandStrip(res.banker, cardBuffers, "banker.png"),
  ]);

  const pValue = playerStrip ? `**${pTotal}**` : `${fmtHand(res.player, suitEmojis)}　**${pTotal}**`;
  const bValue = bankerStrip ? `**${bTotal}**` : `${fmtHand(res.banker, suitEmojis)}　**${bTotal}**`;

  const RESULT_TITLE: Record<GameResult, string> = {
    player: "🔵 プレイヤー勝利",
    banker: "🔴 バンカー勝利",
    tie:    "🤝 タイ",
  };

  const betLabel: Record<BetOn, string> = {
    player: "プレイヤー",
    banker: "バンカー",
    tie:    "タイ",
  };

  let color: number;
  const isWin  = res.netDelta > 0;
  const isPush = res.netDelta === 0;
  if (isWin)       color = COLOR_WIN;
  else if (isPush) color = COLOR_PUSH;
  else             color = COLOR_LOSE;

  const sign = res.netDelta > 0 ? "+" : "";
  const mainEmbed = new EmbedBuilder()
    .setTitle(`🎴 バカラ — ${RESULT_TITLE[res.result]}`)
    .setColor(color)
    .addFields(
      { name: "🔵 プレイヤー", value: pValue, inline: true },
      { name: "🔴 バンカー",   value: bValue, inline: true },
      { name: "\u200B",        value: "\u200B", inline: true },
      { name: "ベット",        value: betLabel[res.betOn], inline: true },
      { name: "賭け金",        value: `**${res.bet.toLocaleString()}** ${res.currencyName}`, inline: true },
      { name: "収支",          value: `${sign}${res.netDelta.toLocaleString()} ${res.currencyName}`, inline: true },
    )
    .setTimestamp();

  const embeds: EmbedBuilder[] = [];
  const files: AttachmentBuilder[] = [];

  if (playerStrip) {
    embeds.push(new EmbedBuilder().setTitle("🔵 プレイヤー").setImage("attachment://player.png"));
    files.push(playerStrip.attachment);
  }
  if (bankerStrip) {
    embeds.push(new EmbedBuilder().setTitle("🔴 バンカー").setImage("attachment://banker.png"));
    files.push(bankerStrip.attachment);
  }
  embeds.push(mainEmbed);

  return { embeds, files };
}

// ─── /baccarat play ───────────────────────────────────────────────────────────

async function handlePlay(interaction: ChatInputCommandInteraction): Promise<void> {
  const { guildId } = interaction;
  if (!guildId) return;
  const userId = interaction.user.id;

  const bet = interaction.options.getInteger("bet", true);

  await interaction.deferReply();

  const [, settings, cardPaths] = await Promise.all([
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
          .setTitle("🎴 バカラ")
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
          .setTitle("🎴 バカラ")
          .setDescription("❌ 残高が不足しています。")
          .setColor(COLOR_LOSE),
      ],
    });
    return;
  }

  // ─── ディール（2枚ずつ） ───────────────────────────────────────────────────
  let deck = buildShoe();
  let [c, rest] = drawCard(deck); const p1 = c; deck = rest;
  [c, rest] = drawCard(deck); const b1 = c; deck = rest;
  [c, rest] = drawCard(deck); const p2 = c; deck = rest;
  [c, rest] = drawCard(deck); const b2 = c; deck = rest;

  const playerHand: Card[] = [p1, p2];
  const bankerHand: Card[] = [b1, b2];

  // ─── カード画像キャッシュ ──────────────────────────────────────────────────
  const suitEmojis  = resolveSuitEmojis(settings);
  const cardBuffers = new Map<string, Buffer>();
  await cacheHandBuffers([...playerHand, ...bankerHand], cardPaths, cardBuffers);

  // ─── セッション登録 ────────────────────────────────────────────────────────
  cleanExpiredSessions();
  const sessionId = interaction.id;

  const session: BaccaratSession = {
    guildId, userId, bet,
    playerHand, bankerHand, deck,
    cardPaths, cardBuffers, suitEmojis,
    currencyName,
    expiresAt: Date.now() + SESSION_TTL_MS,
    processing: false,
  };
  sessions.set(sessionId, session);

  // ─── 初期ハンド表示 ────────────────────────────────────────────────────────
  const { embeds, files } = await buildInitialEmbeds(session);
  await interaction.editReply({
    embeds,
    files,
    components: [buildBetButtons(sessionId)],
  });
}

// ─── Button handler ───────────────────────────────────────────────────────────

export async function handleBaccaratButton(interaction: ButtonInteraction): Promise<void> {
  // customId: baccarat:bet:{side}:{sessionId}
  const parts = interaction.customId.slice(BACCARAT_PREFIX.length).split(":");
  const betOn     = parts[0] as BetOn;
  const sessionId = parts.slice(1).join(":");

  const session = sessions.get(sessionId);

  if (!session) {
    await interaction.reply({ content: "❌ セッションが見つからないか、すでに期限切れです。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (session.userId !== interaction.user.id) {
    await interaction.reply({ content: "❌ このゲームは別のプレイヤーのものです。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (session.processing) {
    await interaction.reply({ content: "⏳ 処理中です。少し待ってください。", flags: MessageFlags.Ephemeral });
    return;
  }

  session.processing = true;

  try {
    await interaction.deferUpdate();

    // 3枚目のカードをキャッシュしておく必要があるため、3枚目処理後にキャッシュ
    const { player: finalPlayer, banker: finalBanker } = playBaccarat(
      session.playerHand,
      session.bankerHand,
      session.deck,
    );

    // 3枚目が引かれた場合のカード画像もキャッシュ
    await cacheHandBuffers(
      [...finalPlayer, ...finalBanker],
      session.cardPaths,
      session.cardBuffers,
    );

    const gameResult = resolveResult(finalPlayer, finalBanker);
    const { guildId, userId, bet, currencyName } = session;

    // ─── 精算 ──────────────────────────────────────────────────────────────
    let netDelta: number;
    let reason: string;

    if (gameResult === "tie") {
      if (betOn === "tie") {
        const winnings = bet * 8;
        await creditAmount(guildId, userId, bet + winnings);
        netDelta = winnings;
        reason   = `バカラ タイ的中（賭け: ${bet}）`;
      } else {
        await creditAmount(guildId, userId, bet);
        netDelta = 0;
        reason   = `バカラ プッシュ（賭け: ${bet}）`;
      }
    } else if (gameResult === betOn) {
      if (betOn === "banker") {
        const winnings = Math.floor(bet * 0.95);
        await creditAmount(guildId, userId, bet + winnings);
        netDelta = winnings;
        reason   = `バカラ バンカー勝利（賭け: ${bet}）`;
      } else {
        const winnings = bet;
        await creditAmount(guildId, userId, bet + winnings);
        netDelta = winnings;
        reason   = `バカラ プレイヤー勝利（賭け: ${bet}）`;
      }
    } else {
      netDelta = -bet;
      const side = betOn === "player" ? "プレイヤーベット" : betOn === "banker" ? "バンカーベット" : "タイベット";
      reason = `バカラ 敗北 ${side}（賭け: ${bet}）`;
    }

    await recordTransaction(guildId, userId, netDelta, reason).catch(() => {});

    sessions.delete(sessionId);

    const { embeds, files } = await buildResultEmbeds(
      { player: finalPlayer, banker: finalBanker, result: gameResult, betOn, bet, netDelta, currencyName },
      session.suitEmojis,
      session.cardBuffers,
    );

    await interaction.editReply({
      embeds,
      files,
      components: [buildBetButtons(sessionId, true)],
    });
  } catch (err) {
    session.processing = false;
    throw err;
  }
}

// ─── Command export ───────────────────────────────────────────────────────────

export const baccaratCommand = {
  data: new SlashCommandBuilder()
    .setName("baccarat")
    .setDescription("バカラ — 2枚の手札を見てからベット先を選ぼう！")
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
    if (!interaction.isChatInputCommand()) return;
    await handlePlay(interaction);
  },
};
