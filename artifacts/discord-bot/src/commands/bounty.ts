import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type Client,
  type GuildMember,
  type ModalSubmitInteraction,
  type UserSelectMenuInteraction,
  type ChannelSelectMenuInteraction,
  type RoleSelectMenuInteraction,
  type Guild,
  type GuildTextBasedChannel,
} from "discord.js";
import {
  applyBountyPoints,
  addBountyMonthReviewMember,
  approveBountyMonthReview,
  awardBountyMonth,
  commitBountyMonthReviewImport,
  getBountyMonthReview,
  getBountyPoints,
  getBountySettings,
  listPendingBountyAudits,
  listPendingBountyMonthlyApprovalAudits,
  markBountyAuditSent,
  markBountyMonthlyApprovalAuditSent,
  previewBountyMonthReviewImport,
  removeBountyMonthReviewMember,
  resetBountyVoicePresences,
  setBountyMonthlyApprovalAuditChannel,
  setBountyMonthlyApprovalAuditScanCursor,
  setBountyMonthlyRate,
  setBountySettings,
  setBountyVcRate,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { parseBountyReviewCsv } from "../lib/bountyReviewCsv";
import { createHash, randomUUID } from "node:crypto";

export const BOUNTY_GUILD_ID = "1526418867335725247";
export const BOUNTY_AUDIT_CHANNEL_ID = "1554169897959952454";

const TIERS = [
  { minimum: 500, name: "懸賞金1千万＄" },
  { minimum: 1_000, name: "懸賞金5千万＄" },
  { minimum: 2_500, name: "懸賞金1億＄" },
  { minimum: 5_000, name: "懸賞金5億＄" },
  { minimum: 10_000, name: "懸賞金10億＄" },
] as const;
const USER_PICKER_ID = "bounty:manual:user";
const MANUAL_SIGN_BUTTON_PREFIX = "bounty:manual:sign:";
const VC_PICKER_ID = "bounty:vc:channel";
const MONTHLY_ROLE_PICKER_ID = "bounty:monthly:role";
const MANUAL_MODAL_PREFIX = "bounty:manual:modal:";
const VC_MODAL_PREFIX = "bounty:vc:modal:";
const MONTHLY_MODAL_PREFIX = "bounty:monthly:modal:";
const REVIEW_CONFIRM_PREFIX = "bounty:review:confirm:";
const REVIEW_IMPORT_PREFIX = "bounty:review:import:";
type ReviewImportPreview = Awaited<ReturnType<typeof previewBountyMonthReviewImport>>;
const pendingReviewImports = new Map<string, {
  guildId: string; userId: string; monthKey: string;
  rows: ReturnType<typeof parseBountyReviewCsv>;
  preview: ReviewImportPreview; expiresAt: number; processing: boolean;
}>();

async function loadReviewCsv(attachment: import("discord.js").Attachment): Promise<string> {
  if (!attachment.name?.toLowerCase().endsWith(".csv") || attachment.size > 256 * 1024 || attachment.size === 0) {
    throw new Error("256KB以下の空でない .csv ファイルを添付してください。");
  }
  const url = new URL(attachment.url);
  if (url.protocol !== "https:" || url.hostname !== "cdn.discordapp.com") {
    throw new Error("Discordの添付ファイルのみ利用できます。");
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "error" });
  if (!response.ok || !response.body) throw new Error("CSVを取得できませんでした。再添付してください。");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 256 * 1024) throw new Error("CSVが256KBを超えています。");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

function importDiffFile(preview: ReviewImportPreview): AttachmentBuilder {
  const csv = ["action,user_id,before_role_ids,after_role_ids", ...preview.changes.map((change) =>
    `${change.before ? "update" : "add"},${change.userId},${change.before?.join("|") ?? ""},${change.after.join("|")}`,
  )].join("\n");
  return new AttachmentBuilder(Buffer.from(`\uFEFF${csv}`, "utf8"), { name: "bounty-review-diff.csv" });
}
const REVIEW_MONTH_OPTION = (option: import("discord.js").SlashCommandStringOption) =>
  option.setName("month").setDescription("対象月（例: 2026-09。10月1日付与分）").setRequired(true);
function reviewRosterHash(members: Array<{ userId: string; roleIds: string[] }>): string {
  return createHash("sha256").update(JSON.stringify(
    members.map(({ userId, roleIds }) => ({ userId, roleIds }))
      .sort((a, b) => a.userId.localeCompare(b.userId)),
  )).digest("hex").slice(0, 16);
}

const setupInProgress = new Map<string, Promise<string[]>>();
const completeSetupInProgress = new Map<string, Promise<{
  crewRoleId: string;
  tierRoleIds: string[];
  voiceSeedError?: string;
}>>();

type BountyInteraction = ChatInputCommandInteraction | ButtonInteraction | UserSelectMenuInteraction
  | ChannelSelectMenuInteraction | RoleSelectMenuInteraction | ModalSubmitInteraction;

function isStaff(interaction: { memberPermissions: { has: (permission: bigint) => boolean } | null }): boolean {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
}

function isTargetGuild(interaction: { guildId: string | null }): boolean {
  return interaction.guildId === BOUNTY_GUILD_ID;
}

function privateReply(interaction: BountyInteraction, content: string) {
  const options = { content, allowedMentions: { parse: [] } };
  if (interaction.deferred || interaction.replied) return interaction.editReply(options);
  return interaction.reply({ ...options, ephemeral: true });
}

