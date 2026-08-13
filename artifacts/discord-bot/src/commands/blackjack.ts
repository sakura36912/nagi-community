/**
 * /blackjack — ブラックジャック
 * ヒット・スタンド・ダブルダウン対応。6デッキシュー。
 *
 * サブコマンド:
 *   play        : ゲームを開始する
 *   config suit : スート絵文字を登録する（管理者専用）
 *   config card : カード画像を登録する（管理者専用）
 */

import {
  ActionRowBuilder,
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
import { getBjCardImages, setBjCardImage } from "../lib/bjCardImages";
import { uploadImageFromUrl } from "../lib/gcsStorage";
import type { GuildSettings } from "@workspace/db";

// ─── Types ────────────────────────────────────────────────────────────────────

const SUITS = ["♠", "♥", "♦", "♣"] as const;
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;
type Suit = (typeof SUITS)[number];
type Rank = (typeof RANKS)[number];
interface Card { rank: Rank; suit: Suit }

type SuitEmojis = Record<Suit, string>;

/** スート Unicode → DB キー（"spade" 等）の変換マップ */
const SUIT_KEY: Record<Suit, string> = {
  "♠": "spade",
  "♥": "heart",
  "♦": "diamond",
  "♣": "club",
};

interface BJGame {
  guildId: string;
  userId: string;
  bet: number;
  playerHand: Card[];
  dealerHand: Card[];
  deck: Card[];
  doubled: boolean;
  currencyName: string;
  /** balance after initial bet deduction */
  balance: number;
  expiresAt: number;
  /** カスタムスート絵文字（ゲーム開始時にDBから取得） */
  suitEmojis: SuitEmojis;
  /**
   * カード画像マップ。キー: "rank:suit"（例 "A:spade"）、値: GCS 公開 URL。
   * 未登録のカードは画像なし。
   */
  cardImages: Map<string, string>;
}

type Outcome = "blackjack" | "win" | "push" | "lose";

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_BET = 10;
const MAX_BET = 100_000;
const GAME_TTL_MS = 5 * 60 * 1000;

const COLOR_NEUTRAL = 0x5865f2;
const COLOR_WIN     = 0x57f287;
const COLOR_LOSE    = 0xed4245;
const COLOR_PUSH    = 0xfee75c;

export const BJ_PREFIX = "bj:";

// ─── In-memory game state ─────────────────────────────────────────────────────

const activeGames = new Map<string, BJGame>();

function gameKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, game] of activeGames) {
    if (game.expiresAt < now) activeGames.delete(key);
  }
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

/**
 * カードに対応する画像 URL を返す。未登録なら undefined。
 * キー形式: "rank:suit"（例: "A:spade"）
 */
function resolveCardImageUrl(card: Card, cardImages: Map<string, string>): string | undefined {
  const suitKey = SUIT_KEY[card.suit];
  return cardImages.get(`${card.rank}:${suitKey}`);
}

/**
 * 手札の中で画像が登録されている最後のカードの URL を返す。
 * embed.image に設定するのに使う。
 */
function resolveHandImageUrl(hand: Card[], cardImages: Map<string, string>): string | undefined {
  for (let i = hand.length - 1; i >= 0; i--) {
    const url = resolveCardImageUrl(hand[i]!, cardImages);
    if (url) return url;
  }
  return undefined;
}

// ─── Deck helpers ─────────────────────────────────────────────────────────────

function buildShoe(decks = 6): Card[] {
  const shoe: Card[] = [];
  for (let i = 0; i < decks; i++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        shoe.push({ rank, suit });
      }
    }
  }
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shoe[i], shoe[j]] = [shoe[j]!, shoe[i]!];
  }
  return shoe;
}

function draw(deck: Card[]): [Card, Card[]] {
  return [deck[0]!, deck.slice(1)];
}

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

function formatCard(c: Card, emojis: SuitEmojis): string {
  return `${c.rank}${emojis[c.suit]}`;
}

