import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type GuildMember,
  type ModalSubmitInteraction,
  type VoiceState,
} from "discord.js";
import {
  applyDealerCasinoChohanStreakDecision,
  cancelDealerCasinoGame,
  createDealerCasinoGame,
  dealDealerCasinoPoker,
  DealerCasinoError,
  endDealerCasinoSession,
  getActiveDealerCasinoGame,
  getDealerCasinoGame,
  getLatestDealerCasinoGame,
  getDealerCasinoStats,
  getDealerCasinoSettings,
  getDealerCasinoStreak,
  listDealerCasinoBets,
  placeDealerCasinoBet,
  recordDealerCasinoResult,
  resetDealerCasinoChohanStreak,
  setDealerCasinoPanelMessage,
  setDealerCasinoSettings,
  settleDealerCasinoGame,
  transitionDealerCasinoGame,
  updateDealerCasinoBet,
  updateDealerCasinoPlay,
  withdrawDealerCasinoBet,
  type ChohanStreakDecision,
  type DealerCasinoBet,
  type DealerCasinoGame,
  type DealerCasinoOutcome,
  type DealerCasinoSettings,
  type DealerCasinoType,
} from "@workspace/db";
import {
  calculatePayout,
  comparePokerHandValues,
  dealThreeCardPoker,
  evaluatePokerHand,
  getChohanStreakMultiplier,
  getPokerPayoutMultiplier,
  isDealerQualified,
  rollChohan,
  type CardRank,
  type ChohanStreakMultiplier,
  type PokerCard,
  type PokerHandRank,
  type PokerHandValue,
} from "../lib/dealerCasinoRules";
import { getGuildSettings } from "../lib/economy";
import { buildBlackjackCardStrip } from "../lib/casinoCardImages";
import { isConfiguredHubVoice } from "../lib/configuredHubVoice";
import { logger } from "../lib/logger";

export const DEALER_CASINO_PREFIX = "dealer-casino:";

const COLOR = 0x123f53;
const LABELS: Record<DealerCasinoType, string> = {
  chohan: "🎲 丁半",
  poker: "🎴 スリーカードポーカー",
};
const HAND_LABELS: Record<PokerHandRank, string> = {
  "straight-flush": "ストレートフラッシュ",
  "three-of-a-kind": "スリーカード",
  straight: "ストレート",
  flush: "フラッシュ",
  pair: "ペア",
  "high-card": "ハイカード",
};
const SUIT_LABELS: Record<PokerCard["suit"], string> = {
  spades: "♠️",
  hearts: "♥️",
  diamonds: "♦️",
  clubs: "♣️",
};
const RANK_LABELS: Record<number, string> = {
  11: "J",
  12: "Q",
  13: "K",
  14: "A",
};

type DealerResult = {
  kind: "chohan" | "poker";
  dice?: [number, number];
  total?: number;
  result?: "cho" | "han";
  dealerCards?: string[];
  dealerHand?: PokerHandValue;
  dealerQualified?: boolean;
  outcomes: DealerCasinoOutcome[];
  players: Array<{
    userId: string;
    cards?: string[];
    hand?: PokerHandValue;
    result: string;
  }>;
};

let recoveryStarted = false;

function isAdmin(member: GuildMember): boolean {
  return member.permissions.has(PermissionFlagsBits.Administrator);
}

async function memberFor(interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction): Promise<GuildMember | null> {
  if (!interaction.guild) return null;
  return interaction.guild.members.fetch(interaction.user.id);
}

function memberHasRole(member: GuildMember, roleId: string | null | undefined): boolean {
  return Boolean(roleId && member.roles.cache.has(roleId));
}

function isCasinoManager(member: GuildMember, settings: DealerCasinoSettings | null): boolean {
  return isAdmin(member) || memberHasRole(member, settings?.adminRoleId);
}

function isDealer(member: GuildMember, settings: DealerCasinoSettings): boolean {
  return isCasinoManager(member, settings) ||
    memberHasRole(member, settings.dealerRoleId) ||
    memberHasRole(member, settings.directorRoleId);
}

async function requireDealer(
  interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction,
  settings: DealerCasinoSettings | null,
): Promise<GuildMember> {
  const member = await memberFor(interaction);
  if (!member || !settings || !isDealer(member, settings)) {
    throw new Error("賭博師・賭博統領・指定管理者のみ操作できます。");
  }
  if (!await isConfiguredHubVoice(interaction.guildId ?? "", member.voice.channelId, settings.voiceChannelId)) {
    throw new Error("操作する賭博師は、設定された賭博場VCまたはその転送先VCに入室してください。");
  }
  return member;
}

async function requireGameParticipant(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  game: DealerCasinoGame,
): Promise<GuildMember> {
  const member = await memberFor(interaction);
  if (!member || member.voice.channelId !== game.voiceChannelId) {
    throw new Error("賭博場VCに参加しているメンバーのみ操作できます。");
  }
  if (member.id === game.dealerId) {
    throw new Error("ディーラー本人は自分が進行するゲームに参加できません。");
  }
  return member;
}

function errorMessage(error: unknown): string {
  if (error instanceof DealerCasinoError) return error.message;
  if (error instanceof Error) return error.message;
  return "賭博場の処理に失敗しました。時間をおいて、進行状況を確認してください。";
}

async function replyDealerCommand(
  interaction: ChatInputCommandInteraction,
  payload: { content?: string; embeds?: EmbedBuilder[] },
): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload);
  } else {
    await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }
}