async function validateStaffInteraction(interaction: BountyInteraction): Promise<boolean> {
  if (!isTargetGuild(interaction)) {
    await privateReply(interaction, `この操作はサーバー ${BOUNTY_GUILD_ID} 専用です。`);
    return false;
  }
  if (!isStaff(interaction)) {
    await privateReply(interaction, "この操作にはサーバー管理権限（ManageGuild）が必要です。");
    return false;
  }
  if (!interaction.guild) {
    await privateReply(interaction, "サーバー情報を取得できません。");
    return false;
  }
  const settings = await getBountySettings(interaction.guildId!);
  if (!settings) {
    await privateReply(interaction, "先に `/bounty setup` を実行してください。");
    return false;
  }
  return true;
}

function tierFor(points: number): number {
  for (let i = TIERS.length - 1; i >= 0; i -= 1) {
    if (points >= TIERS[i].minimum) return i;
  }
  return -1;
}

async function ensureTierRoles(guild: NonNullable<ChatInputCommandInteraction["guild"]>): Promise<string[]> {
  const existingRun = setupInProgress.get(guild.id);
  if (existingRun) return existingRun;
  const run = (async () => {
    const botMember = guild.members.me ?? await guild.members.fetchMe();
    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
      throw new Error("Botにロールの管理権限がありません。");
    }
    const guildRoles = await guild.roles.fetch();
    const roleIds: string[] = [];
    for (const tier of TIERS) {
      const matches = guildRoles.filter((candidate) => candidate.name === tier.name);
      if (matches.size > 1) {
        throw new Error(`「${tier.name}」ロールが複数あります。重複を解消してから再実行してください。`);
      }
      let role = matches.first();
      if (!role) role = await guild.roles.create({ name: tier.name, reason: "賞金ポイント階級の初期設定" });
      if (role.managed || role.position >= botMember.roles.highest.position) {
        throw new Error(`「${tier.name}」ロールはBotのロール階層より上にあるため管理できません。Botのロールを上へ移動してください。`);
      }
      roleIds.push(role.id);
    }
    return roleIds;
  })();
  setupInProgress.set(guild.id, run);
  try {
    return await run;
  } finally {
    setupInProgress.delete(guild.id);
  }
}

async function initializeBountySetup(guild: Guild): Promise<{
  crewRoleId: string;
  tierRoleIds: string[];
  voiceSeedError?: string;
}> {
  const activeSetup = completeSetupInProgress.get(guild.id);
  if (activeSetup) return activeSetup;
  const run = (async () => {
    const existingSettings = await getBountySettings(guild.id);
    const guildRoles = await guild.roles.fetch();
    const crewRoles = guildRoles.filter((role) => role.name === "本船員");
    if (crewRoles.size > 1) {
      throw new Error("「本船員」ロールが複数あります。重複を解消してから再実行してください。");
    }
    const crewRole = crewRoles.first();
    if (!crewRole) throw new Error("「本船員」ロールが見つかりません。先に作成してください。");

    const tierRoleIds = await ensureTierRoles(guild);
    const auditChannel = await guild.channels.fetch(BOUNTY_AUDIT_CHANNEL_ID);
    if (!auditChannel?.isTextBased()) {
      throw new Error(`監査ログチャンネル ${BOUNTY_AUDIT_CHANNEL_ID} が見つかりません。`);
    }
    await setBountySettings(guild.id, crewRole.id, BOUNTY_AUDIT_CHANNEL_ID, tierRoleIds);

    let voiceSeedError: string | undefined;
    if (!existingSettings) {
      try {
        const occupants = new Map<string, { channelId: string; eligible: boolean }>();
        for (const voiceState of guild.voiceStates.cache.values()) {
          if (!voiceState.channelId) continue;
          const member = voiceState.member
            ?? await guild.members.fetch(voiceState.id).catch(() => null);
          if (!member) {
            throw new Error(`接続中メンバー ${voiceState.id} のロールを取得できません。`);
          }
          occupants.set(voiceState.id, {
            channelId: voiceState.channelId,
            eligible: member.roles.cache.has(crewRole.id),
          });
        }
        await resetBountyVoicePresences(guild.id, occupants);
      } catch (error) {
        voiceSeedError = error instanceof Error ? error.message : String(error);
        logger.error("Bounty setup saved but initial voice-presence seeding failed", {
          guildId: guild.id,
          error: voiceSeedError,
        });
      }
    }
    return { crewRoleId: crewRole.id, tierRoleIds, voiceSeedError };
  })();
  completeSetupInProgress.set(guild.id, run);
  try {
    return await run;
  } finally {
    completeSetupInProgress.delete(guild.id);
  }
}

async function sendAudit(guild: NonNullable<ChatInputCommandInteraction["guild"]>, content: string): Promise<void> {
  const channel = await guild.channels.fetch(BOUNTY_AUDIT_CHANNEL_ID);
  if (!channel?.isTextBased() || !("send" in channel)) {
    throw new Error(`監査ログチャンネル ${BOUNTY_AUDIT_CHANNEL_ID} が見つからないか、テキストチャンネルではありません。`);
  }
  await channel.send({ content, allowedMentions: { parse: [] } });
}

const activeAuditFlushes = new Map<string, Promise<number>>();

