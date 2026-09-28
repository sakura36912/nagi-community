import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags,
  ModalBuilder, SlashCommandBuilder, TextInputBuilder, TextInputStyle,
  PermissionFlagsBits, ChannelType, escapeMarkdown,
  type Client, type Guild, type VoiceState,
  type ButtonInteraction, type ChatInputCommandInteraction, type ModalSubmitInteraction,
} from "discord.js";
import { and, asc, eq, inArray, isNull, lt, notInArray, sql } from "drizzle-orm";
import {
  chinchiroMultiplayerSettingsTable, chinchiroTablePlayersTable, chinchiroTablesTable,
  db, type ChinchiroTable, type ChinchiroTablePlayer,
} from "@workspace/db";
import { isConfiguredHubVoice } from "../lib/configuredHubVoice";
import { getGuildSettings } from "../lib/economy";
import { logger } from "../lib/logger";
import {
  isChinchiroHandComplete,
  rollChinchiroOnce,
  type ChinchiroOutcome,
} from "./chinchiro";

export const MULTIPLAYER_CHINCHIRO_PREFIX = "chinchiro-mp:";
const RECRUIT_MS = 5 * 60_000, BET_MS = 2 * 60_000, TURN_MS = 60_000;
const OPEN_TABLE_STATUSES = ["recruiting", "betting", "rolling", "finished"];

export function pairStake(parentBet: number, childBet: number): number {
  return Math.min(parentBet, childBet);
}

/** The winning hand's multiplier is used for each parent/child pair. */
export function chinchiroMultiplier(outcome: Pick<ChinchiroOutcome, "kind">): number {
  switch (outcome.kind) {
    case "pinzoro": return 5;
    case "arashi": return 3;
    case "shigoro": return 2;
    case "hifumi": return 2;
    case "point":
    case "menashi": return 1;
  }
}

export function plannedPairResult(parentBet: number, childBet: number, parent: ChinchiroOutcome, child: ChinchiroOutcome) {
  const stake = pairStake(parentBet, childBet);
  const winner = parent.rank >= child.rank ? "parent" as const : "child" as const;
  const winning = winner === "parent" ? parent : child;
  const losing = winner === "parent" ? child : parent;
  const multiplier = Math.max(
    chinchiroMultiplier(winning),
    losing.kind === "hifumi" ? 2 : 1,
  );
  return { stake, winner, multiplier, amount: stake * multiplier };
}

export interface MultiplayerPairResult {
  childId: string;
  stake: number;
  winner: "parent" | "child" | "draw";
  multiplier?: number;
  amount: number;
  parent: ChinchiroOutcome;
  child: ChinchiroOutcome;
}

export function rollOrder(parentId: string, activePlayers: Pick<ChinchiroTablePlayer, "userId" | "joinOrder">[]): string[] {
  return [parentId, ...activePlayers
    .filter((player) => player.userId !== parentId)
    .sort((a, b) => a.joinOrder - b.joinOrder)
    .map((player) => player.userId)];
}

export function calculateRoundResults(parentId: string, activePlayers: ChinchiroTablePlayer[]): {
  pairs: MultiplayerPairResult[];
  net: Record<string, number>;
} {
  const parent = activePlayers.find((player) => player.userId === parentId);
  if (!parent?.bet || !parent.roll) throw new Error("Parent bet or roll is missing");
  const parentRoll = JSON.parse(parent.roll) as ChinchiroOutcome;
  const net: Record<string, number> = Object.fromEntries(activePlayers.map((p) => [p.userId, 0]));
  const pairs = activePlayers.filter((p) => p.userId !== parentId).map((child) => {
    if (!child.bet || !child.roll) throw new Error("Child bet or roll is missing");
    const result = plannedPairResult(parent.bet!, child.bet, parentRoll, JSON.parse(child.roll) as ChinchiroOutcome);
    if (result.winner === "parent") {
      net[parentId] += result.amount;
      net[child.userId] -= result.amount;
    } else if (result.winner === "child") {
      net[parentId] -= result.amount;
      net[child.userId] += result.amount;
    }
    return { childId: child.userId, ...result, parent: parentRoll, child: JSON.parse(child.roll) as ChinchiroOutcome };
  });
  return { pairs, net };
}

interface StoredRoundResult {
  round: number;
  parentId: string;
  completedAt: string;
  result: ReturnType<typeof calculateRoundResults>;
}

function parseHistory(raw: string | null): StoredRoundResult[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed as StoredRoundResult[] : [];
  } catch {
    return [];
  }
}

function displayNameFor(ps: ChinchiroTablePlayer[], userId: string | null): string {
  return ps.find((player) => player.userId === userId)?.displayName ?? "参加者";
}