function integerValue(raw: string, label: string, min = 1, max = 2_147_483_647): number {
  if (!/^\d+$/.test(raw)) throw new Error(`${label}は整数で入力してください。`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label}は${min.toLocaleString()}〜${max.toLocaleString()}の範囲で指定してください。`);
  }
  return value;
}

function parseOnOff(raw: string, label: string): 0 | 1 {
  const value = raw.trim().toLowerCase();
  if (value === "on" || value === "オン" || value === "true" || value === "1") return 1;
  if (value === "off" || value === "オフ" || value === "false" || value === "0") return 0;
  throw new Error(`${label}は on または off で指定してください。`);
}

function positiveMultiplier(raw: string, label: string): number {
  if (!/^\d+(?:\.\d{1,6})?$/.test(raw.trim())) {
    throw new Error(`${label}は小数点以下6桁までの正の倍率で入力してください。`);
  }
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value <= 0 || value >= 1_000_000) {
    throw new Error(`${label}は0より大きく1,000,000未満で指定してください。`);
  }
  return value;
}

function parseStreakMultipliers(raw: string): ChohanStreakMultiplier[] {
  const entries = raw.split(",").map((piece) => {
    const [thresholdText, multiplierText, ...rest] = piece.trim().split(":");
    if (!thresholdText || !multiplierText || rest.length) {
      throw new Error("連勝倍率は「1:2,2:2.2,3:2.5」の形式で指定してください。");
    }
    const minimumWinStreak = integerValue(thresholdText, "適用連勝数", 1, 1_000_000);
    const multiplier = positiveMultiplier(multiplierText, "丁半の連勝倍率");
    return { minimumWinStreak, multiplier };
  });
  if (!entries.length) throw new Error("連勝倍率を1つ以上指定してください。");
  entries.sort((a, b) => a.minimumWinStreak - b.minimumWinStreak);
  if (new Set(entries.map((entry) => entry.minimumWinStreak)).size !== entries.length) {
    throw new Error("同じ連勝数の倍率を複数回指定できません。");
  }
  return entries;
}

function parseBonusMultipliers(raw: string): Partial<Record<PokerHandRank, number>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("役別倍率はJSONオブジェクトで入力してください。例: {\"pair\":2.5,\"flush\":3}");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("役別倍率はJSONオブジェクトで入力してください。");
  }
  const valid = new Set<PokerHandRank>([
    "straight-flush", "three-of-a-kind", "straight", "flush", "pair", "high-card",
  ]);
  const entries = Object.entries(parsed);
  if (!entries.length) throw new Error("役別倍率を1つ以上指定してください。");
  for (const [key, value] of entries) {
    if (!valid.has(key as PokerHandRank) || typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error("倍率JSONの役名または数値が不正です。");
    }
  }
  const missing = [...valid].filter((key) => !(key in parsed));
  if (missing.length) {
    throw new Error(`役ボーナスを有効にする場合は全6役を設定してください。不足: ${missing.map((key) => HAND_LABELS[key]).join("、")}`);
  }
  return parsed as Partial<Record<PokerHandRank, number>>;
}

function readConfiguredChohanMultipliers(settings: DealerCasinoSettings): ChohanStreakMultiplier[] {
  if (!settings.chohanMultipliers) throw new Error("丁半の連勝倍率が未設定です。管理者が設定してください。");
  const entries = Object.entries(settings.chohanMultipliers).map(([minimumWinStreak, multiplier]) => ({
    minimumWinStreak: integerValue(minimumWinStreak, "適用連勝数"),
    multiplier,
  }));
  if (!entries.length) throw new Error("丁半の連勝倍率が未設定です。");
  return entries.sort((a, b) => a.minimumWinStreak - b.minimumWinStreak);
}

function serializeCard(card: PokerCard): string {
  return `${card.suit}:${card.rank}`;
}

function parseCard(raw: string): PokerCard {
  const [suit, rankText] = raw.split(":");
  const rank = Number(rankText);
  if (!["spades", "hearts", "diamonds", "clubs"].includes(suit ?? "") ||
      !Number.isInteger(rank) || rank < 2 || rank > 14) {
    throw new Error("保存されたカード情報を読み取れません。ゲームをキャンセルして返金してください。");
  }
  return { suit: suit as PokerCard["suit"], rank: rank as CardRank };
}

function actionDeadlineMs(game: DealerCasinoGame): number | null {
  const value = game.actionDeadline as Date | string | null | undefined;
  if (!value) return null;
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function persistedDealerCards(game: DealerCasinoGame): PokerCard[] | null {
  if (!game.dealerCards || game.dealerCards.length !== 3) return null;
  try {
    const cards = game.dealerCards.map(parseCard);
    return new Set(cards.map(serializeCard)).size === 3 ? cards : null;
  } catch {
    return null;
  }
}

function formatCard(card: PokerCard): string {
  return `${SUIT_LABELS[card.suit]}${RANK_LABELS[card.rank] ?? card.rank}`;
}

function formatCards(cards: readonly PokerCard[]): string {
  return cards.map(formatCard).join(" ");
}

function handLabel(hand: PokerHandValue): string {
  return HAND_LABELS[hand.rank];
}

function parseCardRankValue(raw: string): CardRank {
  const normalized = raw.trim().toUpperCase();
  const rank = ({ J: 11, Q: 12, K: 13, A: 14 } as Record<string, number>)[normalized] ??
    Number(normalized);
  if (!Number.isInteger(rank) || rank < 2 || rank > 14) {
    throw new Error("ハイカードの最低値は2〜10、J、Q、K、Aのいずれかで指定してください。");
  }
  return rank as CardRank;
}

function resultFromGame(game: DealerCasinoGame): DealerResult {
  if (!game.result || typeof game.result !== "object") {
    throw new Error("確定したゲーム結果が保存されていません。精算を続行できません。");
  }
  const result = game.result as Partial<DealerResult>;
  if ((result.kind !== "chohan" && result.kind !== "poker") || !Array.isArray(result.outcomes)) {
    throw new Error("保存済みのゲーム結果が破損しています。自動精算を停止しました。");
  }
  return result as DealerResult;
}

function statusLabel(state: string): string {
  const labels: Record<string, string> = {
    RECRUITING: "参加受付中",
    CLOSED: "受付終了",
    PLAYING: "ゲーム進行中",
    RESULT: "結果確定・精算待ち",
    PAYOUT: "精算中",
    FINISHED: "終了",
    CANCELLED: "キャンセル済み",
  };
  return labels[state] ?? state;
}

export function gameEmbed(game: DealerCasinoGame, settings: DealerCasinoSettings | null, bets: DealerCasinoBet[]): EmbedBuilder {
  const kind = game.gameType as DealerCasinoType;
  const title = LABELS[kind] ?? "🎲 賭博場ゲーム";
  const description = [
    `ディーラー: <@${game.dealerId}>`,
    `賭け金: **${settings?.minBet.toLocaleString() ?? "未設定"}〜${settings?.maxBet.toLocaleString() ?? "未設定"}**`,
    `状態: **${statusLabel(game.state)}**`,
    `参加人数: **${bets.length}${settings?.maxPlayers ? `/${settings.maxPlayers}` : ""}**`,
  ];
  if (game.state === "RECRUITING") {
    description.push(kind === "chohan"
      ? "丁または半を選び、掛け金を入力してください。賭博師は「受付終了」ボタンで締め切れます。"
      : "「参加」から掛け金を入力してください。カードは配布開始後、本人だけに表示されます。");
  } else if (kind === "chohan" && game.state === "CLOSED") {
    description.push("賭博師は「抽選して精算」ボタンを押すと結果確定と精算を行えます。");
  } else if (kind === "poker" && game.state === "PLAYING") {
    description.push("カードを確認して「続行」または「フォールド」を選んでください。");
  }
  if (game.gameType === "poker" && game.result &&
      (game.state === "RESULT" || game.state === "PAYOUT" || game.state === "FINISHED")) {
    const result = resultFromGame(game);
    if (result.kind === "poker" && result.dealerCards && result.dealerHand) {
      description.push(`公開されたディーラーの手札: ${formatCards(result.dealerCards.map(parseCard))} — **${handLabel(result.dealerHand)}**`);
    }
  }
  if (game.state === "FINISHED" && game.result) {
    const result = resultFromGame(game);
    if (result.kind === "chohan") {
      description.push(`出目: 🎲 ${result.dice?.[0]} + 🎲 ${result.dice?.[1]} = **${result.total}**（**${result.result === "cho" ? "丁" : "半"}**）`);
    }
    const dealerTransfer = bets
      .filter((bet) => bet.state === "LOST" || bet.state === "FOLDED")
      .reduce((total, bet) => total + (game.gameType === "chohan"
        ? Math.floor(bet.betAmount / 4)
        : bet.betAmount), 0);
    description.push(`ディーラーへの送金額: **${dealerTransfer.toLocaleString()}＄**`);
    const summaries = result.outcomes.map((outcome) => {
      const player = result.players.find((entry) => entry.userId === outcome.userId);
      const hand = player?.hand ? ` (${handLabel(player.hand)})` : "";
      const payout = `${outcome.payout.toLocaleString()}＄`;
      return `<@${outcome.userId}>${hand}: **${resultText(outcome.result)}** — 払戻 ${payout}`;
    });
    if (summaries.length) description.push("", ...summaries);
  }
  return new EmbedBuilder()
    .setTitle(title)
    .setColor(COLOR)
    .setDescription(description.join("\n"))
    .setFooter({ text: `Game #${game.id} • ${statusLabel(game.state)}` })
    .setTimestamp(game.createdAt);
}

async function publicDealerCardStrip(game: DealerCasinoGame) {
  if (game.gameType !== "poker" || !game.result) return null;
  const result = resultFromGame(game);
  if (result.kind !== "poker" || !result.dealerCards) return null;
  return buildBlackjackCardStrip(game.guildId, result.dealerCards.map(parseCard), `poker-dealer-${game.id}.png`);
}

function resultText(result: string): string {
  if (result === "WON") return "勝利";
  if (result === "DRAW") return "引き分け";
  if (result === "FOLDED") return "フォールド";
  if (result === "LOST") return "敗北";
  return result;
}

export function gameComponents(game: DealerCasinoGame): ActionRowBuilder<ButtonBuilder>[] {
  const id = game.id;
  if (game.state === "RECRUITING") {
    if (game.gameType === "chohan") {
      return [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`${DEALER_CASINO_PREFIX}bet:${id}:cho`).setLabel("🟦 丁に賭ける").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`${DEALER_CASINO_PREFIX}bet:${id}:han`).setLabel("🟥 半に賭ける").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`${DEALER_CASINO_PREFIX}change:${id}`).setLabel("💰 掛け金変更").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`${DEALER_CASINO_PREFIX}withdraw:${id}`).setLabel("❌ 参加取消").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`${DEALER_CASINO_PREFIX}dealer-close:${id}`).setLabel("🔒 受付終了").setStyle(ButtonStyle.Secondary),
      )];
    }
    return [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${DEALER_CASINO_PREFIX}join:${id}`).setLabel("🎴 参加").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${DEALER_CASINO_PREFIX}change:${id}`).setLabel("💰 掛け金変更").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`${DEALER_CASINO_PREFIX}withdraw:${id}`).setLabel("❌ 参加取消").setStyle(ButtonStyle.Secondary),
    )];
  }
  if (game.gameType === "chohan" && game.state === "CLOSED") {
    return [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${DEALER_CASINO_PREFIX}dealer-roll:${id}`).setLabel("🎲 抽選して精算").setStyle(ButtonStyle.Success),
    )];
  }
  if (game.gameType === "poker" && game.state === "PLAYING") {
    return [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${DEALER_CASINO_PREFIX}hand:${id}`).setLabel("🂠 自分のカードを見る").setStyle(ButtonStyle.Primary),
    )];
  }
  if (game.gameType === "chohan" && game.state === "FINISHED" && game.result) {
    const result = resultFromGame(game);
    if (result.outcomes.some((outcome) => outcome.result === "WON")) {
      return [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`${DEALER_CASINO_PREFIX}streak:${id}:continue`).setLabel("🔥 連勝に挑戦").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`${DEALER_CASINO_PREFIX}streak:${id}:cashout`).setLabel("💰 勝ち逃げ").setStyle(ButtonStyle.Secondary),
      )];
    }
  }
  return [];
}