/** Reconcile an ambiguous Discord send before retrying a queued approval. */
async function approvalAuditAlreadyPosted(
  channel: GuildTextBasedChannel,
  botId: string,
  queuedAt: Date,
  content: string,
  legacyContent: string,
  initialBeforeId: string | null,
  checkpoint: (beforeId: string) => Promise<void>,
): Promise<boolean | "incomplete"> {
  if (!("messages" in channel) || !channel.messages) {
    throw new Error("監査チャンネルの投稿履歴を確認できません。");
  }
  const cutoff = queuedAt.getTime() - 60_000;
  let before: string | undefined = initialBeforeId ?? undefined;
  // Bound each scheduler invocation, not the total search. The cursor survives
  // bot restarts so even very busy channels eventually reach the approval time.
  for (let page = 0; page < 20; page++) {
    const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    for (const message of messages.values()) {
      if (message.createdTimestamp >= cutoff && message.author.id === botId
        && (message.content === content || message.content === legacyContent)) return true;
    }
    const oldest = messages.last();
    if (!oldest || oldest.createdTimestamp < cutoff) return false;
    await checkpoint(oldest.id);
    before = oldest.id;
  }
  return "incomplete";
}

export async function flushPendingBountyAudits(guild: Guild): Promise<number> {
  if (guild.id !== BOUNTY_GUILD_ID) {
    throw new Error(`賞金ポイント監査ログ送信はサーバー ${BOUNTY_GUILD_ID} 専用です。`);
  }
  const active = activeAuditFlushes.get(guild.id);
  if (active) return active;
  const run = flushBountyAuditQueue(guild);
  activeAuditFlushes.set(guild.id, run);
  try {
    return await run;
  } finally {
    activeAuditFlushes.delete(guild.id);
  }
}

async function flushBountyAuditQueue(guild: Guild): Promise<number> {
  // An unconfigured guild with no queued work should not log an error every minute.
  let pending = await listPendingBountyAudits(guild.id, 100);
  let approvals = await listPendingBountyMonthlyApprovalAudits(guild.id, 100);
  if (!pending.length && !approvals.length) return 0;
  const settings = await getBountySettings(guild.id);
  if (!settings) throw new Error("賞金ポイント設定がありません。");
  const channel = await guild.channels.fetch(settings.logChannelId);
  if (!channel?.isTextBased() || !("send" in channel)) {
    throw new Error(`監査ログチャンネル ${settings.logChannelId} が見つからないか、テキストチャンネルではありません。`);
  }
  let sentCount = 0;
  while (pending.length) {
    for (const audit of pending) {
      await channel.send({ content: audit.content, allowedMentions: { parse: [] } });
      await markBountyAuditSent(audit.id);
      sentCount += 1;
    }
    if (pending.length < 100) break;
    pending = await listPendingBountyAudits(guild.id, 100);
  }
  let deferred = false;
  while (approvals.length) {
    for (const approval of approvals) {
      const legacyContent = `懸賞金月次承認 ${approval.monthKey}\n実行者: <@${approval.actorId}>\n月初時点の対象: ${approval.memberCount}人\n※承認記録です。精算結果は別途確認してください。`;
      const content = `${legacyContent}\n監査ID: bounty-approval:${guild.id}:${approval.monthKey}`;
      const botId = guild.client.user?.id;
      if (!botId) throw new Error("BotのIDを取得できないため監査履歴を照合できません。");
      let searchChannelId = approval.channelId;
      let beforeId = approval.scanBeforeId;
      if (!searchChannelId) {
        // A pre-migration pending approval could already have been posted in
        // any former channel. Guessing the current one risks a duplicate.
        throw new Error(`承認月 ${approval.monthKey} の以前の監査チャンネルが不明です。旧投稿を手動確認するまで再送しません。`);
      }
      if (searchChannelId !== settings.logChannelId) {
        // An ambiguous send may already be visible in the former destination.
        // Never send to the new destination until its old history is checked.
        const previousChannel = await guild.channels.fetch(searchChannelId);
        if (previousChannel) {
          if (!previousChannel.isTextBased() || !("messages" in previousChannel)) {
            throw new Error(`以前の監査チャンネル ${searchChannelId} の投稿履歴を確認できません。`);
          }
          const previousFound = await approvalAuditAlreadyPosted(
            previousChannel, botId, approval.queuedAt, content, legacyContent, beforeId,
            (cursor) => setBountyMonthlyApprovalAuditScanCursor(guild.id, approval.monthKey, searchChannelId!, cursor),
          );
          if (previousFound === "incomplete") {
            deferred = true;
            continue;
          }
          if (previousFound) {
            await markBountyMonthlyApprovalAuditSent(guild.id, approval.monthKey);
            sentCount += 1;
            continue;
          }
        }
        // No old message (or the old channel was deleted). Bind the next
        // scan and any subsequent send to the current destination first.
        await setBountyMonthlyApprovalAuditChannel(guild.id, approval.monthKey, searchChannelId, settings.logChannelId);
        searchChannelId = settings.logChannelId;
        beforeId = null;
      }
      const found = await approvalAuditAlreadyPosted(
        channel, botId, approval.queuedAt, content, legacyContent, beforeId,
        (cursor) => setBountyMonthlyApprovalAuditScanCursor(guild.id, approval.monthKey, searchChannelId, cursor),
      );
      if (found === "incomplete") {
        deferred = true;
        continue;
      }
      if (!found) {
        // A failed/ambiguous send must start its next reconciliation at newest,
        // never resume from a cursor that predates the send.
        await setBountyMonthlyApprovalAuditScanCursor(guild.id, approval.monthKey, searchChannelId, null);
        await channel.send({
          content, nonce: `bounty-approval:${approval.monthKey}`, enforceNonce: true,
          allowedMentions: { parse: [] },
        });
      }
      await markBountyMonthlyApprovalAuditSent(guild.id, approval.monthKey);
      sentCount += 1;
    }
    if (approvals.length < 100 || deferred) break;
    approvals = await listPendingBountyMonthlyApprovalAudits(guild.id, 100);
  }
  return sentCount;
}