function formatHand(hand: Card[], emojis: SuitEmojis, hideSecond = false): string {
  return hand.map((c, i) => (hideSecond && i === 1 ? "🎴" : formatCard(c, emojis))).join(" ");
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

async function creditAmount(
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

function buildGameEmbed(game: BJGame, hideDealer = true): EmbedBuilder {
  const pTotal = total(game.playerHand);
  const dKnown = total([game.dealerHand[0]!]);
  const e = game.suitEmojis;

  const dealerValue = hideDealer
    ? `${formatHand(game.dealerHand, e, true)}　（${dKnown}+?）`
    : `${formatHand(game.dealerHand, e)}　**${total(game.dealerHand)}**`;

  const embed = new EmbedBuilder()
    .setTitle("🃏 ブラックジャック")
    .setColor(COLOR_NEUTRAL)
    .addFields(
      {
        name: "あなたの手札",
        value: `${formatHand(game.playerHand, e)}　**${pTotal}**`,
      },
      { name: "ディーラーの手札", value: dealerValue },
      {
        name: "賭け金",
        value: `**${game.bet.toLocaleString()}** ${game.currencyName}${game.doubled ? "（ダブルダウン）" : ""}`,
        inline: true,
      },
      {
        name: "操作方法",
        value: "🃏 **ヒット** — 1枚追加　🛑 **スタンド** — このままで勝負　⬆️ **ダブルダウン** — 賭け倍額+1枚（初手のみ）",
      },
    )
    .setFooter({ text: "ブラックジャック=1.5倍 / 通常勝利=1倍 / 引き分け=返金 | 5分でタイムアウト" });

  // 最後に引いたプレイヤーのカード画像を表示
  const imageUrl = resolveHandImageUrl(game.playerHand, game.cardImages);
  if (imageUrl) embed.setImage(imageUrl);

  return embed;
}

function buildResultEmbed(
  game: BJGame,
  outcome: Outcome,
): EmbedBuilder {
  const title: Record<Outcome, string> = {
    blackjack: "🎉 ブラックジャック！",
    win:       "✅ 勝利！",
    push:      "🤝 引き分け（プッシュ）",
    lose:      "❌ 敗北",
  };
  const color: Record<Outcome, number> = {
    blackjack: COLOR_WIN,
    win:       COLOR_WIN,
    push:      COLOR_PUSH,
    lose:      COLOR_LOSE,
  };
  const { outcome: _outcome, netDelta } = resolveOutcome(game);
  const sign = netDelta > 0 ? "+" : "";
  const e = game.suitEmojis;

  const embed = new EmbedBuilder()
    .setTitle(`🃏 ブラックジャック — ${title[outcome]}`)
    .setColor(color[outcome])
    .addFields(
      {
        name: "あなたの手札",
        value: `${formatHand(game.playerHand, e)}　**${total(game.playerHand)}**`,
      },
      {
        name: "ディーラーの手札",
        value: `${formatHand(game.dealerHand, e)}　**${total(game.dealerHand)}**`,
      },
      {
        name: "収支",
        value: `${sign}${netDelta.toLocaleString()} ${game.currencyName}`,
        inline: true,
      },
    )
    .setTimestamp();

  // 結果embed: プレイヤーの最終カード画像を表示
  const imageUrl = resolveHandImageUrl(game.playerHand, game.cardImages);
  if (imageUrl) embed.setImage(imageUrl);

  return embed;
}

// ─── Buttons ──────────────────────────────────────────────────────────────────

function buildButtons(canDouble: boolean): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("bj:hit")
      .setLabel("ヒット")
      .setEmoji("🃏")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("bj:stand")
      .setLabel("スタンド")
      .setEmoji("🛑")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("bj:double")
      .setLabel("ダブルダウン")
      .setEmoji("⬆️")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!canDouble),
  );
}

// ─── Game logic ───────────────────────────────────────────────────────────────

function dealerPlay(game: BJGame): BJGame {
  let { dealerHand, deck } = game;
  while (total(dealerHand) < 17) {
    const [card, rest] = draw(deck);
    dealerHand = [...dealerHand, card];
    deck = rest;
  }
  return { ...game, dealerHand, deck };
}

function resolveOutcome(game: BJGame): { outcome: Outcome; netDelta: number } {
  const pTotal = total(game.playerHand);
  const dTotal = total(game.dealerHand);
  const pBJ = isBlackjack(game.playerHand) && !game.doubled;
  const dBJ = isBlackjack(game.dealerHand);

  if (pBJ && dBJ) return { outcome: "push",      netDelta: 0 };
  if (pBJ)        return { outcome: "blackjack",  netDelta: Math.floor(game.bet * 0.5) };
  if (isBust(game.playerHand))                    return { outcome: "lose", netDelta: -game.bet };
  if (dBJ || isBust(game.dealerHand) || pTotal > dTotal) return { outcome: "win", netDelta: game.bet };
  if (pTotal === dTotal)                          return { outcome: "push",  netDelta: 0 };
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
    blackjack: `ブラックジャック（賭け: ${bet}）`,
    win:       `ブラックジャック勝利（賭け: ${bet}）`,
    push:      `ブラックジャック引き分け（賭け: ${bet}）`,
    lose:      `ブラックジャック敗北（賭け: ${bet}）`,
  };
  if (netDelta !== 0) {
    await recordTransaction(guildId, userId, netDelta, logReason[outcome]).catch(() => {});
  }

  activeGames.delete(gameKey(guildId, userId));
  await interaction.editReply({
    embeds: [buildResultEmbed(game, outcome)],
    components: [],
  });
}