async function editPanel(client: Client, game: DealerCasinoGame): Promise<void> {
  if (!game.panelMessageId) return;
  const [settings, bets] = await Promise.all([
    getDealerCasinoSettings(game.guildId),
    listDealerCasinoBets(game.id),
  ]);
  const channel = await client.channels.fetch(game.channelId).catch(() => null);
  if (!channel?.isTextBased() || !("messages" in channel)) return;
  const message = await channel.messages.fetch(game.panelMessageId).catch(() => null);
  if (!message) return;
  const dealerStrip = await publicDealerCardStrip(game);
  const embed = gameEmbed(game, settings, bets);
  if (dealerStrip) embed.setImage(`attachment://${dealerStrip.filename}`);
  await message.edit({
    embeds: [embed],
    components: gameComponents(game),
    files: dealerStrip ? [dealerStrip.attachment] : [],
    attachments: [],
    allowedMentions: { parse: [] },
  });
}

async function postResults(game: DealerCasinoGame, client: Client): Promise<void> {
  await editPanel(client, game);
  const settings = await getDealerCasinoSettings(game.guildId);
  if (!settings?.logChannelId) return;
  const logChannel = await client.channels.fetch(settings.logChannelId).catch(() => null);
  if (!logChannel?.isTextBased() || !("send" in logChannel)) return;
  const bets = await listDealerCasinoBets(game.id);
  const dealerStrip = await publicDealerCardStrip(game);
  const embed = gameEmbed(game, settings, bets).setTitle(`📜 精算ログ — Game #${game.id}`);
  if (dealerStrip) embed.setImage(`attachment://${dealerStrip.filename}`);
  await logChannel.send({
    embeds: [embed],
    files: dealerStrip ? [dealerStrip.attachment] : [],
    allowedMentions: { parse: [] },
  });
}

async function publishSettledResultSafely(
  game: DealerCasinoGame,
  client: Client,
  alreadySettled: boolean,
): Promise<boolean> {
  try {
    if (alreadySettled) await editPanel(client, game);
    else await postResults(game, client);
    return true;
  } catch (error) {
    logger.error(`[dealer-casino] game ${game.id} was settled, but result UI/log publishing failed`, error);
    return false;
  }
}

async function replyAfterSettlement(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  content: string,
): Promise<void> {
  try {
    if (interaction.isButton()) {
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content });
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    } else {
      await replyDealerCommand(interaction, { content });
    }
  } catch (error) {
    logger.error("[dealer-casino] settlement completed but ephemeral confirmation failed", error);
  }
}

async function postPanel(interaction: ChatInputCommandInteraction, game: DealerCasinoGame): Promise<void> {
  const channel = interaction.channel;
  if (!channel?.isTextBased() || !("send" in channel)) {
    await cancelDealerCasinoGame(game.id);
    throw new Error("参加パネルを投稿できないチャンネルです。ゲームはキャンセルされ、参加者の賭け金は返金されました。");
  }
  const [settings, currency] = await Promise.all([
    getDealerCasinoSettings(game.guildId),
    getGuildSettings(game.guildId),
  ]);
  try {
    const message = await channel.send({
      embeds: [gameEmbed(game, settings, []).setDescription([
        `ディーラー: <@${game.dealerId}>`,
        `掛け金: **${settings?.minBet.toLocaleString()}〜${settings?.maxBet.toLocaleString()} ${currency.currencyName}**`,
        "状態: **参加受付中**",
        "参加するには下の丁・半ボタンから予想と掛け金を入力してください。賭博師は「受付終了」ボタンで締め切れます。",
      ].join("\n"))],
      components: gameComponents(game),
      allowedMentions: { parse: [] },
    });
    await setDealerCasinoPanelMessage(game.id, message.id);
  } catch {
    const cancelled = await cancelDealerCasinoGame(game.id).catch(() => null);
    if (cancelled) await editPanel(interaction.client, cancelled.game).catch(() => undefined);
    throw new Error(`参加パネルの投稿に失敗したため、ゲームを${cancelled ? "キャンセルして返金しました" : "作成済みのまま残しています。管理者に確認してください"}。`);
  }
}

function settingsStatus(
  settings: DealerCasinoSettings | null,
  stats?: { chohanGames: number; pokerGames: number; playersServed: number },
): EmbedBuilder {
  if (!settings) {
    return new EmbedBuilder().setTitle("⚙️ 賭博師ゲーム設定").setColor(COLOR)
      .setDescription("設定がありません。まず `/casino setup game_vc` と `/casino setup dealer_roles` を実行してください。");
  }
  const streaks = settings.chohanMultipliers
    ? Object.entries(settings.chohanMultipliers).sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([count, multiplier]) => `${count}勝: ×${multiplier}`).join(" / ")
    : "未設定";
  return new EmbedBuilder().setTitle("⚙️ 賭博師ゲーム設定").setColor(COLOR).addFields(
    { name: "賭博場VC", value: settings.voiceChannelId ? `<#${settings.voiceChannelId}>` : "未設定", inline: true },
    { name: "ログ", value: settings.logChannelId ? `<#${settings.logChannelId}>` : "未設定", inline: true },
    { name: "利用ロール", value: settings.dealerRoleId ? `<@&${settings.dealerRoleId}>` : "未設定", inline: true },
    { name: "賭博頭領ロール", value: settings.directorRoleId ? `<@&${settings.directorRoleId}>` : "未設定", inline: true },
    { name: "進行可能な管理者ロール", value: settings.adminRoleId ? `<@&${settings.adminRoleId}>` : "未設定", inline: true },
    { name: "賭け金範囲", value: `${settings.minBet.toLocaleString()}〜${settings.maxBet.toLocaleString()}`, inline: true },
    { name: "最大参加人数", value: settings.maxPlayers?.toString() ?? "未設定", inline: true },
    { name: "丁半", value: settings.chohanEnabled === 1 ? `有効 — ${streaks}` : "無効または未設定", inline: false },
    { name: "丁半倍率上限", value: settings.chohanMaxStreakMultiplier === null ? "未設定" : `×${settings.chohanMaxStreakMultiplier}`, inline: true },
    { name: "丁半連勝維持", value: settings.streakRetentionSeconds === null ? "未設定" : `${Math.floor(settings.streakRetentionSeconds / 60)}分`, inline: true },
    { name: "ポーカー", value: settings.pokerEnabled === 1 ? "有効" : "無効または未設定", inline: true },
    { name: "ポーカー通常配当", value: settings.pokerBaseMultiplier === null ? "未設定" : `×${settings.pokerBaseMultiplier}`, inline: true },
    { name: "A-2-3", value: settings.pokerAceLowEnabled === null ? "未設定" : settings.pokerAceLowEnabled === 1 ? "有効" : "無効", inline: true },
    { name: "役ボーナス", value: settings.pokerBonusEnabled === null ? "未設定" : settings.pokerBonusEnabled === 1 ? "有効" : "無効", inline: true },
    {
      name: "ディーラー成立条件",
      value: settings.pokerDealerQualificationEnabled === null
        ? "未設定"
        : settings.pokerDealerQualificationEnabled === 1
          ? `有効 — ${settings.pokerDealerQualificationRank}${settings.pokerDealerMinimumHighCard ? `:${RANK_LABELS[settings.pokerDealerMinimumHighCard] ?? settings.pokerDealerMinimumHighCard}` : ""}`
          : "無効",
      inline: true,
    },
    { name: "カード選択タイムアウト", value: `${settings.pokerTimeoutSeconds}秒`, inline: true },
    { name: "活動pt換算", value: settings.activityPointsPerGame === null ? "未設定" : `ゲーム完了ごとに ${settings.activityPointsPerGame} pt`, inline: true },
    ...(stats ? [
      { name: "担当ゲーム数", value: `丁半 ${stats.chohanGames} / ポーカー ${stats.pokerGames}`, inline: true },
      { name: "対応参加者数", value: stats.playersServed.toLocaleString(), inline: true },
      {
        name: "活動pt参考値",
        value: settings.activityPointsPerGame === null
          ? "換算設定なし"
          : `${((stats.chohanGames + stats.pokerGames) * settings.activityPointsPerGame).toLocaleString()} pt（現在の換算値で算出）`,
        inline: true,
      },
    ] : []),
  );
}