function manualModal(userId: string, sign: "+" | "-"): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${MANUAL_MODAL_PREFIX}${sign}:${userId}`)
    .setTitle("賞金ポイントを調整")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder()
        .setCustomId("amount").setLabel("ポイント数（正の整数）")
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder()
        .setCustomId("reason").setLabel("理由")
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)),
    );
}

function rateModal(kind: "vc" | "monthly", targetId: string): ModalBuilder {
  const isVc = kind === "vc";
  return new ModalBuilder()
    .setCustomId(`${isVc ? VC_MODAL_PREFIX : MONTHLY_MODAL_PREFIX}${targetId}`)
    .setTitle(isVc ? "VCポイント率を設定" : "月次ポイント率を設定")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder()
      .setCustomId("rate").setLabel(isVc ? "1時間あたりのポイント（0で無効）" : "月次付与ポイント（0で無効）")
      .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(8)));
}

function panelComponents(kind: "manual" | "vc" | "monthly") {
  if (kind === "manual") {
    return [new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
      new UserSelectMenuBuilder().setCustomId(USER_PICKER_ID).setPlaceholder("ポイントを調整するユーザー").setMinValues(1).setMaxValues(1),
    )];
  }
  if (kind === "vc") {
    return [new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      new ChannelSelectMenuBuilder().setCustomId(VC_PICKER_ID).setPlaceholder("対象のボイスチャンネルを選択")
        .setChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice).setMinValues(1).setMaxValues(1),
    )];
  }
  return [new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
    new RoleSelectMenuBuilder().setCustomId(MONTHLY_ROLE_PICKER_ID).setPlaceholder("月次付与対象ロールを選択").setMinValues(1).setMaxValues(1),
  )];
}

export const bountyCommand = {
  data: new SlashCommandBuilder()
    .setName("bounty")
    .setDescription("賞金ポイント")
    .addSubcommand((sub) => sub.setName("setup").setDescription("賞金ポイントの初期設定（管理者）"))
    .addSubcommand((sub) => sub.setName("panels").setDescription("賞金ポイント設定パネルを3つ投稿（管理者）"))
    .addSubcommand((sub) => sub.setName("balance").setDescription("賞金ポイント残高を表示"))
    .addSubcommand((sub) => sub.setName("review-status").setDescription("月次保留・精算状況を確認（管理者）")
      .addStringOption(REVIEW_MONTH_OPTION)
      .addIntegerOption((o) => o.setName("page").setDescription("対象者一覧のページ（1から）").setMinValue(1)))
    .addSubcommand((sub) => sub.setName("review-add").setDescription("月初に対象だったユーザーとロールを登録（管理者）")
      .addStringOption(REVIEW_MONTH_OPTION)
      .addStringOption((o) => o.setName("user_id").setDescription("月初時点の対象ユーザーID").setRequired(true))
      .addStringOption((o) => o.setName("role_id").setDescription("月初時点の付与対象ロールID").setRequired(true)))
    .addSubcommand((sub) => sub.setName("review-import").setDescription("月初の対象者と付与対象ロールをCSVで一括登録（管理者）")
      .addStringOption(REVIEW_MONTH_OPTION)
      .addAttachmentOption((o) => o.setName("file").setDescription("CSV: user_id,role_ids（複数ロールは | 区切り）").setRequired(true)))
    .addSubcommand((sub) => sub.setName("review-remove").setDescription("誤登録した対象ユーザーを削除（管理者）")
      .addStringOption(REVIEW_MONTH_OPTION)
      .addStringOption((o) => o.setName("user_id").setDescription("取り消すユーザーID").setRequired(true)))
    .addSubcommand((sub) => sub.setName("review-confirm").setDescription("確認済みの月次対象者を承認・精算（管理者）")
      .addStringOption(REVIEW_MONTH_OPTION)),
  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild || !interaction.guildId) {
      await privateReply(interaction, "サーバー内で実行してください。");
      return;
    }
    if (!isTargetGuild(interaction)) {
      await privateReply(interaction, `この操作はサーバー ${BOUNTY_GUILD_ID} 専用です。`);
      return;
    }
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "balance") {
      const points = await getBountyPoints(interaction.guildId, interaction.user.id);
      await interaction.reply({
        content: `あなたの賞金ポイント: **${points.toLocaleString("ja-JP")} pt**`,
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (!isStaff(interaction)) {
      await privateReply(interaction, "この操作にはサーバー管理権限（ManageGuild）が必要です。");
      return;
    }
    if (subcommand === "setup") {
      await interaction.deferReply({ ephemeral: true });
      const setup = await initializeBountySetup(interaction.guild);
      if (setup.voiceSeedError) {
        await interaction.editReply({
          content: `賞金ポイント設定は保存されましたが、接続中VCの初期化に失敗しました: ${setup.voiceSeedError}\nBotの状態を確認してください。`,
          allowedMentions: { parse: [] },
        });
        return;
      }
      await interaction.editReply({
        content: `賞金ポイントを設定しました。\n本船員ロールID: ${setup.crewRoleId}\n階級ロール: ${TIERS.map((tier) => `${tier.minimum.toLocaleString()} pt〜 ${tier.name}`).join("\n")}\n監査ログ: ${BOUNTY_AUDIT_CHANNEL_ID}`,
        allowedMentions: { parse: [] },
      });
      return;
    }
    const settings = await getBountySettings(interaction.guildId);
    if (!settings) {
      await privateReply(interaction, "先に `/bounty setup` を実行してください。");
      return;
    }
    if (subcommand.startsWith("review-")) {
      await interaction.deferReply({ ephemeral: true });
      const monthKey = interaction.options.getString("month", true).trim();
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey)) {
        await privateReply(interaction, "対象月は YYYY-MM 形式で入力してください。");
        return;
      }
      const review = await getBountyMonthReview(interaction.guildId, monthKey);
      if (subcommand === "review-status") {
        const status = review.paid ? "精算済み" : review.snapshot?.status === "pending"
          ? "管理者確認待ち" : review.snapshot?.status === "approved"
            ? "承認済み・精算待ち" : review.snapshot?.status === "captured"
              ? "月初スナップショット保存済み" : "対象記録なし";
        const page = interaction.options.getInteger("page") ?? 1;
        const pages = Math.max(1, Math.ceil(review.members.length / 10));
        if (page > pages) {
          await privateReply(interaction, `ページは1〜${pages}で指定してください。`);
          return;
        }
        const roster = review.members.slice((page - 1) * 10, page * 10).map(
          ({ userId, roleIds }) => `${userId}: ${roleIds.filter((id) => id !== settings.crewRoleId).join(", ")}`,
        ).join("\n").slice(0, 1700);
        await privateReply(interaction,
          `${monthKey}: ${status}\n対象: ${review.members.length}人（${page}/${pages}ページ）${roster ? `\n${roster}` : ""}`);
        return;
      }
      if (review.snapshot?.status !== "pending" || review.paid) {
        await privateReply(interaction, "この月は管理者確認待ちではありません。既に精算済みの場合、再登録はできません。");
        return;
      }
      if (subcommand === "review-import") {
        try {
          const rows = parseBountyReviewCsv(await loadReviewCsv(interaction.options.getAttachment("file", true)));
          const preview = await previewBountyMonthReviewImport(interaction.guildId, monthKey, rows);
          for (const [key, pending] of pendingReviewImports) {
            if (pending.expiresAt < Date.now()) pendingReviewImports.delete(key);
          }
          if (pendingReviewImports.size >= 30) throw new Error("確認待ちの一括登録が多すぎます。5分後に再実行してください。");
          const token = randomUUID();
          pendingReviewImports.set(token, {
            guildId: interaction.guildId, userId: interaction.user.id, monthKey,
            rows, preview, expiresAt: Date.now() + 5 * 60_000, processing: false,
          });
          const added = preview.changes.filter((change) => change.before === null).length;
          const updated = preview.changes.length - added;
          const sample = preview.changes.slice(0, 12).map((change) =>
            `${change.before ? "更新" : "追加"} ${change.userId}: ${change.before?.filter((id) => id !== settings.crewRoleId).join("|") || "なし"} → ${change.after.filter((id) => id !== settings.crewRoleId).join("|") || "なし"}`,
          ).join("\n");
          const button = new ButtonBuilder().setStyle(ButtonStyle.Primary)
            .setLabel(`${preview.changes.length}件の変更を登録`)
            .setCustomId(`${REVIEW_IMPORT_PREFIX}${token}`);
          await interaction.editReply({
            content: `${monthKey} CSV確認: ${rows.length}人 / 新規 ${added}人 / 更新 ${updated}人 / 変更なし ${rows.length - preview.changes.length}人\n既存対象者 ${preview.members.length}人は、CSVにない場合も削除しません。ロールはCSV指定で置き換えます。まだ保存していません。\n${sample.slice(0, 1050)}${preview.changes.length > 12 ? "\n（全差分は添付CSVを確認）" : ""}\n5分以内に本人が確定してください。`,
            files: [importDiffFile(preview)],
            components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)],
            allowedMentions: { parse: [] },
          });
        } catch (error) {
          await privateReply(interaction, error instanceof Error ? error.message : "CSVの確認に失敗しました。");
        }
        return;
      }
      if (subcommand === "review-add" || subcommand === "review-remove") {
        const userId = interaction.options.getString("user_id", true).trim();
        if (!/^\d{17,20}$/.test(userId)) {
          await privateReply(interaction, "ユーザーIDはDiscordの数値IDを入力してください。");
          return;
        }
        if (subcommand === "review-add") {
          const roleId = interaction.options.getString("role_id", true).trim();
          if (!/^\d{17,20}$/.test(roleId)) {
            await privateReply(interaction, "ロールIDはDiscordの数値IDを入力してください。");
            return;
          }
          await addBountyMonthReviewMember(interaction.guildId, monthKey, userId, roleId);
          await privateReply(interaction, `${monthKey} の対象者 ${userId} に月初時点の付与対象ロール ${roleId} を登録しました。複数ロールは繰り返し登録してください。まだ精算されていません。`);
        } else {
          await removeBountyMonthReviewMember(interaction.guildId, monthKey, userId);
          await privateReply(interaction, `${monthKey} の対象者 ${userId} の登録を取り消しました。`);
        }
        return;
      }
      const button = new ButtonBuilder().setStyle(ButtonStyle.Danger)
        .setLabel(`${review.members.length}人を承認して精算`)
        .setCustomId(`${REVIEW_CONFIRM_PREFIX}${monthKey}:${interaction.user.id}:${reviewRosterHash(review.members)}`);
      await interaction.editReply({
        content: `${monthKey} の月初時点の対象者 ${review.members.length} 人を承認し、月次ポイントを確定します。空の一覧でも「対象者なし」として処理済みになります。月初当時の本船員ロールと付与対象ロールを確認しましたか？`,
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)],
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (subcommand === "panels") {
      await interaction.deferReply({ ephemeral: true });
      const target = interaction.channel;
      if (!target?.isTextBased() || !("send" in target)) {
        await interaction.editReply("このチャンネルにはパネルを投稿できません。");
        return;
      }
      const panels = [
        ["🧾 賞金ポイント手動調整", "ユーザーを選択して、スタッフがポイントを加算・減算します。", "manual"],
        ["🎙️ VCポイント設定", "VCを選択し、1時間あたりの付与ポイントを設定します。0で無効になります。", "vc"],
        ["📅 月次ポイント設定", "対象ロールを選択し、月次付与ポイントを設定します。", "monthly"],
      ] as const;
      for (const [title, description, kind] of panels) {
        await target.send({
          embeds: [new EmbedBuilder().setColor(0xf1c40f).setTitle(title).setDescription(description)],
          components: panelComponents(kind),
          allowedMentions: { parse: [] },
        });
      }
      await interaction.editReply("3つの公開パネルを投稿しました。操作できるのはスタッフのみです。");
      return;
    }
  },
};

/** Update only this guild's bounty command; never replace the full command list. */
export async function syncBountyCommandRegistration(client: Client): Promise<void> {
  const guild = client.guilds.cache.get(BOUNTY_GUILD_ID)
    ?? await client.guilds.fetch(BOUNTY_GUILD_ID);
  const existing = (await guild.commands.fetch())
    .find((command) => command.name === bountyCommand.data.name);
  const definition = bountyCommand.data.toJSON();
  if (existing) {
    await guild.commands.edit(existing.id, definition);
  } else {
    await guild.commands.create(definition);
  }
  logger.info(`[bounty] Guild command synchronized guild=${guild.id}`);
}

export async function handleBountyUserSelect(interaction: UserSelectMenuInteraction): Promise<boolean> {
  if (interaction.customId !== USER_PICKER_ID) return false;
  if (!await validateStaffInteraction(interaction)) return true;
  const userId = interaction.users.first()?.id;
  if (!userId) {
    await privateReply(interaction, "対象ユーザーを選択してください。");
    return true;
  }
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${MANUAL_SIGN_BUTTON_PREFIX}+:${userId}`).setLabel("+ 加算").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${MANUAL_SIGN_BUTTON_PREFIX}-:${userId}`).setLabel("− 減算").setStyle(ButtonStyle.Danger),
  );
  await interaction.reply({
    content: `対象: <@${userId}>\n次に加算または減算を選択してください。選択後、正のポイント数を入力します。`,
    components: [row],
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
  return true;
}

export async function handleBountyButton(interaction: ButtonInteraction): Promise<boolean> {
  if (interaction.customId.startsWith(REVIEW_IMPORT_PREFIX)) {
    if (!await validateStaffInteraction(interaction)) return true;
    const token = interaction.customId.slice(REVIEW_IMPORT_PREFIX.length);
    const pending = pendingReviewImports.get(token);
    if (!pending || pending.expiresAt < Date.now()) {
      pendingReviewImports.delete(token);
      await privateReply(interaction, "一括登録の確認期限が切れました。CSVを再添付してください。");
      return true;
    }
    if (pending.guildId !== interaction.guildId || pending.userId !== interaction.user.id) {
      await privateReply(interaction, "CSVを確認した管理者本人のみ登録できます。");
      return true;
    }
    if (pending.processing) {
      await privateReply(interaction, "登録処理中です。完了をお待ちください。");
      return true;
    }
    pending.processing = true;
    await interaction.deferUpdate();
    try {
      await commitBountyMonthReviewImport(
        pending.guildId, pending.monthKey, pending.rows, pending.preview,
      );
      pendingReviewImports.delete(token);
      await interaction.editReply({
        content: `${pending.monthKey} の対象者を一括登録しました（変更 ${pending.preview.changes.length}人）。精算はまだ行っていません。確認後に \`/bounty review-confirm\` を実行してください。`,
        components: [], files: [], allowedMentions: { parse: [] },
      });
    } catch (error) {
      pendingReviewImports.delete(token);
      logger.error("[bounty] Monthly review CSV import failed", error);
      await interaction.editReply({
        content: `一括登録を保存できませんでした。変更は反映されていません。${error instanceof Error ? error.message : "CSVを再確認してください。"}`,
        components: [], files: [], allowedMentions: { parse: [] },
      });
    }
    return true;
  }
  if (interaction.customId.startsWith(REVIEW_CONFIRM_PREFIX)) {
    if (!await validateStaffInteraction(interaction)) return true;
    const match = /^(\d{4}-(?:0[1-9]|1[0-2])):(\d{17,20}):([a-f0-9]{16})$/
      .exec(interaction.customId.slice(REVIEW_CONFIRM_PREFIX.length));
    if (!match || match[2] !== interaction.user.id) {
      await privateReply(interaction, "確認した管理者本人のみ実行できます。");
      return true;
    }
    await interaction.deferReply({ ephemeral: true });
    const review = await getBountyMonthReview(interaction.guildId!, match[1]);
    if (review.snapshot?.status !== "pending" || review.paid) {
      await privateReply(interaction, "この月は既に承認または精算されています。");
      return true;
    }
    if (reviewRosterHash(review.members) !== match[3]) {
      await privateReply(interaction, "確認画面の表示後に対象者が変更されました。`/bounty review-status` を確認し直してください。");
      return true;
    }
    await approveBountyMonthReview(interaction.guildId!, match[1], interaction.user.id, review.members);
    try {
      const awards = await awardBountyMonth(interaction.guildId!, match[1]);
      let roleFailures = 0;
      for (const award of awards) {
        try {
          const member = await interaction.guild!.members.fetch(award.userId);
          await syncBountyTierRole(member, award.after);
        } catch (error) {
          roleFailures++;
          logger.error(`[bounty] Reviewed monthly tier sync failed user=${award.userId}`, error);
        }
      }
      let auditPending = false;
      try {
        await flushPendingBountyAudits(interaction.guild!);
      } catch (error) {
        auditPending = true;
        logger.error("[bounty] Monthly approval audit queued; delivery will retry", error);
      }
      await privateReply(interaction, `${match[1]} の月次精算が完了しました（付与 ${awards.length} 人）。${auditPending ? "承認の監査通知は送信待ちです。定期処理で再試行します。" : ""}${roleFailures ? `ロール同期失敗 ${roleFailures} 人は定期処理で再試行されます。` : ""}`);
    } catch (error) {
      logger.error(`[bounty] Monthly review approved but payout failed month=${match[1]}`, error);
      await privateReply(interaction, "承認を保存しましたが精算できませんでした。再実行せず、Botのエラーログを確認してください。定期処理が再試行します。");
    }
    return true;
  }
  if (!interaction.customId.startsWith(MANUAL_SIGN_BUTTON_PREFIX)) return false;
  if (!await validateStaffInteraction(interaction)) return true;
  const selection = interaction.customId.slice(MANUAL_SIGN_BUTTON_PREFIX.length);
  const match = /^([+-]):(\d{17,20})$/.exec(selection);
  if (!match) {
    await privateReply(interaction, "調整ボタンの情報が不正です。パネルから選び直してください。");
    return true;
  }
  await interaction.showModal(manualModal(match[2], match[1] as "+" | "-"));
  return true;
}