// ─── Button handler (called from index.ts) ────────────────────────────────────

export async function handleBlackjackButton(interaction: ButtonInteraction): Promise<void> {
  const { guildId, user } = interaction;
  if (!guildId) return;

  const key = gameKey(guildId, user.id);
  const game = activeGames.get(key);

  if (!game || game.expiresAt < Date.now()) {
    activeGames.delete(key);
    await interaction.reply({
      content: "ゲームが見つかりません（タイムアウトの可能性あり）。`/blackjack play` で新しいゲームを始めてください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (game.userId !== user.id) {
    await interaction.reply({
      content: "このゲームはあなたのものではありません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();

  const action = interaction.customId.slice(BJ_PREFIX.length);

  if (action === "hit") {
    const [card, newDeck] = draw(game.deck);
    game.playerHand = [...game.playerHand, card];
    game.deck = newDeck;
    activeGames.set(key, game);

    if (isBust(game.playerHand) || total(game.playerHand) === 21) {
      const finished = dealerPlay(game);
      activeGames.set(key, finished);
      await finishGame(interaction, finished);
      return;
    }

    await interaction.editReply({
      embeds: [buildGameEmbed(game, true)],
      components: [buildButtons(false)],
    });

  } else if (action === "stand") {
    const finished = dealerPlay(game);
    activeGames.set(key, finished);
    await finishGame(interaction, finished);

  } else if (action === "double") {
    const extra = await deductBet(guildId, user.id, game.bet);
    if (!extra) {
      await interaction.followUp({
        content: "残高が不足しているためダブルダウンできません。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    game.bet *= 2;
    game.doubled = true;
    game.balance = extra.balance;

    const [card, newDeck] = draw(game.deck);
    game.playerHand = [...game.playerHand, card];
    game.deck = newDeck;

    const finished = dealerPlay(game);
    activeGames.set(key, finished);
    await finishGame(interaction, finished);
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
    await interaction.reply({
      content: "すでにゲームが進行中です。先のゲームを終わらせてください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const [, settings, cardImages] = await Promise.all([
    getOrCreateWallet(guildId, userId),
    getGuildSettings(guildId),
    getBjCardImages(guildId),
  ]);

  const suitEmojis = resolveSuitEmojis(settings);

  const afterDeduct = await deductBet(guildId, userId, bet);
  if (!afterDeduct) {
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("🃏 ブラックジャック")
          .setDescription("❌ 残高が不足しています。")
          .setColor(COLOR_LOSE),
      ],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let deck = buildShoe();
  let playerHand: Card[] = [];
  let dealerHand: Card[] = [];
  let card: Card;

  [card, deck] = draw(deck); playerHand = [...playerHand, card];
  [card, deck] = draw(deck); dealerHand = [...dealerHand, card];
  [card, deck] = draw(deck); playerHand = [...playerHand, card];
  [card, deck] = draw(deck); dealerHand = [...dealerHand, card];

  const game: BJGame = {
    guildId,
    userId,
    bet,
    playerHand,
    dealerHand,
    deck,
    doubled: false,
    currencyName: settings.currencyName,
    balance: afterDeduct.balance,
    expiresAt: Date.now() + GAME_TTL_MS,
    suitEmojis,
    cardImages,
  };

  if (isBlackjack(playerHand)) {
    const finished = dealerPlay(game);
    await interaction.deferReply();
    await finishGame(interaction, finished);
    return;
  }

  activeGames.set(key, game);

  await interaction.reply({
    embeds: [buildGameEmbed(game, true)],
    components: [buildButtons(true)],
  });
}

// ─── /blackjack config suit ───────────────────────────────────────────────────

const SUIT_LABEL: Record<string, string> = {
  spade:   "♠️ スペード",
  heart:   "♥️ ハート",
  diamond: "♦️ ダイヤ",
  club:    "♣️ クラブ",
};

async function handleConfigSuit(interaction: ChatInputCommandInteraction): Promise<void> {
  const { guildId } = interaction;
  if (!guildId) return;

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "❌ このコマンドは管理者専用です。", flags: MessageFlags.Ephemeral });
    return;
  }

  const suit  = interaction.options.getString("suit", true) as "spade" | "heart" | "diamond" | "club";
  const emoji = interaction.options.getString("emoji")?.trim() || null;

  await setBjSuitEmoji(guildId, suit, emoji);

  const label   = SUIT_LABEL[suit] ?? suit;
  const display = emoji ?? "デフォルト（Unicode絵文字）";
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("🃏 ブラックジャック — スート絵文字設定")
        .setColor(COLOR_NEUTRAL)
        .addFields({ name: label, value: `→ ${display}` })
        .setFooter({ text: emoji ? "次回ゲームから反映されます" : "デフォルトにリセットしました" }),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

// ─── /blackjack config card ───────────────────────────────────────────────────

const RANK_CHOICES = RANKS.map((r) => ({ name: r, value: r }));
const SUIT_CHOICES = [
  { name: "♠️ スペード", value: "spade" },
  { name: "♥️ ハート",   value: "heart" },
  { name: "♦️ ダイヤ",   value: "diamond" },
  { name: "♣️ クラブ",   value: "club" },
];

async function handleConfigCard(interaction: ChatInputCommandInteraction): Promise<void> {
  const { guildId } = interaction;
  if (!guildId) return;

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "❌ このコマンドは管理者専用です。", flags: MessageFlags.Ephemeral });
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

  // 拡張子を判定
  const extMap: Record<string, string> = {
    "image/png":  "png",
    "image/jpeg": "jpg",
    "image/gif":  "gif",
    "image/webp": "webp",
  };
  const ext = extMap[attachment.contentType] ?? "png";

  // GCS にアップロード
  const gcsPath  = `bj-cards/${guildId}/${suit}/${rank}.${ext}`;
  let publicUrl: string;
  try {
    publicUrl = await uploadImageFromUrl(attachment.url, gcsPath, attachment.contentType);
  } catch (err) {
    await interaction.editReply(`❌ 画像のアップロードに失敗しました: ${String(err)}`);
    return;
  }

  await setBjCardImage(guildId, rank, suit, publicUrl);

  const suitLabel = SUIT_LABEL[suit] ?? suit;
  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle("🃏 ブラックジャック — カード画像設定")
        .setColor(COLOR_NEUTRAL)
        .setDescription(`**${rank} ${suitLabel}** の画像を登録しました`)
        .setImage(publicUrl)
        .setFooter({ text: "次回ゲームから反映されます" }),
    ],
  });
}

// ─── Command export ───────────────────────────────────────────────────────────

export const blackjackCommand = {
  data: new SlashCommandBuilder()
    .setName("blackjack")
    .setDescription("ブラックジャック")
    .addSubcommand((sub) =>
      sub
        .setName("play")
        .setDescription("ブラックジャック — 21を目指せ！BJ=1.5倍・通常勝利=1倍")
        .addIntegerOption((opt) =>
          opt
            .setName("bet")
            .setDescription(`賭け金（${MIN_BET}〜${MAX_BET.toLocaleString()}）`)
            .setMinValue(MIN_BET)
            .setMaxValue(MAX_BET)
            .setRequired(true),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("config")
        .setDescription("【管理者】ブラックジャックの見た目を設定する")
        .addSubcommand((sub) =>
          sub
            .setName("suit")
            .setDescription("スートの絵文字を設定する")
            .addStringOption((opt) =>
              opt
                .setName("suit")
                .setDescription("設定するスート")
                .setRequired(true)
                .addChoices(...SUIT_CHOICES),
            )
            .addStringOption((opt) =>
              opt
                .setName("emoji")
                .setDescription("使用する絵文字（例: <:spade:1234567890>）。省略するとリセット")
                .setRequired(false),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("card")
            .setDescription("カード画像を登録する（1枚ずつ添付してアップロード）")
            .addStringOption((opt) =>
              opt
                .setName("rank")
                .setDescription("カードのランク")
                .setRequired(true)
                .addChoices(...RANK_CHOICES),
            )
            .addStringOption((opt) =>
              opt
                .setName("suit")
                .setDescription("カードのスート")
                .setRequired(true)
                .addChoices(...SUIT_CHOICES),
            )
            .addAttachmentOption((opt) =>
              opt
                .setName("image")
                .setDescription("カードの画像ファイル（PNG / JPG / GIF / WebP）")
                .setRequired(true),
            ),
        ),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const sub   = interaction.options.getSubcommand();
    const group = interaction.options.getSubcommandGroup(false);

    if (sub === "play") {
      await handlePlay(interaction);
    } else if (group === "config") {
      if (sub === "suit") {
        await handleConfigSuit(interaction);
      } else if (sub === "card") {
        await handleConfigCard(interaction);
      }
    }
  },
};