async function configureRule(interaction: ChatInputCommandInteraction): Promise<string> {
  const guildId = interaction.guildId;
  if (!guildId) throw new Error("サーバー内でのみ設定できます。");
  const key = interaction.options.getString("key", true);
  const raw = interaction.options.getString("value", true);
  const current = await getDealerCasinoSettings(guildId);
  const update: Parameters<typeof setDealerCasinoSettings>[1] = {};
  switch (key) {
    case "min_bet":
      update.minBet = integerValue(raw, "最低掛け金");
      break;
    case "max_bet":
      update.maxBet = integerValue(raw, "最高掛け金");
      break;
    case "max_players":
      update.maxPlayers = integerValue(raw, "最大参加人数", 1);
      break;
    case "streak_multipliers": {
      const multipliers = parseStreakMultipliers(raw);
      update.chohanMultipliers = Object.fromEntries(multipliers.map((entry) => [entry.minimumWinStreak, entry.multiplier]));
      break;
    }
    case "streak_cap":
      update.chohanMaxStreakMultiplier = positiveMultiplier(raw, "丁半の連勝上限倍率");
      break;
    case "streak_minutes":
      update.streakRetentionSeconds = integerValue(raw, "連勝維持時間（分）", 1, 525_600) * 60;
      break;
    case "ace_low_straight":
      update.pokerAceLowEnabled = parseOnOff(raw, "A-2-3");
      break;
    case "poker_timeout":
      update.pokerTimeoutSeconds = integerValue(raw, "フォールド待機秒数", 1, 86_400);
      break;
    case "poker_base_multiplier":
      update.pokerBaseMultiplier = positiveMultiplier(raw, "ポーカー通常勝利倍率");
      break;
    case "bonus_enabled":
      update.pokerBonusEnabled = parseOnOff(raw, "役ボーナス");
      break;
    case "bonus_multipliers":
      update.pokerBonusMultipliers = parseBonusMultipliers(raw);
      break;
    case "dealer_qualification": {
      const [rawValue, threshold, ...rest] = raw.trim().toLowerCase().split(":");
      const value = rawValue?.replaceAll("_", "-");
      if (rest.length) throw new Error("成立条件は high-card:Q または pair などの形式で指定してください。");
      if (value === "off" || value === "なし") {
        update.pokerDealerQualificationEnabled = 0;
        update.pokerDealerQualificationRank = null;
        update.pokerDealerMinimumHighCard = null;
      } else if (value === "high-card") {
        if (!threshold) throw new Error("ハイカード成立条件には最低ランクを指定してください。例: high-card:Q");
        update.pokerDealerQualificationEnabled = 1;
        update.pokerDealerQualificationRank = value;
        update.pokerDealerMinimumHighCard = parseCardRankValue(threshold);
      } else if (["pair", "flush", "straight", "three-of-a-kind", "straight-flush"].includes(value ?? "")) {
        if (threshold) throw new Error("ハイカード以外の成立条件には数値しきい値を指定できません。");
        update.pokerDealerQualificationEnabled = 1;
        update.pokerDealerQualificationRank = value;
        update.pokerDealerMinimumHighCard = null;
      } else {
        throw new Error("ディーラー成立条件は off / high-card[:Q] / pair / flush / straight / three-of-a-kind / straight-flush のいずれかです。");
      }
      break;
    }
    case "enabled": {
      const enabled = parseOnOff(raw, "ゲーム稼働");
      update.chohanEnabled = enabled;
      update.pokerEnabled = enabled;
      // Normal poker wins pay 2.0 by explicit specification. This is not an
      // invented value; the remaining unspecified settings stay unconfigured.
      update.pokerBaseMultiplier = current?.pokerBaseMultiplier ?? 2;
      break;
    }
    case "activity_points":
      update.activityPointsPerGame = integerValue(raw, "活動pt換算値", 0);
      break;
    default:
      throw new Error("未対応の賭博場設定項目です。");
  }
  await setDealerCasinoSettings(guildId, update);
  return "賭博場設定を保存しました。";
}

async function createGame(interaction: ChatInputCommandInteraction, gameType: DealerCasinoType): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId || !interaction.guild) throw new Error("サーバー内でのみ開催できます。");
  const settings = await getDealerCasinoSettings(guildId);
  const dealer = await requireDealer(interaction, settings);
  if (!settings?.voiceChannelId) throw new Error("賭博場VCが未設定です。管理者に設定を依頼してください。");
  const gameVoiceId = dealer.voice.channelId;
  if (!gameVoiceId) throw new Error("設定された賭博場VCまたはその転送先VCに入室してください。");
  if (settings.maxPlayers === null) throw new Error("最大参加人数が未設定です。");
  if (gameType === "poker" && settings.maxPlayers > 16) throw new Error("スリーカードポーカーは52枚デッキの都合で最大16名です。");
  if (gameType === "poker" && settings.pokerAceLowEnabled === null) throw new Error("A-2-3の扱いが未設定です。管理者が `/casino setup dealer_rule` で設定してください。");
  const game = await createDealerCasinoGame({
    guildId,
    gameType,
    dealerId: interaction.user.id,
    channelId: interaction.channelId,
    voiceChannelId: gameVoiceId,
  });
  await postPanel(interaction, game);
}

async function requireOwnedActiveGame(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  settings: DealerCasinoSettings | null,
  allowAdminRecovery = false,
): Promise<DealerCasinoGame> {
  const guildId = interaction.guildId;
  if (!guildId) throw new Error("サーバー内でのみ利用できます。");
  const game = await getActiveDealerCasinoGame(guildId);
  if (!game) throw new Error("進行中の賭博場ゲームはありません。");
  const member = await requireDealer(interaction, settings);
  // Generated rooms may be deleted when empty. Only administrators can
  // cancel/refund from another configured room; play remains room-bound.
  const adminRecovery = allowAdminRecovery && isAdmin(member);
  if (member.voice.channelId !== game.voiceChannelId && !adminRecovery) {
    throw new Error("このゲームが進行しているVCに入室してください。");
  }
  if (member.id !== game.dealerId && !isAdmin(member) && !memberHasRole(member, settings?.directorRoleId) && !memberHasRole(member, settings?.adminRoleId)) {
    throw new Error("このゲームを開始したディーラーのみ操作できます。");
  }
  if (!adminRecovery && !await isConfiguredHubVoice(guildId, game.voiceChannelId, settings?.voiceChannelId ?? null)) {
    throw new Error("このゲームのVCは現在の設定と一致しません。管理者に確認してください。");
  }
  return game;
}

async function requireOwnedGameById(
  interaction: ButtonInteraction,
  gameId: number,
  settings: DealerCasinoSettings | null,
): Promise<DealerCasinoGame> {
  const guildId = interaction.guildId;
  if (!guildId) throw new Error("サーバー内でのみ利用できます。");
  const game = await getDealerCasinoGame(gameId);
  if (!game || game.guildId !== guildId) throw new Error("このゲームは見つからないか、別のサーバーのゲームです。");
  const member = await requireDealer(interaction, settings);
  if (member.voice.channelId !== game.voiceChannelId) {
    throw new Error("このゲームが進行しているVCに入室してください。");
  }
  if (member.id !== game.dealerId &&
      !isAdmin(member) &&
      !memberHasRole(member, settings?.directorRoleId) &&
      !memberHasRole(member, settings?.adminRoleId)) {
    throw new Error("このゲームを開始したディーラーのみ操作できます。");
  }
  if (!await isConfiguredHubVoice(guildId, game.voiceChannelId, settings?.voiceChannelId ?? null)) {
    throw new Error("このゲームのVCは現在の設定と一致しません。管理者に確認してください。");
  }
  return game;
}