export async function handleBountyChannelSelect(interaction: ChannelSelectMenuInteraction): Promise<boolean> {
  if (interaction.customId !== VC_PICKER_ID) return false;
  if (!await validateStaffInteraction(interaction)) return true;
  await interaction.showModal(rateModal("vc", interaction.values[0]));
  return true;
}

export async function handleBountyRoleSelect(interaction: RoleSelectMenuInteraction): Promise<boolean> {
  if (interaction.customId !== MONTHLY_ROLE_PICKER_ID) return false;
  if (!await validateStaffInteraction(interaction)) return true;
  await interaction.showModal(rateModal("monthly", interaction.values[0]));
  return true;
}

async function replyAfterMutationAudit(
  interaction: ModalSubmitInteraction,
  auditText: string,
  successText: string,
  auditFailureText: string,
): Promise<void> {
  try {
    await sendAudit(interaction.guild!, auditText);
  } catch (error) {
    logger.error("Bounty mutation succeeded but its audit message failed", {
      guildId: interaction.guildId,
      actorId: interaction.user.id,
      error: error instanceof Error ? error.message : String(error),
    });
    await privateReply(interaction, auditFailureText);
    return;
  }
  await privateReply(interaction, successText);
}

export async function handleBountyModalSubmit(interaction: ModalSubmitInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith(MANUAL_MODAL_PREFIX)
    && !interaction.customId.startsWith(VC_MODAL_PREFIX)
    && !interaction.customId.startsWith(MONTHLY_MODAL_PREFIX)) return false;
  if (!await validateStaffInteraction(interaction)) return true;
  await interaction.deferReply({ ephemeral: true });
  if (interaction.customId.startsWith(MANUAL_MODAL_PREFIX)) {
    const selection = interaction.customId.slice(MANUAL_MODAL_PREFIX.length);
    const match = /^([+-]):(\d{17,20})$/.exec(selection);
    if (!match) {
      await privateReply(interaction, "調整フォームの情報が不正です。パネルから選び直してください。");
      return true;
    }
    const sign = match[1] as "+" | "-";
    const userId = match[2];
    const amountText = interaction.fields.getTextInputValue("amount").trim();
    const reason = interaction.fields.getTextInputValue("reason").trim();
    if (!/^\d+$/.test(amountText)) {
      await privateReply(interaction, "ポイント数には正の整数のみ入力してください。");
      return true;
    }
    const amount = Number(amountText);
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 2_147_483_647 || !reason) {
      await privateReply(interaction, "ポイント数には1以上の整数、理由には内容を入力してください。");
      return true;
    }
    const settings = await getBountySettings(interaction.guildId!);
    if (!settings) {
      await privateReply(interaction, "先に `/bounty setup` を実行してください。");
      return true;
    }
    const member = await interaction.guild!.members.fetch(userId).catch(() => null);
    if (!member || !member.roles.cache.has(settings.crewRoleId)) {
      await privateReply(interaction, "賞金ポイントを受け取れるのは「本船員」ロールのメンバーのみです。");
      return true;
    }
    const delta = sign === "+" ? amount : -amount;
    const currentPoints = await getBountyPoints(interaction.guildId!, userId);
    if (currentPoints + delta < 0) {
      await privateReply(interaction, "ポイント残高が0未満になる調整はできません。");
      return true;
    }
    let result: Awaited<ReturnType<typeof applyBountyPoints>>;
    try {
      result = await applyBountyPoints(interaction.guildId!, userId, delta, reason, interaction.user.id, interaction.id);
    } catch (error) {
      const latestPoints = await getBountyPoints(interaction.guildId!, userId);
      if (latestPoints + delta < 0) {
        await privateReply(interaction, "同時更新後の残高が不足しているため、調整できませんでした。");
        return true;
      }
      throw error;
    }
    if (!result.applied) {
      await privateReply(interaction, "この調整はすでに処理されています。");
      return true;
    }
    const signText = sign === "+" ? "+" : "−";
    try {
      await flushPendingBountyAudits(interaction.guild!);
      await privateReply(interaction, `ポイントを変更しました（${result.before} → ${result.after}）。`);
    } catch (error) {
      logger.error("Bounty points changed but the audit outbox could not be flushed", {
        guildId: interaction.guildId,
        actorId: interaction.user.id,
        targetId: userId,
        error: error instanceof Error ? error.message : String(error),
      });
      await privateReply(interaction, `ポイント変更は完了しました（${result.before} → ${result.after}）が、監査ログ送信に失敗しました。ログは再試行待ちです。再調整せず、管理者へ連絡してください。`);
    }
    return true;
  }

  if (interaction.customId.startsWith(VC_MODAL_PREFIX)) {
    const channelId = interaction.customId.slice(VC_MODAL_PREFIX.length);
    const rateText = interaction.fields.getTextInputValue("rate").trim();
    if (!/^\d+$/.test(rateText)) {
      await privateReply(interaction, "ポイント率は0以上の整数で入力してください。");
      return true;
    }
    const rate = Number(rateText);
    if (!Number.isSafeInteger(rate) || rate > 2_147_483_647) {
      await privateReply(interaction, "ポイント率が有効範囲を超えています。");
      return true;
    }
    const accrued = await setBountyVcRate(interaction.guildId!, channelId, rate);
    let roleSyncFailed = false;
    for (const item of accrued) {
      try {
        const member = await interaction.guild!.members.fetch(item.userId);
        await syncBountyTierRole(member, item.after);
      } catch (error) {
        roleSyncFailed = true;
        logger.error("Bounty tier role sync failed after VC-rate accrual", {
          guildId: interaction.guildId,
          userId: item.userId,
          points: item.after,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const rateMessage = `VCポイント率を ${rate} pt/時間に設定しました。`;
    const roleSyncWarning = roleSyncFailed
      ? " 階級ロール同期に失敗した対象があります。メインスケジューラーが後で再同期します。"
      : "";
    await replyAfterMutationAudit(
      interaction,
      `賞金ポイントVC設定\n実行者: <@${interaction.user.id}>\nVC: <#${channelId}>\n率: ${rate} pt/時間${rate === 0 ? "（無効）" : ""}`,
      `${rateMessage}${roleSyncWarning}`,
      `VCポイント率の設定（${rate} pt/時間）は完了しましたが、監査ログ送信に失敗しました。再実行せず、管理者へ連絡してください。${roleSyncWarning}`,
    );
    return true;
  }

  const roleId = interaction.customId.slice(MONTHLY_MODAL_PREFIX.length);
  const rateText = interaction.fields.getTextInputValue("rate").trim();
  if (!/^\d+$/.test(rateText)) {
    await privateReply(interaction, "月次付与ポイントは0以上の整数で入力してください。");
    return true;
  }
  const rate = Number(rateText);
  if (!Number.isSafeInteger(rate) || rate > 2_147_483_647) {
    await privateReply(interaction, "月次付与ポイントが有効範囲を超えています。");
    return true;
  }
  await setBountyMonthlyRate(interaction.guildId!, roleId, rate);
  await replyAfterMutationAudit(
    interaction,
    `賞金ポイント月次設定\n実行者: <@${interaction.user.id}>\n対象ロール: <@&${roleId}>\n付与ポイント: ${rate} pt${rate === 0 ? "（無効）" : ""}`,
    `月次付与を ${rate} pt に設定しました。`,
    `月次付与設定（${rate} pt）は完了しましたが、監査ログ送信に失敗しました。再実行せず、管理者へ連絡してください。`,
  );
  return true;
}

export async function syncBountyTierRole(member: GuildMember, points?: number): Promise<void> {
  if (member.guild.id !== BOUNTY_GUILD_ID) {
    throw new Error(`賞金ポイント階級同期はサーバー ${BOUNTY_GUILD_ID} 専用です。`);
  }
  const settings = await getBountySettings(member.guild.id);
  if (!settings) throw new Error("賞金ポイント設定がありません。");
  const configuredTierIds = settings.tierRoleIds;
  if (configuredTierIds.length !== TIERS.length) {
    throw new Error(`賞金階級ロールは${TIERS.length}件必要ですが、${configuredTierIds.length}件だけ設定されています。`);
  }
  const crewRolePresent = member.roles.cache.has(settings.crewRoleId);
  const currentPoints = points ?? await getBountyPoints(member.guild.id, member.id);
  const targetIndex = crewRolePresent ? tierFor(currentPoints) : -1;
  const targetRoleId = targetIndex >= 0 ? configuredTierIds[targetIndex] : undefined;
  const botMember = member.guild.members.me ?? await member.guild.members.fetchMe();
  for (const roleId of configuredTierIds) {
    const role = member.guild.roles.cache.get(roleId);
    if (!role) throw new Error(`賞金階級ロール ${roleId} が見つかりません。`);
    if (role.managed || role.position >= botMember.roles.highest.position) {
      throw new Error(`賞金階級ロール ${role.name} はBotのロール階層より上にあります。`);
    }
    if (roleId === targetRoleId) {
      if (!member.roles.cache.has(roleId)) await member.roles.add(roleId, "賞金ポイント階級を同期");
    } else if (member.roles.cache.has(roleId)) {
      await member.roles.remove(roleId, "賞金ポイント階級を同期");
    }
  }
}

export const bountyInteractionHandlers = {
  handleBountyUserSelect,
  handleBountyButton,
  handleBountyChannelSelect,
  handleBountyRoleSelect,
  handleBountyModalSubmit,
};

export default bountyCommand;