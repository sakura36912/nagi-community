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
import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  chinchiroGamesTable,
  db,
  transactionsTable,
  walletsTable,
  type ChinchiroGame,
} from "@workspace/db";
import { getGuildSettings, getOrCreateWallet } from "../lib/economy";
import { CASINO_DEFAULT_MAX_BET } from "./casino";
import { logger } from "../lib/logger";

export const CHINCHIRO_PREFIX = "chinchiro:";

const MIN_BET = 1_000;
const CHALLENGE_TTL_MS = 60_000;
const ROLL_TTL_MS = 2 * 60_000;
const COLOR_NEUTRAL = 0x5865f2;
const COLOR_WIN = 0x57f287;
const COLOR_DRAW = 0xfee75c;
const COLOR_CANCEL = 0x747f8d;
const OPEN_STATUSES = ["pending", "active"];
const DICE = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"] as const;

export type ChinchiroOutcomeKind =
  | "pinzoro"
  | "arashi"
  | "shigoro"
  | "point"
  | "menashi"
  | "hifumi";

export interface ChinchiroOutcome {
  kind: ChinchiroOutcomeKind;
  label: string;
  rank: number;
  dice: number[];
  attempts: number[][];
}

function evaluateThrow(dice: number[]): Omit<ChinchiroOutcome, "attempts"> | null {
  const sorted = [...dice].sort((a, b) => a - b);
  const key = sorted.join("");

  if (key === "111") {
    return { kind: "pinzoro", label: "ピンゾロ", rank: 9, dice };
  }
  if (sorted[0] === sorted[2]) {
    return {
      kind: "arashi",
      label: `アラシ（${sorted[0]}ゾロ）`,
      rank: 8,
      dice,
    };
  }
  if (key === "456") {
    return { kind: "shigoro", label: "シゴロ", rank: 7, dice };
  }
  if (key === "123") {
    return { kind: "hifumi", label: "ヒフミ", rank: -1, dice };
  }

  const counts = new Map<number, number>();
  for (const die of sorted) counts.set(die, (counts.get(die) ?? 0) + 1);
  const pair = [...counts.entries()].find(([, count]) => count === 2);
  if (!pair) return null;

  const point = sorted.find((die) => die !== pair[0])!;
  return { kind: "point", label: `${point}の目`, rank: point, dice };
}

export function evaluateChinchiroRoll(
  attempts: number[][],
): ChinchiroOutcome {
  for (const dice of attempts.slice(0, 3)) {
    const evaluated = evaluateThrow(dice);
    if (evaluated) return { ...evaluated, attempts };
  }
  const dice = attempts.at(-1) ?? [1, 2, 4];
  return { kind: "menashi", label: "目なし", rank: 0, dice, attempts };
}

export function rollChinchiroHand(random: () => number = Math.random): ChinchiroOutcome {
  const attempts: number[][] = [];
  for (let i = 0; i < 3; i++) {
    const dice = Array.from({ length: 3 }, () => Math.floor(random() * 6) + 1);
    attempts.push(dice);
    if (evaluateThrow(dice)) break;
  }
  return evaluateChinchiroRoll(attempts);
}

export function compareChinchiroOutcomes(
  challenger: ChinchiroOutcome,
  opponent: ChinchiroOutcome,
): -1 | 0 | 1 {
  if (challenger.rank === opponent.rank) return 0;
  return challenger.rank > opponent.rank ? 1 : -1;
}

function parseOutcome(raw: string | null): ChinchiroOutcome | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ChinchiroOutcome;
  } catch {
    return null;
  }
}

function formatDice(dice: number[]): string {
  return dice.map((die) => DICE[die - 1] ?? String(die)).join(" ");
}

function formatOutcome(outcome: ChinchiroOutcome | null): string {
  if (!outcome) return "🎲 まだ振っていません";
  const attempts = outcome.attempts
    .map((dice, index) => `${index + 1}投目: ${formatDice(dice)}`)
    .join("\n");
  return `${attempts}\n**${outcome.label}**`;
}