async function settleStoredResult(
  game: DealerCasinoGame,
): Promise<{ game: DealerCasinoGame; alreadySettled: boolean }> {
  const result = resultFromGame(game);
  const settlement = await settleDealerCasinoGame(game.id, result.outcomes);
  const finished = settlement.game;
  if (game.gameType === "chohan") {
    for (const outcome of result.outcomes) {
      if (outcome.result === "LOST" || outcome.result === "FOLDED") {
        await applyDealerCasinoChohanStreakDecision(game.id, outcome.userId, "loss");
      }
    }
  }
  return { game: finished, alreadySettled: settlement.alreadySettled };
}

async function closeRecruitmentForDealer(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  gameId?: number,
): Promise<DealerCasinoGame> {
  const settings = await getDealerCasinoSettings(interaction.guildId ?? "");
  const game = gameId === undefined
    ? await requireOwnedActiveGame(interaction, settings)
    : interaction.isButton()
      ? await requireOwnedGameById(interaction, gameId, settings)
      : await requireOwnedActiveGame(interaction, settings);
  if (game.state !== "RECRUITING") throw new Error("参加受付中のゲームのみ締め切れます。");
  const closed = await transitionDealerCasinoGame(game.id, "RECRUITING", "CLOSED");
  await editPanel(interaction.client, closed);
  return closed;
}

async function rollAndSettleChohan(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  client: Client,
  gameId?: number,
): Promise<void> {
  const settings = await getDealerCasinoSettings(interaction.guildId!);
  let game = gameId !== undefined && interaction.isButton()
    ? await requireOwnedGameById(interaction, gameId, settings)
    : await requireOwnedActiveGame(interaction, settings);
  if (game.gameType !== "chohan") throw new Error("現在のゲームは丁半ではありません。");
  if (game.state !== "CLOSED") throw new Error("募集を締め切った丁半ゲームでのみサイコロを振れます。");
  const savedSettings = settings;
  if (!savedSettings?.chohanMultipliers || savedSettings.chohanMaxStreakMultiplier === null || savedSettings.streakRetentionSeconds === null) {
    throw new Error("丁半の連勝倍率と維持時間を先に設定してください。");
  }
  await transitionDealerCasinoGame(game.id, "CLOSED", "PLAYING");
  // As soon as the round enters PLAYING, persist its single random outcome
  // before any credits are issued. A retry reads that locked result.
  const roll = rollChohan();
  const bets = await listDealerCasinoBets(game.id);
  const outcomes: DealerCasinoOutcome[] = [];
  const players: DealerResult["players"] = [];
  const multipliers = readConfiguredChohanMultipliers(savedSettings);
  for (const bet of bets) {
    if (bet.state !== "ACTIVE" || !bet.choice) throw new Error("丁半の参加情報が不完全です。ゲームをキャンセルして返金してください。");
    const choice = bet.choice as "cho" | "han";
    const won = choice === roll.result;
    const streak = won ? await getDealerCasinoStreak(game.guildId, bet.userId) : null;
    const winStreak = streak?.winStreak ?? 0;
    const rawMultiplier = won ? getChohanStreakMultiplier(winStreak + 1, multipliers) : 0;
    const multiplier = won ? Math.min(rawMultiplier, savedSettings.chohanMaxStreakMultiplier!) : 0;
    const payout = won ? calculatePayout(bet.betAmount, multiplier) : 0;
    outcomes.push({
      userId: bet.userId,
      result: won ? "WON" : "LOST",
      payout,
      choice,
      winStreak: won ? winStreak + 1 : 0,
      multiplier: won ? multiplier : 0,
    });
    players.push({ userId: bet.userId, result: won ? "WON" : "LOST" });
  }
  const locked = await recordDealerCasinoResult(game.id, {
    kind: "chohan",
    dice: roll.dice,
    total: roll.total,
    result: roll.result,
    outcomes,
    players,
  });
  const settlement = await settleStoredResult(locked);
  game = settlement.game;
  const published = await publishSettledResultSafely(game, client, settlement.alreadySettled);
  await replyAfterSettlement(
    interaction,
    `丁半 Game #${game.id} の結果を保存し、${outcomes.length}名分の精算を完了しました。${published ? "" : " 精算は完了していますが、結果画面またはログの更新に失敗しました。再度精算する必要はありません。管理者に確認してください。"}`,
  );
}

async function dealPoker(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const settings = await getDealerCasinoSettings(interaction.guildId!);
  const game = await requireOwnedActiveGame(interaction, settings);
  if (game.gameType !== "poker" || game.state !== "CLOSED") throw new Error("受付終了後のポーカーゲームでのみカードを配れます。");
  if (!settings || settings.pokerAceLowEnabled === null) throw new Error("A-2-3の扱いが未設定です。");
  const bets = await listDealerCasinoBets(game.id);
  if (!bets.length) throw new Error("参加者がいないためカードを配れません。");
  if (bets.some((bet) => bet.state !== "ACTIVE")) throw new Error("参加者情報が不完全です。返金のためゲームをキャンセルしてください。");
  if (bets.length > 16) throw new Error("52枚デッキで配れる参加人数は最大16名です。");
  const deal = dealThreeCardPoker(bets.length);
  const dealerCards = deal.dealer.map(serializeCard);
  const playerHands: Array<{ userId: string; cards: string[]; handRank: PokerHandRank }> = [];
  for (let index = 0; index < bets.length; index += 1) {
    const bet = bets[index]!;
    const cards = deal.players[index]!;
    const hand = evaluatePokerHand(cards, settings.pokerAceLowEnabled === 1);
    playerHands.push({
      userId: bet.userId,
      cards: cards.map(serializeCard),
      handRank: hand.rank,
    });
  }
  const actionDeadline = new Date(Date.now() + settings.pokerTimeoutSeconds * 1000);
  await dealDealerCasinoPoker(game.id, dealerCards, playerHands, actionDeadline);
  await editPanel(client, await getDealerCasinoGame(game.id) ?? game);
  await replyDealerCommand(interaction, {
    content: `スリーカードポーカー Game #${game.id} のカードを配りました。参加者はパネルから本人用の手札を確認し、続行またはフォールドを選んでください。`,
  });
}

async function foldExpiredPlayers(game: DealerCasinoGame): Promise<void> {
  const bets = await listDealerCasinoBets(game.id);
  for (const bet of bets) {
    if (bet.state === "ACTIVE" && bet.playerAction !== "CONTINUE") {
      await updateDealerCasinoPlay(game.id, bet.userId, { playerAction: "FOLDED" });
    }
  }
}

