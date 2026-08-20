/**
 * /baccarat — バカラ（ポンテ・バンコ式）
 *
 * フロー:
 *   1. /baccarat bet:<金額> on:<player|banker|tie> でコマンド実行
 *   2. プレイヤー・バンカーそれぞれ2枚配布
 *   3. 標準バカラルールで3枚目自動処理
 *   4. 結果表示
 *
 * 配当:
 *   Player 勝利: 1:1
 *   Banker 勝利: 0.95:1（5%コミッション）
 *   Tie:        8:1
 *   プレイヤー/バンカーベットでタイ → プッシュ（賭け金返却）
 */

import Jimp from "jimp";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  EmbedBuilder,
  Message,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { and, eq, lt, sql } from "drizzle-orm";
import { db, walletsTable, baccaratSessionsTable } from "@workspace/db";
import { getGuildSettings, getOrCreateWallet, recordTransaction } from "../lib/economy";
import {
  addCasinoRound,
  buildCasinoResultFields,
  emptyCasinoResultTotals,
  type CasinoResultTotals,
} from "../lib/casinoResult";
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

const COLOR_WIN  = 0x57f287;
const COLOR_LOSE = 0xed4245;
const COLOR_PUSH = 0xfee75c;

const CARD_STRIP_HEIGHT = 90;

// ─── Button prefix & session ──────────────────────────────────────────────────

export const BACCARAT_DRAW_PREFIX   = "baccarat:draw:";
export const BACCARAT_REPLAY_PREFIX = "baccarat:replay:";
export const BACCARAT_QUIT_PREFIX   = "baccarat:quit:";

interface BaccaratSession {
  guildId: string;
  userId: string;
  bet: number;
  betOn: BetOn;
  playerHand: Card[];
  bankerHand: Card[];
  deck: Card[];
  currencyName: string;
  suitEmojis: SuitEmojis;
  cardPaths: Map<string, string>;
  message: Message;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

const baccaratSessions = new Map<string, BaccaratSession>();
function sessionKey(guildId: string, userId: string): string { return `${guildId}:${userId}`; }
const startingBaccaratGames = new Set<string>();
const processingBaccaratDraws = new Set<string>();
const processingBaccaratReplays = new Set<string>();

// ─── Continuous-play session (累計収支) ────────────────────────────────────────

interface BaccaratPlaySession {
  totals: CasinoResultTotals;
}
const baccaratPlaySessions = new Map<string, BaccaratPlaySession>();

function buildBaccaratActionRow(
  guildId: string, userId: string, bet: number, betOn: BetOn,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${BACCARAT_REPLAY_PREFIX}${guildId}:${userId}:${bet}:${betOn}`)
      .setLabel("🔄 もう一度")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${BACCARAT_QUIT_PREFIX}${guildId}:${userId}`)
      .setLabel("🏁 終了")
      .setStyle(ButtonStyle.Secondary),
  );
}