async function settings(guildId: string) {
  const [row] = await db.select().from(chinchiroMultiplayerSettingsTable)
    .where(eq(chinchiroMultiplayerSettingsTable.guildId, guildId));
  if (row) return row;
  const [created] = await db.insert(chinchiroMultiplayerSettingsTable)
    .values({ guildId }).onConflictDoNothing().returning();
  return created ?? (await db.select().from(chinchiroMultiplayerSettingsTable)
    .where(eq(chinchiroMultiplayerSettingsTable.guildId, guildId)))[0]!;
}
async function table(id: number) {
  const [row] = await db.select().from(chinchiroTablesTable).where(eq(chinchiroTablesTable.id, id));
  return row ?? null;
}
async function lockTable(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  tableId: number,
): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${tableId})`);
}
async function lockUsers(
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
async function findOpenTableForUser(
  guildId: string,
  userId: string,
  excludeTableId?: number,
): Promise<number | null> {
  const conditions = [
    eq(chinchiroTablesTable.guildId, guildId),
    inArray(chinchiroTablesTable.status, OPEN_TABLE_STATUSES),
    eq(chinchiroTablePlayersTable.userId, userId),
    eq(chinchiroTablePlayersTable.active, 1),
  ];
  if (excludeTableId !== undefined) {
    conditions.push(sql`${chinchiroTablesTable.id} <> ${excludeTableId}`);
  }
  const [row] = await db.select({ id: chinchiroTablesTable.id })
    .from(chinchiroTablePlayersTable)
    .innerJoin(chinchiroTablesTable, eq(chinchiroTablePlayersTable.tableId, chinchiroTablesTable.id))
    .where(and(...conditions))
    .limit(1);
  return row?.id ?? null;
}
async function players(tableId: number) {
  return db.select().from(chinchiroTablePlayersTable).where(and(
    eq(chinchiroTablePlayersTable.tableId, tableId), eq(chinchiroTablePlayersTable.active, 1),
  )).orderBy(asc(chinchiroTablePlayersTable.joinOrder));
}
async function allPlayers(tableId: number) {
  return db.select().from(chinchiroTablePlayersTable)
    .where(eq(chinchiroTablePlayersTable.tableId, tableId))
    .orderBy(asc(chinchiroTablePlayersTable.joinOrder));
}
export function buildMultiplayerChinchiroComponents(
  t: ChinchiroTable,
  ps: ChinchiroTablePlayer[] = [],
) {
  const id = t.id;
  if (t.status === "recruiting") return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${MULTIPLAYER_CHINCHIRO_PREFIX}join:${id}`).setLabel("参加").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${MULTIPLAYER_CHINCHIRO_PREFIX}leave:${id}`).setLabel("退出").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${MULTIPLAYER_CHINCHIRO_PREFIX}start:${id}`).setLabel("開始").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${MULTIPLAYER_CHINCHIRO_PREFIX}close:${id}`).setLabel("募集終了").setStyle(ButtonStyle.Danger),
  )];
  if (t.status === "betting") return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${MULTIPLAYER_CHINCHIRO_PREFIX}bet:${id}`).setLabel("賭け金を入力").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${MULTIPLAYER_CHINCHIRO_PREFIX}leave:${id}`).setLabel("退出").setStyle(ButtonStyle.Secondary),
  )];
  if (t.status === "rolling" && t.turnUserId) {
    const currentPlayer = ps.find((player) => player.userId === t.turnUserId);
    const previous = parsePlayerRoll(currentPlayer?.roll ?? null);
    const attempt = Math.min((previous?.attempts.length ?? 0) + 1, 3);
    return turnRollComponents(t.id, attempt);
  }
  if (t.status === "finished") return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${MULTIPLAYER_CHINCHIRO_PREFIX}next:${id}`).setLabel("次のラウンド").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${MULTIPLAYER_CHINCHIRO_PREFIX}end:${id}`).setLabel("終了").setStyle(ButtonStyle.Danger),
  )];
  return [];
}

function parsePlayerRoll(raw: string | null): ChinchiroOutcome | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ChinchiroOutcome;
  } catch {
    return null;
  }
}

function turnRollComponents(tableId: number, attempt: number) {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${MULTIPLAYER_CHINCHIRO_PREFIX}roll:${tableId}:${attempt}`)
      .setLabel(`サイコロを振る（${attempt}投目）`)
      .setEmoji("🎲")
      .setStyle(ButtonStyle.Primary),
  )];
}