async function revealPoker(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const settings = await getDealerCasinoSettings(interaction.guildId!);
  const game = await requireOwnedActiveGame(interaction, settings);
  if (game.gameType !== "poker" || game.state !== "PLAYING") throw new Error("配布後のポーカーゲームでのみカードを公開できます。");
  const bets = await listDealerCasinoBets(game.id);
  if (bets.some((bet) => bet.state === "ACTIVE" && bet.playerAction !== "CONTINUE")) {
    const deadline = actionDeadlineMs(game);
    if (!deadline || Date.now() < deadline) {
      throw new Error("参加者全員が続行またはフォールドを選ぶまで公開できません。操作がなければ設定時間後に自動フォールドされます。");
    }
    await foldExpiredPlayers(game);
  }
  const dealerCards = persistedDealerCards(game);
  if (!dealerCards) throw new Error("保存されたディーラーの手札を確認できません。安全のため精算を停止し、管理者に連絡してください。");
  if (!settings || settings.pokerAceLowEnabled === null || settings.pokerBaseMultiplier === null ||
      settings.pokerBonusEnabled === null || settings.pokerDealerQualificationEnabled === null) {
    throw new Error("ポーカーの払戻し・A-2-3・成立条件設定が未完了です。ゲームをキャンセルして返金してください。");
  }
  const dealerHand = evaluatePokerHand(dealerCards, settings.pokerAceLowEnabled === 1);
  const qualificationRank = settings.pokerDealerQualificationRank as PokerHandRank | null;
  const dealerQualified = isDealerQualified(dealerHand, {
    enabled: settings.pokerDealerQualificationEnabled === 1,
    ...(qualificationRank ? { minimumCategory: qualificationRank } : {}),
    ...(qualificationRank === "high-card" && settings.pokerDealerMinimumHighCard !== null
      ? { minimumHighCard: settings.pokerDealerMinimumHighCard as CardRank }
      : {}),
  });
  const currentBets = await listDealerCasinoBets(game.id);
  const outcomes: DealerCasinoOutcome[] = [];
  const players: DealerResult["players"] = [];
  const parsedBonus = settings.pokerBonusMultipliers ?? undefined;
  for (const bet of currentBets) {
    const cards = (bet.cards ?? []).map(parseCard);
    if (cards.length !== 3 || !bet.handRank) throw new Error("参加者のカード情報が不完全です。ゲームをキャンセルして返金してください。");
    const hand = evaluatePokerHand(cards, settings.pokerAceLowEnabled === 1);
    let result: DealerCasinoOutcome["result"];
    let payout: number;
    let multiplier: number | undefined;
    if (bet.state === "FOLDED" || bet.playerAction === "FOLDED") {
      result = "FOLDED";
      payout = 0;
    } else if (!dealerQualified) {
      result = "DRAW";
      payout = bet.betAmount;
    } else {
      const comparison = comparePokerHandValues(hand, dealerHand);
      if (comparison > 0) {
        result = "WON";
        multiplier = getPokerPayoutMultiplier(hand.rank, {
          baseWinMultiplier: settings.pokerBaseMultiplier,
          roleBonusEnabled: settings.pokerBonusEnabled === 1,
          roleBonusMultipliers: parsedBonus,
        });
        payout = calculatePayout(bet.betAmount, multiplier);
      } else if (comparison < 0) {
        result = "LOST";
        payout = 0;
      } else {
        result = "DRAW";
        payout = bet.betAmount;
      }
    }
    outcomes.push({
      userId: bet.userId,
      result,
      payout,
      cards: bet.cards ?? [],
      handRank: hand.rank,
      multiplier: multiplier ?? 0,
    });
    players.push({ userId: bet.userId, cards: bet.cards ?? [], hand, result });
  }
  const locked = await recordDealerCasinoResult(game.id, {
    kind: "poker",
    dealerCards: dealerCards.map(serializeCard),
    dealerHand,
    dealerQualified,
    outcomes,
    players,
  });
  await editPanel(client, locked);
  await replyDealerCommand(interaction, {
    content: `ディーラーの手札を公開し、Game #${game.id} の勝敗を保存しました。精算は /casino poker settle で行えます。`,
  });
}

async function settlePoker(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const settings = await getDealerCasinoSettings(interaction.guildId!);
  const game = await requireOwnedActiveGame(interaction, settings);
  if (game.gameType !== "poker" || (game.state !== "RESULT" && game.state !== "PAYOUT")) {
    throw new Error("結果公開後のポーカーゲームでのみ精算できます。");
  }
  const result = resultFromGame(game);
  const settlement = await settleStoredResult(game);
  const published = await publishSettledResultSafely(settlement.game, client, settlement.alreadySettled);
  await replyAfterSettlement(
    interaction,
    `Game #${game.id} の精算を完了しました (${result.outcomes.length}名)。${published ? "" : " 精算は完了していますが、結果画面またはログの更新に失敗しました。再度精算する必要はありません。管理者に確認してください。"}`,
  );
}

async function openBetModal(interaction: ButtonInteraction, gameId: number, choice: string | null, isChange: boolean): Promise<void> {
  const game = await getDealerCasinoGame(gameId);
  if (!game) throw new Error("ゲームが見つかりません。");
  if (game.state !== "RECRUITING") throw new Error("募集終了後は掛け金を変更できません。");
  await requireGameParticipant(interaction, game);
  const modal = new ModalBuilder()
    .setCustomId(`${DEALER_CASINO_PREFIX}bet-submit:${gameId}:${choice ?? "none"}:${isChange ? "change" : "new"}`)
    .setTitle(isChange ? "掛け金を変更" : "賭博場ゲームに参加");
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder()
      .setCustomId("amount")
      .setLabel("掛け金（整数）")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("1000")
      .setRequired(true)
      .setMaxLength(10),
  ));
  await interaction.showModal(modal);
}

async function submitBetModal(interaction: ModalSubmitInteraction, gameId: number, choice: string | null, isChange: boolean): Promise<void> {
  const game = await getDealerCasinoGame(gameId);
  if (!game) throw new Error("ゲームが見つかりません。");
  if (game.state !== "RECRUITING") throw new Error("募集終了後は参加・変更できません。");
  const member = await requireGameParticipant(interaction, game);
  const amount = integerValue(interaction.fields.getTextInputValue("amount"), "掛け金");
  if (game.gameType === "chohan" && choice !== "cho" && choice !== "han") throw new Error("丁または半を選択してください。");
  const existing = (await listDealerCasinoBets(gameId)).find((entry) => entry.userId === member.id);
  if (existing) {
    await updateDealerCasinoBet({
      gameId,
      userId: member.id,
      amount,
      ...(choice ? { choice } : {}),
    });
  } else if (isChange && game.gameType === "chohan") {
    throw new Error("丁半に新規参加する場合は「丁」または「半」を選んでください。");
  } else {
    await placeDealerCasinoBet({
      gameId,
      userId: member.id,
      amount,
      choice,
    });
  }
  await interaction.reply({ content: `Game #${gameId} に **${amount.toLocaleString()}** の掛け金を確保しました。`, flags: MessageFlags.Ephemeral });
  await editPanel(interaction.client, await getDealerCasinoGame(gameId) ?? game).catch((error) => {
    logger.error(`[dealer-casino] bet saved, but panel update failed for game ${gameId}`, error);
  });
}

async function handlePlayerAction(interaction: ButtonInteraction, gameId: number, action: "hand" | "continue" | "fold"): Promise<void> {
  const game = await getDealerCasinoGame(gameId);
  if (!game || game.gameType !== "poker" || game.state !== "PLAYING") throw new Error("ポーカーはカード選択を受け付けていません。");
  const member = await requireGameParticipant(interaction, game);
  const [bet] = (await listDealerCasinoBets(gameId)).filter((entry) => entry.userId === member.id);
  if (!bet || !bet.cards?.length || bet.state !== "ACTIVE") throw new Error("有効な参加カードがありません。");
  if (bet.playerAction && action !== "hand") throw new Error("すでに続行またはフォールドを選択しています。");
  const deadline = actionDeadlineMs(game);
  if (deadline !== null && Date.now() >= deadline) {
    await updateDealerCasinoPlay(gameId, member.id, { playerAction: "FOLDED" });
    await interaction.reply({ content: "操作時間を過ぎたため、自動フォールドになりました。", flags: MessageFlags.Ephemeral });
    await editPanel(interaction.client, await getDealerCasinoGame(gameId) ?? game);
    return;
  }
  if (action === "hand") {
    const cards = bet.cards.map(parseCard);
    const hand = evaluatePokerHand(cards, (await getDealerCasinoSettings(game.guildId))?.pokerAceLowEnabled === 1);
    const cardStrip = await buildBlackjackCardStrip(game.guildId, cards, `poker-hand-${gameId}-${bet.id}.png`);
    const rows = [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${DEALER_CASINO_PREFIX}continue:${gameId}`).setLabel("▶️ 続行").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${DEALER_CASINO_PREFIX}fold:${gameId}`).setLabel("🏳️ フォールド").setStyle(ButtonStyle.Danger),
    )];
    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle("🎴 あなたの手札").setColor(COLOR)
        .setDescription(`${formatCards(cards)}\n役: **${handLabel(hand)}**\n\n他の参加者には表示されません。`)
        .setImage(cardStrip ? `attachment://${cardStrip.filename}` : null)],
      files: cardStrip ? [cardStrip.attachment] : [],
      components: rows,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (action === "continue") {
    await updateDealerCasinoPlay(gameId, member.id, { playerAction: "CONTINUE" });
    await interaction.reply({ content: "続行を記録しました。", flags: MessageFlags.Ephemeral });
  } else {
    await updateDealerCasinoPlay(gameId, member.id, { playerAction: "FOLDED" });
    await interaction.reply({ content: "フォールドを記録しました。掛け金は没収されます。", flags: MessageFlags.Ephemeral });
  }
  await editPanel(interaction.client, await getDealerCasinoGame(gameId) ?? game);
}