function buildBaccaratSummaryEmbed(
  totals: CasinoResultTotals, currencyName: string,
): EmbedBuilder {
  const color = totals.totalNet > 0 ? COLOR_WIN : totals.totalNet < 0 ? COLOR_LOSE : COLOR_PUSH;
  return new EmbedBuilder()
    .setTitle("🎴 バカラ — セッション終了")
    .setColor(color)
    .addFields(
      ...buildCasinoResultFields(totals, currencyName),
      { name: "プレイ回数", value: `**${totals.games}**回`, inline: true },
    )
    .setTimestamp();
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
): { player: Card[]; banker: Card[] } {
  let ph = [...playerHand];
  let bh = [...bankerHand];
  let d  = deck;

  const pTotal = handTotal(ph);
  const bTotal = handTotal(bh);

  // ナチュラル（8 or 9）→ 追加なし
  if (pTotal >= 8 || bTotal >= 8) {
    return { player: ph, banker: bh };
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

  return { player: ph, banker: bh };
}

function resolveResult(player: Card[], banker: Card[]): GameResult {
  const p = handTotal(player);
  const b = handTotal(banker);
  if (p === b) return "tie";
  return p > b ? "player" : "banker";
}

// ─── 3枚目ドロー判定 ─────────────────────────────────────────────────────────

/**
 * 2枚の初期配布から3枚目が引かれるかを判定する。
 * ナチュラル（8/9）や双方スタンド（P:6/7 かつ B:6/7）は false。
 */
function willAnyDraw(playerHand: Card[], bankerHand: Card[]): boolean {
  const pTotal = handTotal(playerHand);
  const bTotal = handTotal(bankerHand);
  if (pTotal >= 8 || bTotal >= 8) return false; // ナチュラル
  if (pTotal <= 5) return true;                  // プレイヤーが引く
  // プレイヤースタンド（6 or 7）: バンカーが 0〜5 なら引く
  return bTotal <= 5;
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

function fmtHand(hand: Card[], e: SuitEmojis): string {
  return hand.map((c) => `${c.rank}${e[c.suit]}`).join(" ");
}

async function cacheHandBuffers(
  hand: Card[],
  cardPaths: Map<string, string>,
  cardBuffers: Map<string, Buffer>,
): Promise<void> {
  await Promise.all(hand.map(async (card) => {
    const key = `${card.rank}:${SUIT_KEY[card.suit]}`;
    if (cardBuffers.has(key)) return;
    const path = cardPaths.get(key);
    if (!path) return;
    try {
      const buf = await downloadImageAsBuffer(path);
      if (buf) cardBuffers.set(key, buf);
    } catch { /* 無視 */ }
  }));
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

// ─── Result embed ─────────────────────────────────────────────────────────────

async function buildResultEmbeds(
  player: Card[],
  banker: Card[],
  result: GameResult,
  betOn: BetOn,
  bet: number,
  netDelta: number,
  currencyName: string,
  suitEmojis: SuitEmojis,
  cardBuffers: Map<string, Buffer>,
  totals: CasinoResultTotals,
): Promise<{ embeds: EmbedBuilder[]; files: AttachmentBuilder[] }> {
  const pTotal = handTotal(player);
  const bTotal = handTotal(banker);

  const [playerStrip, bankerStrip] = await Promise.all([
    buildHandStrip(player, cardBuffers, "player.png"),
    buildHandStrip(banker, cardBuffers, "banker.png"),
  ]);

  const pValue = playerStrip
    ? `**${pTotal}**（${player.length}枚）`
    : `${fmtHand(player, suitEmojis)}　**${pTotal}**`;
  const bValue = bankerStrip
    ? `**${bTotal}**（${banker.length}枚）`
    : `${fmtHand(banker, suitEmojis)}　**${bTotal}**`;

  const RESULT_TITLE: Record<GameResult, string> = {
    player: "🔵 プレイヤー勝利",
    banker: "🔴 バンカー勝利",
    tie:    "🤝 タイ",
  };
  const BET_LABEL: Record<BetOn, string> = {
    player: "🔵 プレイヤー",
    banker: "🔴 バンカー",
    tie:    "🤝 タイ",
  };

  const isWin  = netDelta > 0;
  const isPush = netDelta === 0;
  const color  = isWin ? COLOR_WIN : isPush ? COLOR_PUSH : COLOR_LOSE;
  const mainEmbed = new EmbedBuilder()
    .setTitle(`🎴 バカラ — ${RESULT_TITLE[result]}`)
    .setColor(color)
    .addFields(
      { name: "🔵 プレイヤー", value: pValue, inline: true },
      { name: "🔴 バンカー",   value: bValue, inline: true },
      { name: "\u200B",        value: "\u200B", inline: true },
      { name: "ベット",        value: BET_LABEL[betOn], inline: true },
      ...buildCasinoResultFields(totals, currencyName),
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

// ─── Deal embed（2枚配布後の表示） ────────────────────────────────────────────

async function buildDealEmbeds(
  playerHand: Card[],
  bankerHand: Card[],
  betOn: BetOn,
  bet: number,
  currencyName: string,
  suitEmojis: SuitEmojis,
  cardBuffers: Map<string, Buffer>,
  guildId: string,
  userId: string,
): Promise<{ embeds: EmbedBuilder[]; files: AttachmentBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] }> {
  const pTotal = handTotal(playerHand);
  const bTotal = handTotal(bankerHand);

  const [playerStrip, bankerStrip] = await Promise.all([
    buildHandStrip(playerHand, cardBuffers, "deal_player.png"),
    buildHandStrip(bankerHand, cardBuffers, "deal_banker.png"),
  ]);

  const BET_LABEL: Record<BetOn, string> = {
    player: "🔵 プレイヤー", banker: "🔴 バンカー", tie: "🤝 タイ",
  };

  const pValue = playerStrip
    ? `**${pTotal}**（2枚）`
    : `${fmtHand(playerHand, suitEmojis)}　**${pTotal}**`;
  const bValue = bankerStrip
    ? `**${bTotal}**（2枚）`
    : `${fmtHand(bankerHand, suitEmojis)}　**${bTotal}**`;

  const dealEmbed = new EmbedBuilder()
    .setTitle("🎴 バカラ — 2枚配布")
    .setColor(0x5865f2)
    .addFields(
      { name: "🔵 プレイヤー", value: pValue, inline: true },
      { name: "🔴 バンカー",   value: bValue, inline: true },
      { name: "\u200B",        value: "\u200B", inline: true },
      { name: "ベット",        value: BET_LABEL[betOn], inline: true },
      { name: "賭け金",        value: `**${bet.toLocaleString()}** ${currencyName}`, inline: true },
    )
    .setFooter({ text: "60秒以内にドローしてください" });

  const embeds: EmbedBuilder[] = [];
  const files: AttachmentBuilder[] = [];
  if (playerStrip) {
    embeds.push(new EmbedBuilder().setTitle("🔵 プレイヤー").setImage("attachment://deal_player.png"));
    files.push(playerStrip.attachment);
  }
  if (bankerStrip) {
    embeds.push(new EmbedBuilder().setTitle("🔴 バンカー").setImage("attachment://deal_banker.png"));
    files.push(bankerStrip.attachment);
  }
  embeds.push(dealEmbed);

  const drawButton = new ButtonBuilder()
    .setCustomId(`${BACCARAT_DRAW_PREFIX}${guildId}:${userId}`)
    .setLabel("🃏 ドロー")
    .setStyle(ButtonStyle.Primary);

  return { embeds, files, components: [new ActionRowBuilder<ButtonBuilder>().addComponents(drawButton)] };
}

// ─── Resolve & payout（ボタンハンドラ・タイムアウト共用） ──────────────────────

async function resolveAndPayout(
  guildId: string,
  userId: string,
  bet: number,
  betOn: BetOn,
  playerHand: Card[],
  bankerHand: Card[],
  deck: Card[],
  currencyName: string,
  suitEmojis: SuitEmojis,
  cardPaths: Map<string, string>,
): Promise<{ embeds: EmbedBuilder[]; files: AttachmentBuilder[]; netDelta: number }> {
  const { player: finalPlayer, banker: finalBanker } = playBaccarat(playerHand, bankerHand, deck);
  const cardBuffers = new Map<string, Buffer>();
  await cacheHandBuffers([...finalPlayer, ...finalBanker], cardPaths, cardBuffers);
  const gameResult = resolveResult(finalPlayer, finalBanker);

  let netDelta: number;
  let payout = 0;
  let reason: string;

  if (gameResult === "tie") {
    if (betOn === "tie") {
      const winnings = bet * 8;
      payout = bet + winnings;
      await creditAmount(guildId, userId, payout);
      netDelta = winnings;
      reason   = `バカラ タイ的中（賭け: ${bet}）`;
    } else {
      payout = bet;
      await creditAmount(guildId, userId, payout);
      netDelta = 0;
      reason   = `バカラ プッシュ（賭け: ${bet}）`;
    }
  } else if (gameResult === betOn) {
    if (betOn === "banker") {
      const winnings = Math.floor(bet * 0.95);
      payout = bet + winnings;
      await creditAmount(guildId, userId, payout);
      netDelta = winnings;
      reason   = `バカラ バンカー勝利（賭け: ${bet}）`;
    } else {
      const winnings = bet;
      payout = bet + winnings;
      await creditAmount(guildId, userId, payout);
      netDelta = winnings;
      reason   = `バカラ プレイヤー勝利（賭け: ${bet}）`;
    }
  } else {
    netDelta = -bet;
    const side = betOn === "player" ? "プレイヤーベット" : betOn === "banker" ? "バンカーベット" : "タイベット";
    reason = `バカラ 敗北 ${side}（賭け: ${bet}）`;
  }

  await recordTransaction(guildId, userId, netDelta, reason).catch(() => {});

  const pKey = sessionKey(guildId, userId);
  const previous = baccaratPlaySessions.get(pKey)?.totals ?? emptyCasinoResultTotals();
  const totals = addCasinoRound(previous, bet, payout);
  baccaratPlaySessions.set(pKey, { totals });

  const { embeds, files } = await buildResultEmbeds(
    finalPlayer, finalBanker, gameResult, betOn, bet, netDelta, currencyName, suitEmojis, cardBuffers, totals,
  );
  return { embeds, files, netDelta };
}

// ─── /baccarat ────────────────────────────────────────────────────────────────

async function handlePlay(interaction: ChatInputCommandInteraction): Promise<void> {
  const { guildId } = interaction;
  if (!guildId) return;
  const userId = interaction.user.id;
  const key = sessionKey(guildId, userId);

  if (
    startingBaccaratGames.has(key)
    || baccaratSessions.has(key)
    || processingBaccaratDraws.has(key)
    || processingBaccaratReplays.has(key)
  ) {
    await interaction.reply({
      content: "❌ 進行中のバカラがあります。ドローまたは結果画面の操作を完了してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  startingBaccaratGames.add(key);

  const bet   = interaction.options.getInteger("bet", true);
  const betOn = interaction.options.getString("on", true) as BetOn;

  try {
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

  // ボット再起動前に保存された未解決の賭けを上書きしない。
  const [persistedSession] = await db
    .select({ expiresAt: baccaratSessionsTable.expiresAt })
    .from(baccaratSessionsTable)
    .where(and(
      eq(baccaratSessionsTable.guildId, guildId),
      eq(baccaratSessionsTable.userId, userId),
    ));
  if (persistedSession) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("🎴 バカラ")
          .setDescription("❌ 未解決のバカラがあります。既存のドローボタンで結果を確定してください。")
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

  const suitEmojis = resolveSuitEmojis(settings);

  // 新規コマンド実行でプレイセッションをリセット
  baccaratPlaySessions.set(sessionKey(guildId, userId), { totals: emptyCasinoResultTotals() });

  // ─── 3枚目なし（ナチュラル or 双方スタンド）→ 即時結果表示 ────────────────
  if (!willAnyDraw(playerHand, bankerHand)) {
    const { embeds, files } = await resolveAndPayout(
      guildId, userId, bet, betOn, playerHand, bankerHand, deck,
      currencyName, suitEmojis, cardPaths,
    );
    await interaction.editReply({ embeds, files, components: [buildBaccaratActionRow(guildId, userId, bet, betOn)] });
    return;
  }

  // ─── 3枚目あり → 2枚状態を表示してドローボタンを置く ──────────────────────
  const dealCardBuffers = new Map<string, Buffer>();
  await cacheHandBuffers([...playerHand, ...bankerHand], cardPaths, dealCardBuffers);
  const { embeds: dealEmbeds, files: dealFiles, components } = await buildDealEmbeds(
    playerHand, bankerHand, betOn, bet, currencyName, suitEmojis, dealCardBuffers, guildId, userId,
  );

  // 同ユーザーの既存セッションがあればキャンセル
  const msg = await interaction.editReply({ embeds: dealEmbeds, files: dealFiles, components });

  // DB に永続化（ボット再起動後もボタン操作を継続できるように）
  const expiresAt = new Date(Date.now() + 60_000);
  await db.insert(baccaratSessionsTable).values({
    guildId, userId, bet, betOn,
    playerHand: JSON.stringify(playerHand),
    bankerHand: JSON.stringify(bankerHand),
    deck:       JSON.stringify(deck),
    currencyName, expiresAt,
  }).onConflictDoUpdate({
    target: [baccaratSessionsTable.guildId, baccaratSessionsTable.userId],
    set: {
      bet, betOn,
      playerHand: JSON.stringify(playerHand),
      bankerHand: JSON.stringify(bankerHand),
      deck:       JSON.stringify(deck),
      currencyName, expiresAt,
    },
  }).catch(() => { /* non-fatal */ });

  // 60秒後に自動解決（放置対策）
  let session: BaccaratSession;
  const timeoutHandle = setTimeout(async () => {
    baccaratSessions.delete(key);
    await db.delete(baccaratSessionsTable)
      .where(and(eq(baccaratSessionsTable.guildId, guildId), eq(baccaratSessionsTable.userId, userId)))
      .catch(() => {});
    try {
      const { embeds: rEmbeds, files: rFiles } = await resolveAndPayout(
        session.guildId, session.userId, session.bet, session.betOn,
        session.playerHand, session.bankerHand, session.deck,
        session.currencyName, session.suitEmojis, session.cardPaths,
      );
      const row = buildBaccaratActionRow(session.guildId, session.userId, session.bet, session.betOn);
      await session.message.edit({ embeds: rEmbeds, files: rFiles, components: [row] });
    } catch { /* non-fatal */ }
  }, 60_000);

  session = {
    guildId, userId, bet, betOn,
    playerHand, bankerHand, deck,
    currencyName, suitEmojis, cardPaths,
    message: msg as Message,
    timeoutHandle,
  };
  baccaratSessions.set(key, session);
  } finally {
    startingBaccaratGames.delete(key);
  }
}

// ─── Button handler ───────────────────────────────────────────────────────────

/** 「🃏 ドロー」ボタン押下 → 3枚目処理 → 結果表示 */
export async function handleBaccaratDrawBtn(interaction: ButtonInteraction): Promise<void> {
  // custom ID format: "baccarat:draw:{guildId}:{userId}"
  const payload  = interaction.customId.slice(BACCARAT_DRAW_PREFIX.length);
  const colonIdx = payload.indexOf(":");
  const guildId  = payload.slice(0, colonIdx);
  const userId   = payload.slice(colonIdx + 1);

  if (interaction.user.id !== userId) {
    await interaction.reply({ content: "❌ このゲームはあなたのものではありません。", flags: MessageFlags.Ephemeral });
    return;
  }

  const key        = sessionKey(guildId, userId);
  if (processingBaccaratDraws.has(key)) {
    await interaction.deferUpdate();
    return;
  }
  processingBaccaratDraws.add(key);

  try {
  const memSession = baccaratSessions.get(key);

  // ゲームデータ（メモリ優先、なければ DB からリストア）
  let gameData: {
    bet: number; betOn: BetOn;
    playerHand: Card[]; bankerHand: Card[]; deck: Card[];
    currencyName: string; suitEmojis: SuitEmojis; cardPaths: Map<string, string>;
  } | null = null;

  if (memSession) {
    clearTimeout(memSession.timeoutHandle);
    baccaratSessions.delete(key);
    gameData = memSession;
  } else {
    // ボット再起動後の DB fallback
    const [row] = await db.select().from(baccaratSessionsTable)
      .where(and(eq(baccaratSessionsTable.guildId, guildId), eq(baccaratSessionsTable.userId, userId)));

    if (!row) {
      await interaction.reply({ content: "❌ セッションが見つかりません。**/baccarat を再実行してください。**", flags: MessageFlags.Ephemeral });
      return;
    }
    if (new Date() > row.expiresAt) {
      await db.delete(baccaratSessionsTable)
        .where(and(eq(baccaratSessionsTable.guildId, guildId), eq(baccaratSessionsTable.userId, userId)))
        .catch(() => {});
      await interaction.reply({ content: "❌ セッションが期限切れです（60秒でタイムアウト）。", flags: MessageFlags.Ephemeral });
      return;
    }

    const [settings, cardPaths] = await Promise.all([
      getGuildSettings(guildId),
      getBjCardImages(guildId),
    ]);
    gameData = {
      bet:         row.bet,
      betOn:       row.betOn as BetOn,
      playerHand:  JSON.parse(row.playerHand) as Card[],
      bankerHand:  JSON.parse(row.bankerHand) as Card[],
      deck:        JSON.parse(row.deck) as Card[],
      currencyName: row.currencyName,
      suitEmojis:  resolveSuitEmojis(settings),
      cardPaths,
    };
  }

  // DB から削除（処理完了 or 再起動後のリストア完了）
  await db.delete(baccaratSessionsTable)
    .where(and(eq(baccaratSessionsTable.guildId, guildId), eq(baccaratSessionsTable.userId, userId)))
    .catch(() => {});

  await interaction.deferUpdate();

  // ボタンをすぐ無効化して連打を防ぐ
  await interaction.editReply({
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`${BACCARAT_DRAW_PREFIX}${guildId}:${userId}`)
          .setLabel("🃏 処理中…")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
      ),
    ],
  });

  try {
    const { embeds, files } = await resolveAndPayout(
      guildId, userId, gameData.bet, gameData.betOn,
      gameData.playerHand, gameData.bankerHand, gameData.deck,
      gameData.currencyName, gameData.suitEmojis, gameData.cardPaths,
    );
    const replayRow = buildBaccaratActionRow(guildId, userId, gameData.bet, gameData.betOn);
    await interaction.editReply({ embeds, files, components: [replayRow] });
  } catch {
    await interaction.editReply({ content: "❌ エラーが発生しました。", components: [] }).catch(() => {});
  }
  } finally {
    processingBaccaratDraws.delete(key);
  }
}

// ─── Replay / Quit handlers ───────────────────────────────────────────────────

/** 「🔄 もう一度」ボタン押下 → 同じ bet/betOn で新ゲーム開始 */
export async function handleBaccaratReplayBtn(interaction: ButtonInteraction): Promise<void> {
  // custom ID: "baccarat:replay:{guildId}:{userId}:{bet}:{betOn}"
  const payload = interaction.customId.slice(BACCARAT_REPLAY_PREFIX.length);
  // guildId と userId はスノーフレーク（数字のみ）、bet も数字、betOn は文字列
  const parts  = payload.split(":");
  const guildId = parts[0]!;
  const userId  = parts[1]!;
  const bet     = parseInt(parts[2]!, 10);
  const betOn   = parts[3]! as BetOn;

  if (interaction.user.id !== userId) {
    await interaction.reply({ content: "❌ このゲームはあなたのものではありません。", flags: MessageFlags.Ephemeral });
    return;
  }

  const key = sessionKey(guildId, userId);
  if (processingBaccaratReplays.has(key)) {
    await interaction.deferUpdate();
    return;
  }
  processingBaccaratReplays.add(key);

  try {
  await interaction.deferUpdate();
  // ボタンを即時無効化
  await interaction.editReply({
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("bac_r_dis").setLabel("🔄 処理中…").setStyle(ButtonStyle.Primary).setDisabled(true),
        new ButtonBuilder().setCustomId("bac_q_dis").setLabel("🏁 終了").setStyle(ButtonStyle.Secondary).setDisabled(true),
      ),
    ],
  });

  const [, settings, cardPaths] = await Promise.all([
    getOrCreateWallet(guildId, userId),
    getGuildSettings(guildId),
    getBjCardImages(guildId),
  ]);

  const { currencyName } = settings;
  const maxBet = settings.casinoMaxBet ?? CASINO_DEFAULT_MAX_BET;

  if (bet > maxBet) {
    await interaction.editReply({
      embeds: [new EmbedBuilder().setTitle("🎴 バカラ").setDescription(`❌ 賭け金が上限（**${maxBet.toLocaleString()}** ${currencyName}）を超えています。`).setColor(COLOR_LOSE)],
      components: [],
    });
    return;
  }

  const afterDeduct = await deductBet(guildId, userId, bet);
  if (!afterDeduct) {
    await interaction.editReply({
      embeds: [new EmbedBuilder().setTitle("🎴 バカラ").setDescription("❌ 残高が不足しています。").setColor(COLOR_LOSE)],
      components: [],
    });
    return;
  }

  // ディール
  let deck = buildShoe();
  let [c, rest] = drawCard(deck); const p1 = c; deck = rest;
  [c, rest] = drawCard(deck);     const b1 = c; deck = rest;
  [c, rest] = drawCard(deck);     const p2 = c; deck = rest;
  [c, rest] = drawCard(deck);     const b2 = c; deck = rest;

  const playerHand: Card[] = [p1, p2];
  const bankerHand: Card[] = [b1, b2];
  const suitEmojis = resolveSuitEmojis(settings);

  if (!willAnyDraw(playerHand, bankerHand)) {
    const { embeds, files } = await resolveAndPayout(
      guildId, userId, bet, betOn, playerHand, bankerHand, deck,
      currencyName, suitEmojis, cardPaths,
    );
    await interaction.editReply({ embeds, files, components: [buildBaccaratActionRow(guildId, userId, bet, betOn)] });
    return;
  }

  // ドロー必要 → ディール状態を表示してドローボタンを置く
  const dealCardBuffers = new Map<string, Buffer>();
  await cacheHandBuffers([...playerHand, ...bankerHand], cardPaths, dealCardBuffers);
  const { embeds: dealEmbeds, files: dealFiles, components } = await buildDealEmbeds(
    playerHand, bankerHand, betOn, bet, currencyName, suitEmojis, dealCardBuffers, guildId, userId,
  );

  const existingSession = baccaratSessions.get(key);
  if (existingSession) {
    clearTimeout(existingSession.timeoutHandle);
    baccaratSessions.delete(key);
  }

  const msg = await interaction.editReply({ embeds: dealEmbeds, files: dealFiles, components });

  const expiresAt = new Date(Date.now() + 60_000);
  await db.insert(baccaratSessionsTable).values({
    guildId, userId, bet, betOn,
    playerHand: JSON.stringify(playerHand),
    bankerHand: JSON.stringify(bankerHand),
    deck:       JSON.stringify(deck),
    currencyName, expiresAt,
  }).onConflictDoUpdate({
    target: [baccaratSessionsTable.guildId, baccaratSessionsTable.userId],
    set: {
      bet, betOn,
      playerHand: JSON.stringify(playerHand),
      bankerHand: JSON.stringify(bankerHand),
      deck:       JSON.stringify(deck),
      currencyName, expiresAt,
    },
  }).catch(() => {});

  let session: BaccaratSession;
  const timeoutHandle = setTimeout(async () => {
    baccaratSessions.delete(key);
    await db.delete(baccaratSessionsTable)
      .where(and(eq(baccaratSessionsTable.guildId, guildId), eq(baccaratSessionsTable.userId, userId)))
      .catch(() => {});
    try {
      const { embeds: rEmbeds, files: rFiles } = await resolveAndPayout(
        session.guildId, session.userId, session.bet, session.betOn,
        session.playerHand, session.bankerHand, session.deck,
        session.currencyName, session.suitEmojis, session.cardPaths,
      );
      const row = buildBaccaratActionRow(session.guildId, session.userId, session.bet, session.betOn);
      await session.message.edit({ embeds: rEmbeds, files: rFiles, components: [row] });
    } catch { /* non-fatal */ }
  }, 60_000);

  session = {
    guildId, userId, bet, betOn,
    playerHand, bankerHand, deck,
    currencyName, suitEmojis, cardPaths,
    message: msg as Message,
    timeoutHandle,
  };
  baccaratSessions.set(key, session);
  } finally {
    processingBaccaratReplays.delete(key);
  }
}

/** 「🏁 終了」ボタン押下 → セッション集計を表示して終了 */
export async function handleBaccaratQuitBtn(interaction: ButtonInteraction): Promise<void> {
  // custom ID: "baccarat:quit:{guildId}:{userId}"
  const payload  = interaction.customId.slice(BACCARAT_QUIT_PREFIX.length);
  const colonIdx = payload.indexOf(":");
  const guildId  = payload.slice(0, colonIdx);
  const userId   = payload.slice(colonIdx + 1);

  if (interaction.user.id !== userId) {
    await interaction.reply({ content: "❌ このゲームはあなたのものではありません。", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferUpdate();

  const pKey = sessionKey(guildId, userId);
  const ps   = baccaratPlaySessions.get(pKey);
  baccaratPlaySessions.delete(pKey);

  const settings     = await getGuildSettings(guildId);
  const summaryEmbed = buildBaccaratSummaryEmbed(
    ps?.totals ?? emptyCasinoResultTotals(),
    settings.currencyName,
  );
  await interaction.editReply({ embeds: [summaryEmbed], files: [], components: [] });
}

// ─── Command export ───────────────────────────────────────────────────────────

export const baccaratCommand = {
  data: new SlashCommandBuilder()
    .setName("baccarat")
    .setDescription("バカラ — ベット先を選んでカードを引こう！")
    .setDefaultMemberPermissions(0)
    .addIntegerOption((opt) =>
      opt
        .setName("bet")
        .setDescription(`賭け金（${MIN_BET.toLocaleString()}〜${MAX_BET.toLocaleString()}）`)
        .setMinValue(MIN_BET)
        .setMaxValue(MAX_BET)
        .setRequired(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("on")
        .setDescription("ベット先を選択")
        .setRequired(true)
        .addChoices(
          { name: "🔵 プレイヤー (1:1)", value: "player" },
          { name: "🔴 バンカー (0.95:1)", value: "banker" },
          { name: "🤝 タイ (8:1)", value: "tie" },
        ),
    ),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;
    await handlePlay(interaction);
  },
};