function dice(outcome: ChinchiroOutcome): string {
  return outcome.dice.map((die) => ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"][die - 1]).join(" ");
}
export function buildMultiplayerChinchiroPanel(t: ChinchiroTable, ps: ChinchiroTablePlayer[]) {
  const title = t.status === "recruiting" ? "🎲 チンチロ募集（テストモード）" : "🎲 チンチロ（テストモード）";
  const list = ps.map((p) => `${escapeMarkdown(p.displayName)}${p.userId === t.parentId ? " 👑 親" : ""}${p.bet ? ` — ${p.bet.toLocaleString()} ${t.currencyName}` : ""}`).join("\n") || "参加者なし";
  const turn = t.status === "rolling" && t.turnUserId
    ? `\n手番: **${escapeMarkdown(displayNameFor(ps, t.turnUserId))}**（60秒）`
    : "";
  const currentRollText = !t.results ? ps.filter((p) => p.roll).map((p) => {
    try {
      const outcome = JSON.parse(p.roll!) as ChinchiroOutcome;
      return `${escapeMarkdown(p.displayName)}: ${outcome.label} ${dice(outcome)}（ロール済み）`;
    } catch {
      return `${escapeMarkdown(p.displayName)}: ロール済み`;
    }
  }).join("\n") : "";
  const embed = new EmbedBuilder().setTitle(title).setDescription(`${list}${turn}`).addFields({
    name: "状態", value: `${statusLabel(t.status)} / ${ps.length}/6人`, inline: true,
  });
  if (t.results) {
    const result = JSON.parse(t.results) as ReturnType<typeof calculateRoundResults>;
    const parentRoll = result.pairs[0]?.parent;
    const parentValue = parentRoll
      ? `**${escapeMarkdown(displayNameFor(ps, t.parentId))}**\n${dice(parentRoll)}（${parentRoll.label}）`
      : "結果なし";
    const childValue = result.pairs.map((pair) =>
      `**${escapeMarkdown(displayNameFor(ps, pair.childId))}**\n${dice(pair.child)}（${pair.child.label}）`,
    ).join("\n\n") || "結果なし";
    const amountValue = Object.entries(result.net).map(([id, amount]) =>
      `${escapeMarkdown(displayNameFor(ps, id))}：${amount > 0 ? "+" : amount === 0 ? "±" : ""}${amount.toLocaleString()} ${t.currencyName}`,
    ).join("\n");
    embed.addFields(
      { name: "【親】", value: parentValue.slice(0, 1024), inline: false },
      { name: "【子】", value: childValue.slice(0, 1024), inline: false },
      { name: "【金額（予定増減）】", value: amountValue.slice(0, 1024), inline: false },
    );
  } else if (currentRollText) {
    embed.addFields({ name: "現在のロール結果", value: currentRollText.slice(0, 1024), inline: false });
  }
  if (t.status === "recruiting") {
    embed.setFooter({ text: "募集期限 5分。開始には同じ設定VCの2人以上が必要です。" });
  }
  return embed;
}

function statusLabel(status: string): string {
  return {
    recruiting: "募集中",
    betting: "BET入力中",
    rolling: "ロール中",
    finished: "結果確定",
    closed: "終了",
  }[status] ?? status;
}
function resultSummary(raw: string | null, ps: ChinchiroTablePlayer[] = []): string {
  if (!raw) return "";
  const result = JSON.parse(raw) as ReturnType<typeof calculateRoundResults>;
  return Object.entries(result.net).map(([userId, amount]) =>
    `${escapeMarkdown(displayNameFor(ps, userId))} ${amount >= 0 ? "+" : ""}${amount}`,
  ).join(" / ");
}
async function refreshPanelForGuild(guild: Guild, t: ChinchiroTable) {
  if (!t.messageId) return;
  const channel = await guild.channels.fetch(t.channelId).catch(() => null);
  if (!channel?.isTextBased() || !("messages" in channel)) return;
  const message = await channel.messages.fetch(t.messageId).catch(() => null);
  if (message) {
    const ps = await players(t.id);
    await message.edit({
      embeds: [buildMultiplayerChinchiroPanel(t, ps)],
      components: buildMultiplayerChinchiroComponents(t, ps), attachments: [],
    });
  }
}
async function refreshStoredPanel(interaction: ChatInputCommandInteraction, t: ChinchiroTable) {
  if (interaction.guild) await refreshPanelForGuild(interaction.guild, t);
}
async function sendConfiguredLog(guild: Guild, t: ChinchiroTable, event: string) {
  const config = await settings(t.guildId);
  if (!config.logChannelId) return;
  const channel = await guild.channels.fetch(config.logChannelId).catch(() => null);
  const ps = await allPlayers(t.id);
  if (channel?.isTextBased()) await channel.send(`🎲 チンチロ卓 #${t.id}: ${event}${t.results ? `\n${resultSummary(t.results, ps)}` : ""}`).catch(() => undefined);
}

async function resolvedDisplayName(guild: Guild, userId: string): Promise<string> {
  const member = guild.members.cache.get(userId)
    ?? await guild.members.fetch(userId).catch(() => null);
  if (member) return member.displayName;
  const user = await guild.client.users.fetch(userId).catch(() => null);
  return user?.globalName ?? user?.username ?? "参加者";
}
async function closeTableForDeparture(tableId: number, departedId: string) {
  return db.transaction(async (tx) => {
    await lockTable(tx, tableId);
    const [current] = await tx.select().from(chinchiroTablesTable)
      .where(eq(chinchiroTablesTable.id, tableId))
      .for("update");
    if (!current || current.status === "closed") {
      return { table: current ?? null, departed: null };
    }
    const [departed] = await tx.update(chinchiroTablePlayersTable)
      .set({ active: 0 })
      .where(and(
        eq(chinchiroTablePlayersTable.tableId, tableId),
        eq(chinchiroTablePlayersTable.userId, departedId),
        eq(chinchiroTablePlayersTable.active, 1),
      ))
      .returning();
    if (!departed) return { table: current, departed: null };

    // Multiplayer bets are not debited while test mode is active, so closing
    // the table is the refund: no balance credit is added or money minted.
    const [closed] = await tx.update(chinchiroTablesTable)
      .set({ status: "closed", turnUserId: null })
      .where(and(
        eq(chinchiroTablesTable.id, tableId),
        inArray(chinchiroTablesTable.status, OPEN_TABLE_STATUSES),
      ))
      .returning();
    return { table: closed ?? current, departed };
  });
}

function appendRoundHistory(
  tableRow: ChinchiroTable,
  result: ReturnType<typeof calculateRoundResults>,
): string {
  const history = parseHistory(tableRow.history);
  history.push({
    round: tableRow.round,
    parentId: tableRow.parentId!,
    completedAt: new Date().toISOString(),
    result,
  });
  return JSON.stringify(history.slice(-50));
}

interface TurnThrowResult {
  table: ChinchiroTable;
  outcome: ChinchiroOutcome;
}

async function takeTurnThrow(
  tableId: number,
  userId: string,
  options: {
    expectedAttempt?: number;
    now?: Date;
    allowExpired?: boolean;
  } = {},
): Promise<TurnThrowResult | null> {
  const now = options.now ?? new Date();
  return db.transaction(async (tx) => {
    await lockTable(tx, tableId);
    const [current] = await tx.select().from(chinchiroTablesTable)
      .where(eq(chinchiroTablesTable.id, tableId))
      .for("update");
    if (!current || current.status !== "rolling" || current.turnUserId !== userId) return null;
    const isExpired = current.expiresAt < now;
    if (options.allowExpired ? !isExpired : isExpired) return null;

    const currentPlayers = await tx.select().from(chinchiroTablePlayersTable).where(and(
      eq(chinchiroTablePlayersTable.tableId, tableId),
      eq(chinchiroTablePlayersTable.active, 1),
    )).orderBy(asc(chinchiroTablePlayersTable.joinOrder));
    const currentPlayer = currentPlayers.find((player) => player.userId === userId);
    if (!currentPlayer) return null;
    const previous = parsePlayerRoll(currentPlayer.roll);
    if (previous && isChinchiroHandComplete(previous)) return null;
    const attempt = (previous?.attempts.length ?? 0) + 1;
    if (options.expectedAttempt !== undefined && options.expectedAttempt !== attempt) return null;

    const outcome = rollChinchiroOnce(previous?.attempts ?? []);
    const rollGuard = currentPlayer.roll === null
      ? isNull(chinchiroTablePlayersTable.roll)
      : eq(chinchiroTablePlayersTable.roll, currentPlayer.roll);
    const [written] = await tx.update(chinchiroTablePlayersTable)
      .set({ roll: JSON.stringify(outcome) })
      .where(and(
        eq(chinchiroTablePlayersTable.tableId, tableId),
        eq(chinchiroTablePlayersTable.userId, userId),
        eq(chinchiroTablePlayersTable.active, 1),
        rollGuard,
      ))
      .returning();
    if (!written) return null;

    if (!isChinchiroHandComplete(outcome)) {
      const [sameTurn] = await tx.update(chinchiroTablesTable)
        .set({ expiresAt: new Date(now.getTime() + TURN_MS) })
        .where(and(
          eq(chinchiroTablesTable.id, tableId),
          eq(chinchiroTablesTable.status, "rolling"),
          eq(chinchiroTablesTable.turnUserId, userId),
        ))
        .returning();
      return sameTurn ? { table: sameTurn, outcome } : null;
    }

    const resolvedPlayers = currentPlayers.map((player) =>
      player.userId === userId ? { ...player, roll: JSON.stringify(outcome) } : player,
    );
    const order = rollOrder(current.parentId!, resolvedPlayers);
    const currentIndex = order.indexOf(userId);
    const next = order.slice(currentIndex + 1).find((candidateId) => {
      const candidate = resolvedPlayers.find((player) => player.userId === candidateId);
      const candidateRoll = parsePlayerRoll(candidate?.roll ?? null);
      return !candidateRoll || !isChinchiroHandComplete(candidateRoll);
    });
    if (next) {
      const [nextTable] = await tx.update(chinchiroTablesTable)
        .set({ turnUserId: next, expiresAt: new Date(now.getTime() + TURN_MS) })
        .where(and(
          eq(chinchiroTablesTable.id, tableId),
          eq(chinchiroTablesTable.status, "rolling"),
          eq(chinchiroTablesTable.turnUserId, userId),
        ))
        .returning();
      return nextTable ? { table: nextTable, outcome } : null;
    }

    const result = calculateRoundResults(current.parentId!, resolvedPlayers);
    const [finished] = await tx.update(chinchiroTablesTable)
      .set({
        status: "finished",
        turnUserId: null,
        results: JSON.stringify(result),
        history: appendRoundHistory(current, result),
      })
      .where(and(
        eq(chinchiroTablesTable.id, tableId),
        eq(chinchiroTablesTable.status, "rolling"),
        eq(chinchiroTablesTable.turnUserId, userId),
      ))
      .returning();
    return finished ? { table: finished, outcome } : null;
  });
}

async function redraw(interaction: ButtonInteraction | ModalSubmitInteraction, t: ChinchiroTable) {
  const ps = await players(t.id);
  await interaction.message?.edit({
    embeds: [buildMultiplayerChinchiroPanel(t, ps)],
    components: buildMultiplayerChinchiroComponents(t, ps), attachments: [],
    allowedMentions: { users: ps.map((p) => p.userId) },
  });
}
export async function isConfiguredChinchiroVoice(
  guildId: string,
  channelId: string | null,
  configuredVoiceId: string | null,
): Promise<boolean> {
  return isConfiguredHubVoice(guildId, channelId, configuredVoiceId);
}

async function inConfiguredVoice(
  interaction: ButtonInteraction | ChatInputCommandInteraction | ModalSubmitInteraction,
  voiceId: string | null,
): Promise<boolean> {
  const channelId = await currentVoiceChannelId(interaction);
  return isConfiguredChinchiroVoice(interaction.guildId ?? "", channelId, voiceId);
}

async function currentVoiceChannelId(
  interaction: ButtonInteraction | ChatInputCommandInteraction | ModalSubmitInteraction,
): Promise<string | null> {
  const guild = interaction.guild;
  if (!guild) return null;

  const cachedChannelId = guild.members.cache.get(interaction.user.id)?.voice.channelId ?? null;
  if (cachedChannelId) return cachedChannelId;

  // Interaction member caches can lag behind a recent VC join/transfer.
  // Fetch the member once before deciding that the participant is not in a VC.
  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  return member?.voice.channelId ?? null;
}

export const chinchiroRecruitCommand = {
  data: new SlashCommandBuilder().setName("chinchiro").setDescription("複数人チンチロ（テストモード）")
    .addSubcommand((s) => s.setName("recruit").setDescription("チンチロ参加者を募集する"))
    .addSubcommand((s) => s.setName("config").setDescription("管理者設定").addChannelOption((o) =>
      o.setName("voice").setDescription("参加必須VC").addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice))
      .addIntegerOption((o) => o.setName("min_bet").setDescription("最低賭け金").setMinValue(1))
      .addIntegerOption((o) => o.setName("max_bet").setDescription("最高賭け金").setMinValue(1))
      .addChannelOption((o) =>
        o.setName("logs").setDescription("ログ送信先").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand((s) => s.setName("force-end").setDescription("卓を強制終了").addIntegerOption((o) => o.setName("table").setDescription("卓ID").setRequired(true)))
    .addSubcommand((s) => s.setName("kick").setDescription("卓から参加者を外す").addIntegerOption((o) => o.setName("table").setDescription("卓ID").setRequired(true)).addUserOption((o) => o.setName("user").setDescription("参加者").setRequired(true)))
    .addSubcommand((s) => s.setName("logs").setDescription("最近終了した卓の結果を表示")),
  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guildId || !interaction.channelId) return;
    const subcommand = interaction.options.getSubcommand();
    if (subcommand !== "recruit") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({ content: "この操作にはサーバー管理権限が必要です。", flags: MessageFlags.Ephemeral }); return;
      }
      if (subcommand === "config") {
        const selectedVoiceChannel = interaction.options.getChannel("voice");
        const logChannel = interaction.options.getChannel("logs");
        const minBet = interaction.options.getInteger("min_bet");
        const maxBet = interaction.options.getInteger("max_bet");
        const hasExplicitOption = Boolean(selectedVoiceChannel || logChannel || minBet !== null || maxBet !== null);
        const joinedVoiceId = hasExplicitOption ? null : await currentVoiceChannelId(interaction);
        const voiceChannel = selectedVoiceChannel
          ?? (joinedVoiceId ? await interaction.guild!.channels.fetch(joinedVoiceId).catch(() => null) : null);
        if (voiceChannel && ![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(voiceChannel.type)) { await interaction.reply({ content: "voiceにはボイスチャンネルを指定してください。", flags: MessageFlags.Ephemeral }); return; }
        if (logChannel && ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(logChannel.type)) { await interaction.reply({ content: "logsにはテキストチャンネルを指定してください。", flags: MessageFlags.Ephemeral }); return; }
        const voice = voiceChannel?.id, logs = logChannel?.id;
        const current = await settings(interaction.guildId);
        const nextMin = minBet ?? current.minBet, nextMax = maxBet ?? current.maxBet;
        if (nextMin > nextMax) { await interaction.reply({ content: "最低賭け金は最高賭け金以下にしてください。", flags: MessageFlags.Ephemeral }); return; }
        if (!hasExplicitOption && !voice) {
          await interaction.reply({
            content: "設定するVCに参加してから、オプションなしで `/chinchiro config` を実行してください。",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        await db.update(chinchiroMultiplayerSettingsTable).set({
          voiceChannelId: voice ?? current.voiceChannelId, logChannelId: logs ?? current.logChannelId,
          minBet: nextMin, maxBet: nextMax, testMode: 1,
        }).where(eq(chinchiroMultiplayerSettingsTable.guildId, interaction.guildId));
        const savedVoiceId = voice ?? current.voiceChannelId;
        await interaction.reply({
          content: `チンチロ設定を保存しました。\n参加必須VC: ${savedVoiceId ? `<#${savedVoiceId}>` : "未設定"}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (subcommand === "logs") {
        const rows = await db.select().from(chinchiroTablesTable).where(and(eq(chinchiroTablesTable.guildId, interaction.guildId), inArray(chinchiroTablesTable.status, ["finished", "closed"]))).orderBy(sql`${chinchiroTablesTable.updatedAt} desc`).limit(10);
        const entries = (await Promise.all(rows.map(async (row) => {
          const names = await allPlayers(row.id);
          return parseHistory(row.history).map((round) =>
            `#${row.id} round ${round.round}: ${resultSummary(JSON.stringify(round.result), names)}`,
          );
        }))).flat();
        await interaction.reply({ content: entries.length ? entries.join("\n").slice(0, 1900) : "終了済みのラウンドはありません。", flags: MessageFlags.Ephemeral }); return;
      }
      const target = await table(interaction.options.getInteger("table", true));
      if (!target || target.guildId !== interaction.guildId) { await interaction.reply({ content: "卓が見つかりません。", flags: MessageFlags.Ephemeral }); return; }
      if (subcommand === "force-end") {
        await db.update(chinchiroTablesTable).set({ status: "closed", turnUserId: null }).where(eq(chinchiroTablesTable.id, target.id));
        await refreshStoredPanel(interaction, { ...target, status: "closed", turnUserId: null });
        await sendConfiguredLog(interaction.guild!, target, "管理者により強制終了");
        await interaction.reply({ content: `卓 #${target.id} を終了しました（テストモードのため精算なし）。`, flags: MessageFlags.Ephemeral }); return;
      }
      const user = interaction.options.getUser("user", true);
      const departure = await closeTableForDeparture(target.id, user.id);
      if (!departure.departed) {
        await interaction.reply({ content: "指定したユーザーはこの卓に参加していません。", flags: MessageFlags.Ephemeral });
        return;
      }
      const fresh = departure.table; if (fresh) await refreshStoredPanel(interaction, fresh);
      await interaction.reply({ content: `<@${user.id}> の退出により卓 #${target.id} を終了しました。賭け金は返金されました。`, flags: MessageFlags.Ephemeral, allowedMentions: { users: [user.id] } }); return;
    }
    const config = await settings(interaction.guildId);
    if (!await inConfiguredVoice(interaction, config.voiceChannelId)) {
      const currentVoiceId = await currentVoiceChannelId(interaction);
      logger.warn(
        `[chinchiro] Recruit rejected by VC gate guild=${interaction.guildId} user=${interaction.user.id} ` +
        `configured=${config.voiceChannelId ?? "none"} current=${currentVoiceId ?? "none"}`,
      );
      await interaction.reply({
        content:
          `管理者が設定したボイスチャンネルに参加してから募集してください。\n` +
          `設定VC: ${config.voiceChannelId ? `<#${config.voiceChannelId}>` : "未設定"}\n` +
          `現在VC: ${currentVoiceId ? `<#${currentVoiceId}>` : "未参加"}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const economy = await getGuildSettings(interaction.guildId);
    const displayName = await resolvedDisplayName(interaction.guild!, interaction.user.id);
    const t = await db.transaction(async (tx) => {
      await lockUsers(tx, interaction.guildId!, [interaction.user.id]);
      const [open] = await tx.select({ id: chinchiroTablesTable.id }).from(chinchiroTablePlayersTable)
        .innerJoin(chinchiroTablesTable, eq(chinchiroTablePlayersTable.tableId, chinchiroTablesTable.id))
        .where(and(eq(chinchiroTablesTable.guildId, interaction.guildId!), inArray(chinchiroTablesTable.status, OPEN_TABLE_STATUSES), eq(chinchiroTablePlayersTable.userId, interaction.user.id), eq(chinchiroTablePlayersTable.active, 1))).limit(1);
      if (open) return null;
      const [created] = await tx.insert(chinchiroTablesTable).values({
        guildId: interaction.guildId!, channelId: interaction.channelId, ownerId: interaction.user.id,
        currencyName: economy.currencyName, expiresAt: new Date(Date.now() + RECRUIT_MS),
      }).returning();
      if (!created) throw new Error("Failed to create multiplayer chinchiro table");
      await tx.insert(chinchiroTablePlayersTable).values({ tableId: created.id, userId: interaction.user.id, displayName, joinOrder: 1 });
      return created;
    });
    if (!t) { await interaction.reply({ content: "すでに進行中または募集済みの卓に参加しています。", flags: MessageFlags.Ephemeral }); return; }
    const ps = await players(t.id);
    const message = await interaction.reply({ embeds: [buildMultiplayerChinchiroPanel(t, ps)], components: buildMultiplayerChinchiroComponents(t, ps), fetchReply: true });
    await db.update(chinchiroTablesTable).set({ messageId: message.id }).where(eq(chinchiroTablesTable.id, t.id));
  },
};

export async function handleMultiplayerChinchiroButton(interaction: ButtonInteraction) {
  const [, action, raw, rawAttempt] = interaction.customId.split(":");
  const id = Number(raw);
  const expectedAttempt = rawAttempt === undefined ? undefined : Number(rawAttempt);
  const t = await table(id);
  const isDirectMessageRoll = action === "roll" && interaction.guildId === null;
  if (!t || (!isDirectMessageRoll && t.guildId !== interaction.guildId) || !Number.isSafeInteger(id)) {
    await interaction.reply({ content: "卓が見つかりません。", flags: MessageFlags.Ephemeral }); return;
  }
  if (t.expiresAt < new Date() && !["finished", "closed"].includes(t.status)) {
    await db.update(chinchiroTablesTable).set({ status: "closed" }).where(eq(chinchiroTablesTable.id, id));
    await interaction.deferUpdate(); await redraw(interaction, { ...t, status: "closed" }); return;
  }
  const config = await settings(t.guildId);
  if (action === "bet") {
    const modal = new ModalBuilder().setCustomId(`${MULTIPLAYER_CHINCHIRO_PREFIX}betmodal:${id}`).setTitle("賭け金を入力");
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId("bet").setLabel(`${config.minBet}〜${config.maxBet}`).setStyle(TextInputStyle.Short).setRequired(true)));
    await interaction.showModal(modal); return;
  }
  if (action === "join") {
    if (t.status !== "recruiting" || !await inConfiguredVoice(interaction, config.voiceChannelId)) {
      const currentVoiceId = await currentVoiceChannelId(interaction);
      await interaction.reply({
        content:
          "募集中で、設定VCまたはそこからVC Hubで転送されたVCにいる場合のみ参加できます。\n" +
          `設定VC: ${config.voiceChannelId ? `<#${config.voiceChannelId}>` : "未設定"}\n` +
          `現在VC: ${currentVoiceId ? `<#${currentVoiceId}>` : "未参加"}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const displayName = await resolvedDisplayName(interaction.guild!, interaction.user.id);
    const joined = await db.transaction(async (tx) => {
      await lockUsers(tx, t.guildId, [interaction.user.id]);
      await lockTable(tx, id);
      const [current] = await tx.select().from(chinchiroTablesTable).where(eq(chinchiroTablesTable.id, id)).for("update");
      if (!current || current.status !== "recruiting") return false;
      const active = await tx.select().from(chinchiroTablePlayersTable).where(and(eq(chinchiroTablePlayersTable.tableId, id), eq(chinchiroTablePlayersTable.active, 1)));
      if (active.some((p) => p.userId === interaction.user.id) || active.length >= 6) return false;
      const [open] = await tx.select({ id: chinchiroTablesTable.id }).from(chinchiroTablePlayersTable).innerJoin(chinchiroTablesTable, eq(chinchiroTablePlayersTable.tableId, chinchiroTablesTable.id))
        .where(and(eq(chinchiroTablesTable.guildId, t.guildId), inArray(chinchiroTablesTable.status, OPEN_TABLE_STATUSES), eq(chinchiroTablePlayersTable.userId, interaction.user.id), eq(chinchiroTablePlayersTable.active, 1), sql`${chinchiroTablesTable.id} <> ${id}`)).limit(1);
      if (open) return false;
      const [former] = await tx.select().from(chinchiroTablePlayersTable).where(and(eq(chinchiroTablePlayersTable.tableId, id), eq(chinchiroTablePlayersTable.userId, interaction.user.id)));
      if (former) await tx.update(chinchiroTablePlayersTable).set({ active: 1, displayName, bet: null, roll: null, joinOrder: active.length + 1 }).where(eq(chinchiroTablePlayersTable.id, former.id));
      else await tx.insert(chinchiroTablePlayersTable).values({ tableId: id, userId: interaction.user.id, displayName, joinOrder: active.length + 1 });
      return true;
    });
    if (!joined) { await interaction.reply({ content: "参加できません（定員・状態・他卓への参加を確認してください）。", flags: MessageFlags.Ephemeral }); return; }
    await interaction.deferUpdate(); await redraw(interaction, t); return;
  }
  if (action === "leave") {
    const departure = await closeTableForDeparture(id, interaction.user.id);
    if (!departure.departed) { await interaction.reply({ content: "参加していません。", flags: MessageFlags.Ephemeral }); return; }
    const updated = departure.table;
    await interaction.deferUpdate();
    await redraw(interaction, updated ?? t);
    await interaction.followUp({ content: "退出したためゲームを終了しました。賭け金は返金されました。", flags: MessageFlags.Ephemeral });
    return;
  }
  // 「募集終了」は募集だけを締め切り、卓をBET入力へ進める。
  // 卓そのものを終了する操作は、結果画面の「終了」または管理者の
  // /chinchiro force-end に限定する。
  if ((action === "close" || action === "start") && t.status === "recruiting" &&
    (interaction.user.id === t.ownerId || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild))) {
    const ps = await players(id);
    const members = await Promise.all(ps.map((p) => interaction.guild!.members.fetch(p.userId).catch(() => null)));
    const inVoice = await Promise.all(members.map((member) =>
      isConfiguredChinchiroVoice(t.guildId, member?.voice.channelId ?? null, config.voiceChannelId),
    ));
    if (ps.length < 2 || inVoice.some((ok) => !ok)) { await interaction.reply({ content: "2人以上全員が設定VC、またはそこからVC Hubで転送されたVCにいる必要があります。", flags: MessageFlags.Ephemeral }); return; }
    const parent = ps[Math.floor(Math.random() * ps.length)]!;
    const transitioned = await db.transaction(async (tx) => {
      const conflicts = await tx.select({ userId: chinchiroTablePlayersTable.userId })
        .from(chinchiroTablePlayersTable).innerJoin(chinchiroTablesTable, eq(chinchiroTablePlayersTable.tableId, chinchiroTablesTable.id))
        .where(and(eq(chinchiroTablesTable.guildId, t.guildId), inArray(chinchiroTablesTable.status, ["betting", "rolling"]), eq(chinchiroTablePlayersTable.active, 1), sql`${chinchiroTablesTable.id} <> ${id}`));
      if (conflicts.some((row) => ps.some((p) => p.userId === row.userId))) return null;
      const [updated] = await tx.update(chinchiroTablesTable).set({ status: "betting", parentId: parent.userId, expiresAt: new Date(Date.now() + BET_MS) })
        .where(and(eq(chinchiroTablesTable.id, id), eq(chinchiroTablesTable.status, "recruiting"))).returning();
      return updated ?? null;
    });
    if (!transitioned) { await interaction.reply({ content: "すでに開始済みか、参加者が他の進行中卓にいます。", flags: MessageFlags.Ephemeral }); return; }
    await interaction.deferUpdate(); await redraw(interaction, transitioned); return;
  }
  if (action === "next" && t.status === "finished" && (interaction.user.id === t.ownerId || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild))) {
    const ps = await players(id);
    if (ps.length < 2) { await interaction.reply({ content: "次のラウンドには2人必要です。", flags: MessageFlags.Ephemeral }); return; }
    const parent = ps[Math.floor(Math.random() * ps.length)]!;
    await db.transaction(async (tx) => {
      await tx.update(chinchiroTablePlayersTable).set({ bet: null, roll: null }).where(and(eq(chinchiroTablePlayersTable.tableId, id), eq(chinchiroTablePlayersTable.active, 1)));
      await tx.update(chinchiroTablesTable).set({ status: "betting", round: t.round + 1, parentId: parent.userId, turnUserId: null, results: null, expiresAt: new Date(Date.now() + BET_MS) })
        .where(and(eq(chinchiroTablesTable.id, id), eq(chinchiroTablesTable.status, "finished")));
    });
    const fresh = await table(id); await interaction.deferUpdate(); await redraw(interaction, fresh!); return;
  }
  if (action === "end" && t.status === "finished" && (interaction.user.id === t.ownerId || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild))) {
    const [ended] = await db.update(chinchiroTablesTable).set({ status: "closed", turnUserId: null }).where(eq(chinchiroTablesTable.id, id)).returning();
    await interaction.deferUpdate(); await redraw(interaction, ended!); return;
  }
  if (action === "roll" && t.status === "rolling" && t.turnUserId === interaction.user.id) {
    await interaction.deferUpdate();
    const throwResult = await takeTurnThrow(id, interaction.user.id, {
      expectedAttempt: Number.isSafeInteger(expectedAttempt) ? expectedAttempt : undefined,
    });
    if (!throwResult) {
      await interaction.followUp({
        content: "この投球ボタンは使用済みか、手番が変わりました。",
        ...(interaction.guildId ? { flags: MessageFlags.Ephemeral } : {}),
      });
      return;
    }
    const updated = throwResult.table;
    if (interaction.guild) {
      await redraw(interaction, updated);
    } else {
      await interaction.message.edit({
        content: `${throwResult.outcome.attempts.length}投目: ${dice(throwResult.outcome)} — **${throwResult.outcome.label}**`,
        embeds: [],
        components: [],
      });
    }
    const guild = interaction.guild
      ?? await interaction.client.guilds.fetch(updated.guildId).catch(() => null);
    if (guild && !interaction.guild) await refreshPanelForGuild(guild, updated);
    if (updated.status === "finished" && guild) await sendConfiguredLog(guild, updated, "ラウンド結果確定");
    return;
  }
  if (action === "roll" && t.status === "rolling") {
    await interaction.reply({ content: "現在はあなたの手番ではありません。", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.reply({ content: "この操作は実行できません。", flags: MessageFlags.Ephemeral });
}

export async function handleMultiplayerChinchiroModal(interaction: ModalSubmitInteraction) {
  const id = Number(interaction.customId.split(":")[2]); const t = await table(id);
  if (!t || t.guildId !== interaction.guildId || t.status !== "betting") { await interaction.reply({ content: "賭け金入力の期限が切れています。", flags: MessageFlags.Ephemeral }); return; }
  const config = await settings(t.guildId), bet = Number(interaction.fields.getTextInputValue("bet"));
  if (!Number.isInteger(bet) || bet < config.minBet || bet > config.maxBet) { await interaction.reply({ content: `賭け金は${config.minBet}〜${config.maxBet}の整数にしてください。`, flags: MessageFlags.Ephemeral }); return; }
  const updated = await db.transaction(async (tx) => {
    await lockTable(tx, id);
    const [current] = await tx.select().from(chinchiroTablesTable).where(eq(chinchiroTablesTable.id, id)).for("update");
    if (!current || current.status !== "betting" || current.expiresAt < new Date()) return null;
    const [player] = await tx.update(chinchiroTablePlayersTable).set({ bet }).where(and(eq(chinchiroTablePlayersTable.tableId, id), eq(chinchiroTablePlayersTable.userId, interaction.user.id), eq(chinchiroTablePlayersTable.active, 1))).returning();
    if (!player) return null;
    const active = await tx.select().from(chinchiroTablePlayersTable).where(and(eq(chinchiroTablePlayersTable.tableId, id), eq(chinchiroTablePlayersTable.active, 1))).orderBy(asc(chinchiroTablePlayersTable.joinOrder));
    if (!active.every((p) => p.bet !== null)) return current;
    const [rolling] = await tx.update(chinchiroTablesTable).set({ status: "rolling", turnUserId: rollOrder(current.parentId!, active)[0]!, expiresAt: new Date(Date.now() + TURN_MS) })
      .where(and(eq(chinchiroTablesTable.id, id), eq(chinchiroTablesTable.status, "betting"))).returning();
    return rolling ?? null;
  });
  if (!updated) { await interaction.reply({ content: "賭け金入力の期限が切れています。", flags: MessageFlags.Ephemeral }); return; }
  await interaction.reply({ content: "賭け金を受け付けました。", flags: MessageFlags.Ephemeral });
  await redraw(interaction, updated);
}

/** Called by VoiceStateUpdate. Leaving the configured table VC is a departure. */
export async function handleMultiplayerChinchiroVoiceDeparture(oldState: VoiceState, newState: VoiceState) {
  const userId = oldState.member?.id;
  if (!userId || oldState.channelId === newState.channelId) return;
  const config = await settings(oldState.guild.id);
  if (!await isConfiguredChinchiroVoice(oldState.guild.id, oldState.channelId, config.voiceChannelId)) return;
  const open = await db.select().from(chinchiroTablesTable).where(and(
    eq(chinchiroTablesTable.guildId, oldState.guild.id),
    inArray(chinchiroTablesTable.status, OPEN_TABLE_STATUSES),
  ));
  for (const current of open) {
    const [player] = await db.select().from(chinchiroTablePlayersTable).where(and(eq(chinchiroTablePlayersTable.tableId, current.id), eq(chinchiroTablePlayersTable.userId, userId), eq(chinchiroTablePlayersTable.active, 1)));
    if (!player) continue;
    const departure = await closeTableForDeparture(current.id, userId);
    const updated = departure.table;
    if (!departure.departed) continue;
    if (updated) {
      await refreshPanelForGuild(oldState.guild, updated);
      await sendConfiguredLog(oldState.guild, updated, `${player.displayName} がVCを退出したため終了・賭け金返金`);
    }
  }
}

/** Restart-safe expiry recovery. A rolling timeout takes one throw only. */
export async function recoverExpiredMultiplayerChinchiro(now = new Date(), client?: Client): Promise<number> {
  const expired = await db.select().from(chinchiroTablesTable).where(and(
    inArray(chinchiroTablesTable.status, ["recruiting", "betting", "rolling"]),
    lt(chinchiroTablesTable.expiresAt, now),
  ));
  for (const current of expired) {
    if (current.status !== "rolling" || !current.turnUserId) {
      const [closed] = await db.update(chinchiroTablesTable).set({ status: "closed", turnUserId: null }).where(and(eq(chinchiroTablesTable.id, current.id), eq(chinchiroTablesTable.status, current.status), lt(chinchiroTablesTable.expiresAt, now))).returning();
      if (closed && client) {
        const guild = await client.guilds.fetch(closed.guildId).catch(() => null);
        if (guild) { await refreshPanelForGuild(guild, closed); await sendConfiguredLog(guild, closed, "期限切れで終了"); }
      }
      continue;
    }
    const throwResult = await takeTurnThrow(current.id, current.turnUserId, {
      now,
      allowExpired: true,
    });
    const updated = throwResult?.table;
    if (updated && client) {
      const guild = await client.guilds.fetch(updated.guildId).catch(() => null);
      if (guild) {
        await refreshPanelForGuild(guild, updated);
        if (updated.status === "finished") await sendConfiguredLog(guild, updated, "時間切れ自動ロールで結果確定");
      }
    }
  }
  return expired.length;
}
export function startMultiplayerChinchiroRecovery(client: Client): () => void {
  const timer = setInterval(() => { void recoverExpiredMultiplayerChinchiro(new Date(), client); }, 30_000);
  timer.unref();
  void recoverExpiredMultiplayerChinchiro(new Date(), client);
  return () => clearInterval(timer);
}