async function handleStreakDecision(interaction: ButtonInteraction, gameId: number, decision: ChohanStreakDecision): Promise<void> {
  const game = await getDealerCasinoGame(gameId);
  if (!game || game.gameType !== "chohan" || game.state !== "FINISHED") throw new Error("連勝選択を受け付ける丁半の結果がありません。");
  const member = await memberFor(interaction);
  if (!member) throw new Error("サーバーメンバーを確認できません。");
  if (member.voice.channelId !== game.voiceChannelId) throw new Error("連勝の選択は賭博場VCに参加している間のみ行えます。");
  const result = resultFromGame(game);
  const outcome = result.outcomes.find((entry) => entry.userId === member.id);
  if (outcome?.result !== "WON") throw new Error("勝利した参加者だけが連勝または勝ち逃げを選べます。");
  const applied = await applyDealerCasinoChohanStreakDecision(gameId, member.id, decision);
  await interaction.reply({
    content: decision === "continue"
      ? `連勝に挑戦します。現在の連勝数: **${applied.winStreak}**`
      : "勝ち逃げを選び、連勝数をリセットしました。",
    flags: MessageFlags.Ephemeral,
  });
}

async function handleButton(interaction: ButtonInteraction): Promise<void> {
  const [, action, gameIdText, detail] = interaction.customId.split(":");
  const gameId = integerValue(gameIdText ?? "", "ゲームID");
  if (action === "dealer-close") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const closed = await closeRecruitmentForDealer(interaction, gameId);
    await interaction.editReply({ content: `Game #${closed.id} の受付を締め切りました。下の「抽選して精算」ボタンから結果を確定できます。` });
    return;
  }
  if (action === "dealer-roll") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await rollAndSettleChohan(interaction, interaction.client, gameId);
    return;
  }
  if (action === "bet" || action === "join" || action === "change") {
    const choice = action === "bet" ? detail ?? null : null;
    await openBetModal(interaction, gameId, choice, action === "change");
    return;
  }
  if (action === "withdraw") {
    const game = await getDealerCasinoGame(gameId);
    if (!game || game.state !== "RECRUITING") throw new Error("参加取消は募集期間中のみ可能です。");
    const member = await requireGameParticipant(interaction, game);
    await withdrawDealerCasinoBet(gameId, member.id);
    await interaction.reply({ content: "参加を取り消し、掛け金を返金しました。", flags: MessageFlags.Ephemeral });
    await editPanel(interaction.client, await getDealerCasinoGame(gameId) ?? game).catch((error) => {
      logger.error(`[dealer-casino] withdrawal refunded, but panel update failed for game ${gameId}`, error);
    });
    return;
  }
  if (action === "hand" || action === "continue" || action === "fold") {
    await handlePlayerAction(interaction, gameId, action);
    return;
  }
  if (action === "streak") {
    if (detail !== "continue" && detail !== "cashout") throw new Error("連勝選択が不正です。");
    await handleStreakDecision(interaction, gameId, detail === "continue" ? "continue" : "cashout");
    return;
  }
  throw new Error("このボタン操作は利用できません。");
}

