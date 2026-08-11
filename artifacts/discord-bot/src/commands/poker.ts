/**
 * /poker — 5カードドロー ビデオポーカー（ジャックスオアベター形式）
 *
 * フロー:
 *   1. /poker play <bet> → 5枚配る (deal フェーズ)
 *   2. カードボタンをクリックでホールド/アンホールド切り替え
 *   3. "ドロー" ボタンでアンホールド牌を交換 → 役判定 → 結果表示
 */

import {
  ActionRowBuilder,
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

// ─── Types ────────────────────────────────────────────────────────────────────

const SUITS = ["♠", "♥", "♦", "♣"] as const;
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;
type Suit = (typeof SUITS)[number];
type Rank = (typeof RANKS)[number];
interface Card { rank: Rank; suit: Suit }

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
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function draw(deck: Card[]): [Card, Card[]] { return [deck[0], deck.slice(1)]; }

// ─── Card display ─────────────────────────────────────────────────────────────

const SUIT_EMOJI: Record<Suit, string> = { "♠": "♠️", "♥": "♥️", "♦": "♦️", "♣": "♣️" };

function fmtCard(c: Card): string { return `${c.rank}${SUIT_EMOJI[c.suit]}`; }

// ─── Hand evaluation ──────────────────────────────────────────────────────────

const RANK_ORDER: Record<Rank, number> = {
  "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7,
  "8": 8, "9": 9, "10": 10, J: 11, Q: 12, K: 13, A: 14,
};

function evaluate(hand: Card[]): HandRank {
  const vals = hand.map((c) => RANK_ORDER[c.rank]).sort((a, b) => a - b);
  const suits = hand.map((c) => c.suit);
  const isFlush = suits.every((s) => s === suits[0]);

  // ストレート判定（A-2-3-4-5 含む）
  const isStraight =
    vals[4] - vals[0] === 4 && new Set(vals).size === 5
    || (vals.join(",") === "2,3,4,5,14"); // A ロー

  const rankCounts = new Map<number, number>();
  for (const v of vals) rankCounts.set(v, (rankCounts.get(v) ?? 0) + 1);
  const counts = [...rankCounts.values()].sort((a, b) => b - a);

  if (isFlush && isStraight && vals[0] === 10) return "royal_flush";
  if (isFlush && isStraight)                   return "straight_flush";
  if (counts[0] === 4)                          return "four_of_a_kind";
  if (counts[0] === 3 && counts[1] === 2)       return "full_house";
  if (isFlush)                                  return "flush";
  if (isStraight)                               return "straight";
  if (counts[0] === 3)                          return "three_of_a_kind";
  if (counts[0] === 2 && counts[1] === 2)       return "two_pair";
  if (counts[0] === 2) {
    // ペアが J/Q/K/A かどうか
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

function buildCardRows(hand: Card[], held: boolean[]): ActionRowBuilder<ButtonBuilder>[] {
  // Row 1: 5 card toggle buttons
  const cardRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    hand.map((c, i) =>
      new ButtonBuilder()
        .setCustomId(`poker:hold:${i}`)
        .setLabel(held[i] ? `🔒 ${fmtCard(c)}` : fmtCard(c))
        .setStyle(held[i] ? ButtonStyle.Success : ButtonStyle.Secondary),
    ),
  );
  // Row 2: Draw button
  const drawRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("poker:draw")
      .setLabel("ドロー")
      .setEmoji("🃏")
      .setStyle(ButtonStyle.Primary),
  );
  return [cardRow, drawRow];
}

function buildDealEmbed(game: PokerGame): EmbedBuilder {
  const heldCount = game.held.filter(Boolean).length;
  const holdDesc = heldCount === 0
    ? "カードをクリックしてホールド、「ドロー」で残りを交換"
    : `${heldCount}枚ホールド中`;

  return new EmbedBuilder()
    .setTitle("🃏 ポーカー — カードを選んでドロー")
    .setColor(COLOR_NEUTRAL)
    .addFields(
      {
        name: "手札",
        value: game.hand.map((c, i) => (game.held[i] ? `__${fmtCard(c)}__` : fmtCard(c))).join("  "),
      },
      { name: "賭け金", value: `**${game.bet.toLocaleString()}** ${game.currencyName}`, inline: true },
      { name: "状態", value: holdDesc, inline: true },
    )
    .setFooter({ text: "役・配当: J以上ペア×1 | 2ペア×2 | スリー×3 | ストレート×4 | フラッシュ×6 | フルハウス×9 | フォーカ×25 | SF×50 | RF×250 | 5分でタイムアウト" });
}

function buildResultEmbed(game: PokerGame, handRank: HandRank, netDelta: number): EmbedBuilder {
  const multiplier = PAYOUT[handRank];
  const isWin = multiplier > 0;
  const sign = netDelta > 0 ? "+" : "";

  return new EmbedBuilder()
    .setTitle(`🃏 ポーカー — ${HAND_LABEL[handRank]}`)
    .setColor(isWin ? COLOR_WIN : COLOR_LOSE)
    .addFields(
      {
        name: "最終手札",
        value: game.hand.map(fmtCard).join("  "),
      },
      {
        name: "収支",
        value: `${sign}${netDelta.toLocaleString()} ${game.currencyName}`,
        inline: true,
      },
      ...(multiplier > 0
        ? [{ name: "倍率", value: `${multiplier}x`, inline: true }]
        : []),
    )
    .setTimestamp();
}

// ─── Finish game ──────────────────────────────────────────────────────────────

async function finishGame(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  game: PokerGame,
): Promise<void> {
  const handRank = evaluate(game.hand);
  const multiplier = PAYOUT[handRank];
  const { guildId, userId, bet } = game;

  let netDelta: number;
  if (multiplier === 0) {
    netDelta = -bet;
  } else {
    const winnings = bet * multiplier;
    await creditAmount(guildId, userId, bet + winnings); // 元本返却 + 払い戻し
    netDelta = winnings;
  }

  if (netDelta !== 0) {
    const reason = `ポーカー ${HAND_LABEL[handRank]}（賭け: ${bet}）`;
    await recordTransaction(guildId, userId, netDelta, reason).catch(() => {});
  }

  activeGames.delete(gameKey(guildId, userId));
  await interaction.editReply({
    embeds: [buildResultEmbed(game, handRank, netDelta)],
    components: [],
  });
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

  if (game.phase === "done") return;

  await interaction.deferUpdate();

  const action = interaction.customId.slice(POKER_PREFIX.length); // "hold:0"〜"hold:4" or "draw"

  if (action.startsWith("hold:")) {
    const idx = parseInt(action.slice(5), 10);
    if (idx >= 0 && idx < 5) {
      game.held[idx] = !game.held[idx];
      activeGames.set(key, game);
      await interaction.editReply({
        embeds: [buildDealEmbed(game)],
        components: buildCardRows(game.hand, game.held),
      });
    }
    return;
  }

  if (action === "draw") {
    // アンホールドのカードを交換
    let { deck } = game;
    for (let i = 0; i < 5; i++) {
      if (!game.held[i]) {
        const [card, rest] = draw(deck);
        game.hand[i] = card;
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

  const [, { currencyName }] = await Promise.all([
    getOrCreateWallet(guildId, userId),
    getGuildSettings(guildId),
  ]);

  const afterDeduct = await deductBet(guildId, userId, bet);
  if (!afterDeduct) {
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("🃏 ポーカー")
          .setDescription("❌ 残高が不足しています。")
          .setColor(COLOR_LOSE),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let deck = buildDeck();
  const hand: Card[] = [];
  for (let i = 0; i < 5; i++) {
    const [card, rest] = draw(deck);
    hand.push(card);
    deck = rest;
  }

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
  };

  activeGames.set(key, game);

  await interaction.reply({
    embeds: [buildDealEmbed(game)],
    components: buildCardRows(game.hand, game.held),
  });
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