function challengeComponents(id: number): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${CHINCHIRO_PREFIX}accept:${id}`)
        .setLabel("勝負を受ける")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${CHINCHIRO_PREFIX}decline:${id}`)
        .setLabel("辞退する")
        .setEmoji("✖️")
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

function rollComponents(id: number): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${CHINCHIRO_PREFIX}roll:${id}`)
        .setLabel("サイコロを振る")
        .setEmoji("🎲")
        .setStyle(ButtonStyle.Primary),
    ),
  ];
}

function buildChallengeEmbed(game: ChinchiroGame): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("🎲 対人チンチロ — 挑戦状")
    .setColor(COLOR_NEUTRAL)
    .setDescription(
      `<@${game.challengerId}> が <@${game.opponentId}> に勝負を挑みました！`,
    )
    .addFields(
      {
        name: "賭け金",
        value: `1人 **${game.bet.toLocaleString()}** ${game.currencyName}`,
        inline: true,
      },
      {
        name: "勝者の受取",
        value: `**${(game.bet * 2).toLocaleString()}** ${game.currencyName}`,
        inline: true,
      },
    )
    .setFooter({ text: "相手は60秒以内に承認してください。引き分け・期限切れは返金されます。" })
    .setTimestamp();
}

function buildActiveEmbed(game: ChinchiroGame): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("🎲 対人チンチロ — 勝負開始")
    .setColor(COLOR_NEUTRAL)
    .setDescription("両者とも「サイコロを振る」を押してください。役が出なければ最大3回まで自動で振ります。")
    .addFields(
      {
        name: `挑戦者 <@${game.challengerId}>`,
        value: formatOutcome(parseOutcome(game.challengerRoll)),
        inline: true,
      },
      {
        name: `対戦相手 <@${game.opponentId}>`,
        value: formatOutcome(parseOutcome(game.opponentRoll)),
        inline: true,
      },
      {
        name: "賭け金",
        value: `1人 **${game.bet.toLocaleString()}** ${game.currencyName}`,
      },
    )
    .setFooter({ text: "強さ: ピンゾロ > アラシ > シゴロ > 6〜1の目 > 目なし > ヒフミ" });
}

interface Settlement {
  game: ChinchiroGame;
  challengerOutcome: ChinchiroOutcome;
  opponentOutcome: ChinchiroOutcome;
  winnerId: string | null;
}

function buildResultEmbed(result: Settlement): EmbedBuilder {
  const { game, challengerOutcome, opponentOutcome, winnerId } = result;
  const isDraw = winnerId === null;
  return new EmbedBuilder()
    .setTitle(isDraw ? "🎲 対人チンチロ — 引き分け" : "🎲 対人チンチロ — 決着")
    .setColor(isDraw ? COLOR_DRAW : COLOR_WIN)
    .setDescription(
      isDraw
        ? `同じ強さのため、両者に **${game.bet.toLocaleString()}** ${game.currencyName} を返金しました。`
        : `🏆 <@${winnerId}> の勝利！\n**${(game.bet * 2).toLocaleString()}** ${game.currencyName} を獲得しました。`,
    )
    .addFields(
      {
        name: `挑戦者 <@${game.challengerId}>`,
        value: formatOutcome(challengerOutcome),
        inline: true,
      },
      {
        name: `対戦相手 <@${game.opponentId}>`,
        value: formatOutcome(opponentOutcome),
        inline: true,
      },
    )
    .setTimestamp();
}

async function lockPlayers(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  guildId: string,
  userIds: string[],
): Promise<void> {
  for (const userId of [...userIds].sort()) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${guildId}:${userId}`}, 0))`,
    );
  }
}

type CreateChallengeResult =
  | { ok: true; game: ChinchiroGame }
  | { ok: false; reason: "busy" | "insufficient_funds" };

async function createChallenge(
  guildId: string,
  channelId: string,
  challengerId: string,
  opponentId: string,
  bet: number,
  currencyName: string,
): Promise<CreateChallengeResult> {
  await Promise.all([
    getOrCreateWallet(guildId, challengerId),
    getOrCreateWallet(guildId, opponentId),
  ]);

  return db.transaction(async (tx) => {
    await lockPlayers(tx, guildId, [challengerId, opponentId]);
    const now = new Date();
    const [existing] = await tx
      .select({ id: chinchiroGamesTable.id })
      .from(chinchiroGamesTable)
      .where(and(
        eq(chinchiroGamesTable.guildId, guildId),
        inArray(chinchiroGamesTable.status, OPEN_STATUSES),
        gt(chinchiroGamesTable.expiresAt, now),
        or(
          inArray(chinchiroGamesTable.challengerId, [challengerId, opponentId]),
          inArray(chinchiroGamesTable.opponentId, [challengerId, opponentId]),
        ),
      ))
      .limit(1);
    if (existing) return { ok: false, reason: "busy" };

    const [debited] = await tx
      .update(walletsTable)
      .set({ balance: sql`${walletsTable.balance} - ${bet}` })
      .where(and(
        eq(walletsTable.guildId, guildId),
        eq(walletsTable.userId, challengerId),
        sql`${walletsTable.balance} >= ${bet}`,
      ))
      .returning({ balance: walletsTable.balance });
    if (!debited) return { ok: false, reason: "insufficient_funds" };

    const [game] = await tx
      .insert(chinchiroGamesTable)
      .values({
        guildId,
        channelId,
        challengerId,
        opponentId,
        bet,
        currencyName,
        status: "pending",
        expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
      })
      .returning();
    if (!game) throw new Error("Failed to create Chinchiro challenge");
    return { ok: true, game };
  });
}

class OpponentFundsError extends Error {}

async function acceptChallenge(id: number): Promise<
  { ok: true; game: ChinchiroGame }
  | { ok: false; reason: "unavailable" | "insufficient_funds" }
> {
  try {
    return await db.transaction(async (tx) => {
      const [activated] = await tx
        .update(chinchiroGamesTable)
        .set({
          status: "active",
          expiresAt: new Date(Date.now() + ROLL_TTL_MS),
        })
        .where(and(
          eq(chinchiroGamesTable.id, id),
          eq(chinchiroGamesTable.status, "pending"),
          gt(chinchiroGamesTable.expiresAt, new Date()),
        ))
        .returning();
      if (!activated) return { ok: false, reason: "unavailable" };

      const [debited] = await tx
        .update(walletsTable)
        .set({ balance: sql`${walletsTable.balance} - ${activated.bet}` })
        .where(and(
          eq(walletsTable.guildId, activated.guildId),
          eq(walletsTable.userId, activated.opponentId),
          sql`${walletsTable.balance} >= ${activated.bet}`,
        ))
        .returning({ balance: walletsTable.balance });
      if (!debited) throw new OpponentFundsError();
      return { ok: true, game: activated };
    });
  } catch (error) {
    if (error instanceof OpponentFundsError) {
      return { ok: false, reason: "insufficient_funds" };
    }
    throw error;
  }
}

async function closeAndRefund(
  id: number,
  statuses: string[],
  nextStatus: "declined" | "expired",
): Promise<ChinchiroGame | null> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(chinchiroGamesTable)
      .where(eq(chinchiroGamesTable.id, id))
      .for("update");
    if (!current || !statuses.includes(current.status)) return null;

    const [closed] = await tx
      .update(chinchiroGamesTable)
      .set({ status: nextStatus })
      .where(and(
        eq(chinchiroGamesTable.id, id),
        eq(chinchiroGamesTable.status, current.status),
      ))
      .returning();
    if (!closed) return null;

    await tx
      .update(walletsTable)
      .set({ balance: sql`${walletsTable.balance} + ${closed.bet}` })
      .where(and(
        eq(walletsTable.guildId, closed.guildId),
        eq(walletsTable.userId, closed.challengerId),
      ));
    if (current.status === "active") {
      await tx
        .update(walletsTable)
        .set({ balance: sql`${walletsTable.balance} + ${closed.bet}` })
        .where(and(
          eq(walletsTable.guildId, closed.guildId),
          eq(walletsTable.userId, closed.opponentId),
        ));
    }
    return closed;
  });
}

async function recordRoll(
  game: ChinchiroGame,
  userId: string,
  outcome: ChinchiroOutcome,
): Promise<ChinchiroGame | null> {
  const isChallenger = userId === game.challengerId;
  const rollColumn = isChallenger
    ? chinchiroGamesTable.challengerRoll
    : chinchiroGamesTable.opponentRoll;
  const set = isChallenger
    ? { challengerRoll: JSON.stringify(outcome) }
    : { opponentRoll: JSON.stringify(outcome) };

  const [updated] = await db
    .update(chinchiroGamesTable)
    .set(set)
    .where(and(
      eq(chinchiroGamesTable.id, game.id),
      eq(chinchiroGamesTable.status, "active"),
      gt(chinchiroGamesTable.expiresAt, new Date()),
      isNull(rollColumn),
    ))
    .returning();
  return updated ?? null;
}

async function settleGame(id: number): Promise<Settlement | null> {
  return db.transaction(async (tx) => {
    const [game] = await tx
      .update(chinchiroGamesTable)
      .set({ status: "settled" })
      .where(and(
        eq(chinchiroGamesTable.id, id),
        eq(chinchiroGamesTable.status, "active"),
        sql`${chinchiroGamesTable.challengerRoll} IS NOT NULL`,
        sql`${chinchiroGamesTable.opponentRoll} IS NOT NULL`,
      ))
      .returning();
    if (!game) return null;

    const challengerOutcome = parseOutcome(game.challengerRoll);
    const opponentOutcome = parseOutcome(game.opponentRoll);
    if (!challengerOutcome || !opponentOutcome) {
      throw new Error(`Invalid Chinchiro roll data for game ${id}`);
    }

    const comparison = compareChinchiroOutcomes(challengerOutcome, opponentOutcome);
    const winnerId = comparison === 0
      ? null
      : comparison > 0 ? game.challengerId : game.opponentId;

    if (winnerId) {
      await tx
        .update(walletsTable)
        .set({ balance: sql`${walletsTable.balance} + ${game.bet * 2}` })
        .where(and(
          eq(walletsTable.guildId, game.guildId),
          eq(walletsTable.userId, winnerId),
        ));
    } else {
      for (const userId of [game.challengerId, game.opponentId]) {
        await tx
          .update(walletsTable)
          .set({ balance: sql`${walletsTable.balance} + ${game.bet}` })
          .where(and(
            eq(walletsTable.guildId, game.guildId),
            eq(walletsTable.userId, userId),
          ));
      }
    }

    const reasonFor = (userId: string) => {
      if (!winnerId) return `チンチロ 引き分け（賭け: ${game.bet}）`;
      return winnerId === userId
        ? `チンチロ 対人勝利（賭け: ${game.bet}）`
        : `チンチロ 対人敗北（賭け: ${game.bet}）`;
    };
    await tx.insert(transactionsTable).values([
      {
        guildId: game.guildId,
        userId: game.challengerId,
        amount: winnerId === null ? 0 : winnerId === game.challengerId ? game.bet : -game.bet,
        reason: reasonFor(game.challengerId),
        relatedUserId: game.opponentId,
        sessionKey: `chinchiro:${game.id}:${game.challengerId}`,
      },
      {
        guildId: game.guildId,
        userId: game.opponentId,
        amount: winnerId === null ? 0 : winnerId === game.opponentId ? game.bet : -game.bet,
        reason: reasonFor(game.opponentId),
        relatedUserId: game.challengerId,
        sessionKey: `chinchiro:${game.id}:${game.opponentId}`,
      },
    ]);

    return { game, challengerOutcome, opponentOutcome, winnerId };
  });
}

export async function refundExpiredChinchiroGames(now = new Date()): Promise<number> {
  const expired = await db
    .select({ id: chinchiroGamesTable.id })
    .from(chinchiroGamesTable)
    .where(and(
      inArray(chinchiroGamesTable.status, OPEN_STATUSES),
      lt(chinchiroGamesTable.expiresAt, now),
    ));
  let refunded = 0;
  for (const { id } of expired) {
    if (await closeAndRefund(id, OPEN_STATUSES, "expired")) refunded++;
  }
  return refunded;
}

const expiryTimer = setInterval(() => {
  void refundExpiredChinchiroGames().then((count) => {
    if (count > 0) logger.info(`[chinchiro] Refunded ${count} expired game(s)`);
  }).catch((error) => logger.error("[chinchiro] Expiry refund failed", error));
}, 30_000);
expiryTimer.unref();

async function getGame(id: number): Promise<ChinchiroGame | null> {
  const [game] = await db
    .select()
    .from(chinchiroGamesTable)
    .where(eq(chinchiroGamesTable.id, id));
  return game ?? null;
}

async function handleAccept(interaction: ButtonInteraction, game: ChinchiroGame): Promise<void> {
  if (interaction.user.id !== game.opponentId) {
    await interaction.reply({
      content: "この挑戦を受けられるのは指定された対戦相手だけです。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferUpdate();
  const result = await acceptChallenge(game.id);
  if (!result.ok) {
    const content = result.reason === "insufficient_funds"
      ? `残高が不足しています。**${game.bet.toLocaleString()}** ${game.currencyName} が必要です。`
      : "この挑戦はすでに終了しているか、期限切れです。";
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.message.edit({
    content: "",
    embeds: [buildActiveEmbed(result.game)],
    components: rollComponents(result.game.id),
    allowedMentions: { parse: [] },
  });
}

async function handleDecline(interaction: ButtonInteraction, game: ChinchiroGame): Promise<void> {
  if (![game.challengerId, game.opponentId].includes(interaction.user.id)) {
    await interaction.reply({
      content: "この挑戦を辞退・取り消しできるのは対戦者だけです。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferUpdate();
  const closed = await closeAndRefund(game.id, ["pending"], "declined");
  if (!closed) {
    await interaction.followUp({
      content: "この挑戦はすでに開始または終了しています。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.message.edit({
    content: "",
    embeds: [
      new EmbedBuilder()
        .setTitle("🎲 対人チンチロ — キャンセル")
        .setColor(COLOR_CANCEL)
        .setDescription(`勝負はキャンセルされ、<@${closed.challengerId}> に賭け金を返金しました。`),
    ],
    components: [],
    allowedMentions: { parse: [] },
  });
}

async function handleRoll(interaction: ButtonInteraction, game: ChinchiroGame): Promise<void> {
  if (![game.challengerId, game.opponentId].includes(interaction.user.id)) {
    await interaction.reply({
      content: "サイコロを振れるのは対戦者だけです。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.deferUpdate();
  const outcome = rollChinchiroHand();
  const updated = await recordRoll(game, interaction.user.id, outcome);
  if (!updated) {
    await interaction.followUp({
      content: "すでにサイコロを振ったか、この勝負は期限切れです。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (updated.challengerRoll && updated.opponentRoll) {
    const settlement = await settleGame(updated.id);
    if (!settlement) {
      await interaction.followUp({
        content: "この勝負はすでに精算されています。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.message.edit({
      content: "",
      embeds: [buildResultEmbed(settlement)],
      components: [],
      allowedMentions: { parse: [] },
    });
    return;
  }

  await interaction.message.edit({
    content: "",
    embeds: [buildActiveEmbed(updated)],
    components: rollComponents(updated.id),
    allowedMentions: { parse: [] },
  });
}

export async function handleChinchiroButton(interaction: ButtonInteraction): Promise<void> {
  const [, action, rawId] = interaction.customId.split(":");
  const id = Number(rawId);
  if (!Number.isSafeInteger(id)) {
    await interaction.reply({ content: "無効な対戦です。", flags: MessageFlags.Ephemeral });
    return;
  }
  const game = await getGame(id);
  if (!game || game.guildId !== interaction.guildId) {
    await interaction.reply({
      content: "対戦データが見つかりません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (game.expiresAt <= new Date() && OPEN_STATUSES.includes(game.status)) {
    await closeAndRefund(game.id, OPEN_STATUSES, "expired");
    await interaction.update({
      content: "",
      embeds: [
        new EmbedBuilder()
          .setTitle("🎲 対人チンチロ — 期限切れ")
          .setColor(COLOR_CANCEL)
          .setDescription("勝負は期限切れになり、預けられた賭け金を返金しました。"),
      ],
      components: [],
    });
    return;
  }
  if (action === "accept") {
    await handleAccept(interaction, game);
  } else if (action === "decline") {
    await handleDecline(interaction, game);
  } else if (action === "roll") {
    await handleRoll(interaction, game);
  }
}

async function handleChallenge(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId || !interaction.channelId) return;
  const opponent = interaction.options.getUser("opponent", true);
  const bet = interaction.options.getInteger("bet", true);

  if (opponent.id === interaction.user.id) {
    await interaction.reply({
      content: "自分自身には挑戦できません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (opponent.bot) {
    await interaction.reply({
      content: "Botには挑戦できません。プレイヤーを指定してください。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();
  const settings = await getGuildSettings(interaction.guildId);
  const maxBet = settings.casinoMaxBet ?? CASINO_DEFAULT_MAX_BET;
  if (bet > maxBet) {
    await interaction.editReply(
      `賭け金が上限（**${maxBet.toLocaleString()}** ${settings.currencyName}）を超えています。`,
    );
    return;
  }

  const created = await createChallenge(
    interaction.guildId,
    interaction.channelId,
    interaction.user.id,
    opponent.id,
    bet,
    settings.currencyName,
  );
  if (!created.ok) {
    await interaction.editReply(
      created.reason === "busy"
        ? "どちらかのプレイヤーに進行中のチンチロがあります。先の勝負を終わらせてください。"
        : `残高が不足しています。**${bet.toLocaleString()}** ${settings.currencyName} が必要です。`,
    );
    return;
  }

  try {
    const message = await interaction.editReply({
      content: `<@${opponent.id}> 対人チンチロの挑戦が届いています。`,
      embeds: [buildChallengeEmbed(created.game)],
      components: challengeComponents(created.game.id),
      allowedMentions: { users: [opponent.id] },
    });
    await db
      .update(chinchiroGamesTable)
      .set({ messageId: message.id })
      .where(eq(chinchiroGamesTable.id, created.game.id));
  } catch (error) {
    await closeAndRefund(created.game.id, ["pending"], "expired");
    throw error;
  }
}

export const chinchiroCommand = {
  data: new SlashCommandBuilder()
    .setName("chinchiro")
    .setDescription("プレイヤー同士でチンチロ勝負をする")
    .setDefaultMemberPermissions(0)
    .addUserOption((option) =>
      option
        .setName("opponent")
        .setDescription("対戦相手")
        .setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName("bet")
        .setDescription(`1人あたりの賭け金（最低${MIN_BET.toLocaleString()}）`)
        .setMinValue(MIN_BET)
        .setMaxValue(CASINO_DEFAULT_MAX_BET)
        .setRequired(true),
    ),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await handleChallenge(interaction);
  },
};