export async function handleDealerCasinoInteraction(
  interaction: ButtonInteraction | ModalSubmitInteraction,
): Promise<void> {
  try {
    const [, action, gameIdText, choiceText, mode] = interaction.customId.split(":");
    const gameId = integerValue(gameIdText ?? "", "ゲームID");
    if (interaction.isButton()) {
      await handleButton(interaction);
      return;
    }
    if (action !== "bet-submit") throw new Error("このフォームは利用できません。");
    await submitBetModal(
      interaction,
      gameId,
      choiceText === "none" ? null : choiceText ?? null,
      mode === "change",
    );
  } catch (error) {
    if (interaction.deferred) {
      await interaction.editReply({ content: `❌ ${errorMessage(error)}`, embeds: [], components: [] }).catch(() => undefined);
    } else if (interaction.replied) {
      await interaction.followUp({ content: `❌ ${errorMessage(error)}`, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    } else {
      await interaction.reply({ content: `❌ ${errorMessage(error)}`, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    }
  }
}

async function cancelGameForDealer(interaction: ChatInputCommandInteraction, settings: DealerCasinoSettings | null): Promise<DealerCasinoGame> {
  const game = await requireOwnedActiveGame(interaction, settings, true);
  await cancelDealerCasinoGame(game.id);
  const cancelled = await getDealerCasinoGame(game.id);
  if (!cancelled) throw new Error("キャンセル済みゲームを取得できません。");
  await editPanel(interaction.client, cancelled);
  return cancelled;
}

async function endDealerSession(
  interaction: ChatInputCommandInteraction,
  settings: DealerCasinoSettings | null,
): Promise<{ game: DealerCasinoGame; refundedActiveGame: boolean }> {
  const guildId = interaction.guildId;
  if (!guildId) throw new Error("サーバー内でのみ利用できます。");
  const member = await requireDealer(interaction, settings);
  let latest = await getLatestDealerCasinoGame(guildId);
  if (!latest) throw new Error("終了する賭博師セッションがありません。");
  if (latest.dealerId !== member.id &&
      !isAdmin(member) &&
      !memberHasRole(member, settings?.directorRoleId) &&
      !memberHasRole(member, settings?.adminRoleId)) {
    throw new Error("この賭博師セッションを終了する権限がありません。");
  }

  let refundedActiveGame = false;
  const active = await getActiveDealerCasinoGame(guildId);
  if (active) {
    const owned = await requireOwnedActiveGame(interaction, settings, true);
    const cancelled = await cancelDealerCasinoGame(owned.id);
    latest = cancelled.game;
    refundedActiveGame = true;
    await editPanel(interaction.client, cancelled.game).catch((error) => {
      logger.error(`[dealer-casino] session ended, but panel update failed for game ${cancelled.game.id}`, error);
    });
  }
  await endDealerCasinoSession(guildId, latest.dealerId);
  return { game: latest, refundedActiveGame };
}

async function startNextGame(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) throw new Error("サーバー内でのみ利用できます。");
  const settings = await getDealerCasinoSettings(guildId);
  const member = await requireDealer(interaction, settings);
  const prior = await getActiveDealerCasinoGame(guildId);
  if (prior) throw new Error("現在のゲームがまだ終了していません。先に結果確定と精算を完了してください。");
  const finished = await getLatestDealerCasinoGame(guildId);
  if (!finished || (finished.state !== "FINISHED" && finished.state !== "CANCELLED")) {
    throw new Error("次ゲームの種類を特定できる終了済みゲームがありません。");
  }
  if (finished.sessionEnded) throw new Error("この賭博師セッションは /casino end で終了済みです。新しい募集を開始するには、管理者に新しいセッションの開始を依頼してください。");
  if (finished.dealerId !== interaction.user.id && !isCasinoManager(member, settings)) throw new Error("前回のディーラーのみ次ゲームを開始できます。");
  await createGame(interaction, finished.gameType as DealerCasinoType);
  await replyDealerCommand(interaction, { content: "次の募集パネルを投稿しました。" });
}

export async function handleDealerCasinoSlash(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();
  try {
    if (!interaction.guildId) throw new Error("このコマンドはサーバー内でのみ利用できます。");
    const settings = await getDealerCasinoSettings(interaction.guildId);
    if (group === "setup") {
      const member = await memberFor(interaction);
      if (!member || !isAdmin(member)) throw new Error("賭博場の設定はサーバー管理者のみ変更できます。");
      if (sub === "dealer_room" || sub === "game_vc") {
        const voice = interaction.options.getChannel("vc", true);
        if (voice.type !== ChannelType.GuildVoice && voice.type !== ChannelType.GuildStageVoice) {
          throw new Error("賭博場VCに指定できるのは音声チャンネルのみです。");
        }
        const active = await getActiveDealerCasinoGame(interaction.guildId);
        if (active && settings?.voiceChannelId !== voice.id) {
          throw new Error("進行中の丁半またはポーカーがあります。精算またはキャンセル後にVCを変更してください。");
        }
        if (sub === "game_vc") {
          await setDealerCasinoSettings(interaction.guildId, { voiceChannelId: voice.id });
          await replyDealerCommand(interaction, { content: `丁半・スリーカードポーカー共通の開催VCを <#${voice.id}> に設定しました。` });
          return;
        }
        const log = interaction.options.getChannel("log", false);
        if (log && log.type !== ChannelType.GuildText &&
            log.type !== ChannelType.GuildAnnouncement &&
            log.type !== ChannelType.PublicThread &&
            log.type !== ChannelType.AnnouncementThread) {
          throw new Error("ログ先にはテキストチャンネルを指定してください。");
        }
        await setDealerCasinoSettings(interaction.guildId, {
          voiceChannelId: voice.id,
          logChannelId: log?.id ?? settings?.logChannelId ?? null,
        });
        await replyDealerCommand(interaction, { content: `賭博場VCを <#${voice.id}>${log ? `、ログ先を <#${log.id}>` : ""} に設定しました。` });
        return;
      }
      if (sub === "dealer_roles") {
        const dealer = interaction.options.getRole("dealer", true);
        const director = interaction.options.getRole("leader", true);
        const manager = interaction.options.getRole("manager", false);
        await setDealerCasinoSettings(interaction.guildId, {
          dealerRoleId: dealer.id,
          directorRoleId: director.id,
          adminRoleId: manager?.id ?? null,
        });
        await replyDealerCommand(interaction, { content: `賭博師ロール <@&${dealer.id}> と賭博統領ロール <@&${director.id}> を設定しました。` });
        return;
      }
      if (sub === "dealer_rule") {
        const message = await configureRule(interaction);
        await replyDealerCommand(interaction, { content: message });
        return;
      }
      if (sub === "dealer_status") {
        const stats = await getDealerCasinoStats(interaction.guildId, interaction.user.id);
        await replyDealerCommand(interaction, { embeds: [settingsStatus(settings, stats)] });
        return;
      }
    }
    if (group === "chohan" && sub === "start") {
      await requireDealer(interaction, settings);
      await createGame(interaction, "chohan");
      await replyDealerCommand(interaction, { content: "丁半の募集パネルを投稿しました。" });
      return;
    }
    if (group === "chohan" && sub === "roll") {
      await rollAndSettleChohan(interaction, interaction.client);
      return;
    }
    if (group === "poker" && sub === "start") {
      await requireDealer(interaction, settings);
      await createGame(interaction, "poker");
      await replyDealerCommand(interaction, { content: "スリーカードポーカーの募集パネルを投稿しました。" });
      return;
    }
    if (group === "poker" && sub === "deal") {
      await dealPoker(interaction, interaction.client);
      return;
    }
    if (group === "poker" && sub === "reveal") {
      await revealPoker(interaction, interaction.client);
      return;
    }
    if (group === "poker" && sub === "settle") {
      await settlePoker(interaction, interaction.client);
      return;
    }
    if (sub === "status") {
      const game = await getActiveDealerCasinoGame(interaction.guildId);
      if (!game) {
        await replyDealerCommand(interaction, { content: "現在進行中の賭博場ゲームはありません。" });
        return;
      }
      const bets = await listDealerCasinoBets(game.id);
      await replyDealerCommand(interaction, { embeds: [gameEmbed(game, settings, bets)] });
      return;
    }
    if (sub === "close") {
      const closed = await closeRecruitmentForDealer(interaction);
      await replyDealerCommand(interaction, { content: `Game #${closed.id} の参加を締め切りました。` });
      return;
    }
    if (sub === "cancel") {
      const cancelled = await cancelGameForDealer(interaction, settings);
      await replyDealerCommand(interaction, {
        content: `Game #${cancelled.id} をキャンセルし、参加者に掛け金を返金しました。`,
      });
      return;
    }
    if (sub === "end") {
      const ended = await endDealerSession(interaction, settings);
      await replyDealerCommand(interaction, {
        content: ended.refundedActiveGame
          ? `賭博師セッションを終了し、Game #${ended.game.id} の参加者へ掛け金を返金しました。`
          : `賭博師セッションを終了しました (最新ゲーム #${ended.game.id})。`,
      });
      return;
    }
    if (sub === "next") {
      await startNextGame(interaction);
      return;
    }
    await replyDealerCommand(interaction, { content: "未対応の賭博場コマンドです。" });
  } catch (error) {
    await interaction.editReply({ content: `❌ ${errorMessage(error)}`, embeds: [], components: [] }).catch(() => undefined);
  }
}

export async function handleDealerCasinoVoiceDeparture(oldState: VoiceState, newState: VoiceState): Promise<void> {
  const userId = oldState.member?.id ?? newState.member?.id;
  const leftGameVoiceChannel = Boolean(oldState.channelId && oldState.channelId !== newState.channelId);
  if (!userId || !leftGameVoiceChannel || !oldState.guild) return;
  const settings = await getDealerCasinoSettings(oldState.guild.id).catch((error) => {
    logger.error(`[dealer-casino] failed to load settings for voice departure ${userId}`, error);
    return null;
  });
  if (!await isConfiguredHubVoice(oldState.guild.id, oldState.channelId, settings?.voiceChannelId ?? null)) return;
  if (!await isConfiguredHubVoice(oldState.guild.id, newState.channelId, settings?.voiceChannelId ?? null)) {
    await resetDealerCasinoChohanStreak(oldState.guild.id, userId).catch((error) => {
      logger.error(`[dealer-casino] failed to reset streak for user ${userId}`, error);
    });
  }
  const active = await getActiveDealerCasinoGame(oldState.guild.id).catch((error) => {
    logger.error(`[dealer-casino] failed to check voice departure for user ${userId}`, error);
    return null;
  });
  if (active?.voiceChannelId !== oldState.channelId) return;
  if (active.gameType === "poker" && active.state === "PLAYING") {
    const bets = await listDealerCasinoBets(active.id).catch(() => []);
    const bet = bets.find((entry) => entry.userId === userId && entry.state === "ACTIVE" && !entry.playerAction);
    if (bet) await updateDealerCasinoPlay(active.id, userId, { playerAction: "FOLDED" }).catch((error) => {
      logger.error(`[dealer-casino] failed to fold departed poker player ${userId}`, error);
    });
  }
}

async function recoverGuild(client: Client, guildId: string, startup: boolean): Promise<void> {
  const game = await getActiveDealerCasinoGame(guildId);
  if (!game) return;
  if (game.state === "RESULT" || game.state === "PAYOUT") {
    // The immutable outcome has been recorded, so it is safe to finish a
    // payout after a process restart.
    const settlement = await settleStoredResult(game);
    await publishSettledResultSafely(settlement.game, client, settlement.alreadySettled);
    return;
  }
  if (game.gameType === "poker" && game.state === "PLAYING") {
    // The private dealer hand and action deadline are persisted atomically at
    // deal time, so a restart resumes this exact round rather than redrawing.
    if (!persistedDealerCards(game)) {
      logger.error(`[dealer-casino] poker game ${game.id} is missing persisted dealer cards; cancelling unrecoverable round`);
      const cancelled = await cancelDealerCasinoGame(game.id);
      const [settings, bets] = await Promise.all([
        getDealerCasinoSettings(guildId),
        listDealerCasinoBets(game.id),
      ]);
      const channel = await client.channels.fetch(game.channelId).catch(() => null);
      if (channel?.isTextBased() && "send" in channel) {
        await channel.send({
          embeds: [gameEmbed(cancelled.game, settings, bets).setDescription(
            "BOT再起動により非公開カードを復旧できなかったため、ゲームをキャンセルして全参加者へ返金しました。",
          )],
          allowedMentions: { parse: [] },
        }).catch(() => undefined);
      }
    } else {
      const deadline = actionDeadlineMs(game);
      if (deadline === null || Date.now() >= deadline) {
        await foldExpiredPlayers(game);
        const current = await getDealerCasinoGame(game.id);
        if (current) await editPanel(client, current);
      }
    }
    return;
  }
  if (game.gameType === "chohan" && game.state === "PLAYING") {
    if (startup) {
      const cancelled = await cancelDealerCasinoGame(game.id);
      await editPanel(client, cancelled.game);
    }
    return;
  }
  if (game.state === "CLOSED" && startup) {
    // A close/deal/roll interrupted by a restart has no locked result. Refund
    // all stakes; never rerun random operations for an incomplete round.
    const cancelled = await cancelDealerCasinoGame(game.id);
    await editPanel(client, cancelled.game);
  }
}

export function startDealerCasinoRecovery(client: Client): void {
  if (recoveryStarted) return;
  recoveryStarted = true;
  const runRecovery = (startup = false) => {
    for (const guild of client.guilds.cache.values()) {
      void recoverGuild(client, guild.id, startup).catch((error) => {
        // A recovery failure is intentionally surfaced to the bot's main
        // command/event error path through stderr rather than silently paying.
        console.error(`[dealer-casino] recovery failed for guild ${guild.id}`, error);
      });
    }
  };
  runRecovery(true);
  setInterval(() => runRecovery(false), 30_000).unref();
}