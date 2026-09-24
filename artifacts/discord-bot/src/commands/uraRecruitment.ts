import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type ApplicationCommandManager,
  type GuildApplicationCommandManager,
  type ModalSubmitInteraction,
} from "discord.js";
import {
  URA_SLEEP,
  URA_TALK,
  addUraBlock,
  cancelUraRecruitment,
  createUraApplication,
  createUraMatch,
  createPaidUraRecruitment,
  cancelAndRefundUraRecruitment,
  URA_RECRUITMENT_FEE,
  dismissUraApplication,
  abortUraRecruitment,
  finishUraMatch,
  getActiveUraMatchForUser,
  getOpenUraRecruitmentByOwner,
  getUraApplication,
  getUraApplicationById,
  getUraMatchById,
  getUraRecruitmentById,
  getUraRecruitmentSettings,
  isUraBlocked,
  listOpenUraRecruitments,
  listUraApplications,
  listUraBlocks,
  listUraMatchesReadyForDeletion,
  markUraRecruitmentMatched,
  removeUraBlock,
  setUraRecruitmentMessage,
  setUraRecruitmentSettings,
  type UraRecruitmentType,
} from "@workspace/db";
import { logger } from "../lib/logger";

export const URA_PREFIX = "ura:";
const CREATE_MODAL_PREFIX = `${URA_PREFIX}create:`;
const APPLY_MODAL_PREFIX = `${URA_PREFIX}apply:`;
const lastUraActions = new Map<string, number>();
const syncedOpenRecruitmentGuilds = new Set<string>();

const typeLabel = (type: string) => type === URA_TALK ? "🎙️ 個通募集" : "🌙 寝落ち募集";
const typeEmoji = (type: string) => type === URA_TALK ? "🎙️" : "🌙";

function formatJstDate(date: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function adminOnly(interaction: ChatInputCommandInteraction): boolean {
  return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

function isUraRateLimited(userId: string, action: "create" | "apply", windowMs: number) {
  const key = `${action}:${userId}`;
  const now = Date.now();
  const previous = lastUraActions.get(key) ?? 0;
  if (now - previous < windowMs) return true;
  lastUraActions.set(key, now);
  return false;
}

function recruitmentCard(recruitment: {
  id: number;
  type: string;
  ownerId: string;
  note: string;
  status: string;
  createdAt: Date;
}, profile?: { name: string; avatarURL: string }) {
  const isOpen = recruitment.status === "open";
  const embed = new EmbedBuilder()
    .setColor(isOpen ? 0x8b5cf6 : 0x6b7280)
    .setTitle(`裏航海｜${isOpen ? typeLabel(recruitment.type) : "🔒 募集終了"} #${recruitment.id}`)
    .addFields(
      { name: "募集者", value: `<@${recruitment.ownerId}>`, inline: true },
      { name: "一言", value: recruitment.note.slice(0, 1024) || "（なし）", inline: false },
      { name: "募集開始", value: formatJstDate(recruitment.createdAt), inline: false },
    )
    .setFooter({ text: isOpen ? "申請内容は募集者だけが確認できます" : "この募集は終了しています" });
  if (profile) {
    embed
      .setAuthor({ name: profile.name, iconURL: profile.avatarURL })
      .setThumbnail(profile.avatarURL);
  }
  return embed;
}

function panelComponents() {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`${URA_PREFIX}panel:create:${URA_TALK}`).setLabel("🎙️ 個通募集").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${URA_PREFIX}panel:create:${URA_SLEEP}`).setLabel("🌙 寝落ち募集").setStyle(ButtonStyle.Primary),
    ),
  ];
}

const panelEmbed = () => new EmbedBuilder()
  .setColor(0x8b5cf6)
  .setTitle("裏航海")
  .setDescription("個通または寝落ちの募集を開始できます。\n募集開始時に30,000引き落とします。専用VCは作成から24時間で削除されます。");

export async function syncUraCommandRegistration(client: Client) {
  if (!client.application) return;
  async function sync(manager: ApplicationCommandManager | GuildApplicationCommandManager, scope: string) {
    const registered = await manager.fetch({});
    const old = registered.find((command) => command.name === "ura");
    const current = registered.find((command) => command.name === "裏航海");
    const data = uraRecruitmentCommand.data.toJSON();
    if (current) {
      await manager.edit(current.id, data);
      if (old) await manager.delete(old.id);
    } else if (old) {
      await manager.edit(old.id, data);
    } else {
      await manager.create(data);
    }
    logger.info(`[ura] 裏航海 command synchronized (${scope})`);
  }
  await sync(client.application.commands, "global").catch((error) => logger.error("[ura] global command sync failed", error));
  for (const guild of client.guilds.cache.values()) {
    await sync(guild.commands, guild.id)
      .catch((error) => logger.error(`[ura] guild command sync failed ${guild.id}`, error));
  }
}

async function refreshExistingUraPanel(guild: Guild) {
  const channel = await configuredPanelChannel(guild);
  if (!channel || channel.type !== ChannelType.GuildText) return;
  let before: string | undefined;
  while (true) {
    const messages = await channel.messages.fetch({ limit: 100, before });
    const panel = messages.find((message) =>
      message.author.id === guild.client.user?.id
      && ["裏募集パネル", "裏航海パネル", "裏航海"].includes(message.embeds[0]?.title ?? ""),
    );
    if (panel) {
      await panel.edit({ embeds: [panelEmbed()], components: panelComponents() });
      return;
    }
    if (messages.size < 100) return;
    before = messages.lastKey();
    if (!before) return;
  }
}

function recruitmentComponents(id: number, open: boolean) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${URA_PREFIX}recruitment:apply:${id}`)
        .setLabel("📨 申請する")
        .setStyle(ButtonStyle.Success)
        .setDisabled(!open),
    ),
  ];
}

function recruitmentCancelComponents(id: number, disabled = false) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${URA_PREFIX}recruitment:cancel:${id}`)
        .setLabel("❌ 募集終了")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
    ),
  ];
}

function noteModal(customId: string, title: string, inputId: string, label: string) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(inputId)
          .setLabel(label)
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(1000)
          .setPlaceholder("一言を入力してください"),
      ),
    );
}

async function configuredRecruitmentChannel(guild: Guild) {
  const settings = await getUraRecruitmentSettings(guild.id);
  if (!settings.recruitmentChannelId) return null;
  const channel = await guild.channels.fetch(settings.recruitmentChannelId).catch(() => null);
  return channel?.isTextBased() && !channel.isDMBased() ? channel : null;
}

async function configuredPanelChannel(guild: Guild) {
  const settings = await getUraRecruitmentSettings(guild.id);
  if (!settings.panelChannelId) return null;
  const channel = await guild.channels.fetch(settings.panelChannelId).catch(() => null);
  return channel?.isTextBased() && !channel.isDMBased() ? channel : null;
}

async function getGuildProfile(guild: Guild, userId: string) {
  const member = await guild.members.fetch(userId).catch(() => null);
  const user = member?.user ?? await guild.client.users.fetch(userId).catch(() => null);
  if (!user) return null;
  return {
    name: member?.displayName ?? user.username,
    avatarURL: member?.displayAvatarURL({ size: 256 }) ?? user.displayAvatarURL({ size: 256 }),
  };
}

async function postRecruitmentCard(guild: Guild, recruitment: NonNullable<Awaited<ReturnType<typeof getUraRecruitmentById>>>) {
  const channel = await configuredRecruitmentChannel(guild);
  if (!channel) throw new Error("裏航海チャンネルが設定されていないか、見つかりません。");
  const profile = await getGuildProfile(guild, recruitment.ownerId);
  const message = await channel.send({
    embeds: [recruitmentCard(recruitment, profile ?? undefined)],
    components: recruitmentComponents(recruitment.id, true),
    allowedMentions: { users: [] },
  });
  try {
    await setUraRecruitmentMessage(recruitment.id, message.id);
  } catch (error) {
    await message.delete().catch((deleteError) => logger.error("[ura] failed to remove unrecorded recruitment card", deleteError));
    throw error;
  }
  return message;
}

async function refreshRecruitmentMessage(guild: Guild, recruitmentId: number) {
  const recruitment = await getUraRecruitmentById(recruitmentId);
  if (!recruitment?.messageId) return;
  const channel = await guild.channels.fetch(recruitment.recruitmentChannelId).catch(() => null);
  if (!channel?.isTextBased() || channel.isDMBased()) return;
  const message = await channel.messages.fetch(recruitment.messageId).catch(() => null);
  if (!message) return;
  const profile = await getGuildProfile(guild, recruitment.ownerId);
  await message.edit({
    embeds: [recruitmentCard(recruitment, profile ?? undefined)],
    components: recruitmentComponents(recruitment.id, recruitment.status === "open"),
  }).catch((error) => logger.warn("[ura] failed to refresh recruitment card", error));
}

async function deleteRecruitmentMessage(guild: Guild, recruitmentId: number) {
  const recruitment = await getUraRecruitmentById(recruitmentId);
  if (!recruitment?.messageId) return;
  const channel = await guild.channels.fetch(recruitment.recruitmentChannelId).catch(() => null);
  if (!channel?.isTextBased() || channel.isDMBased()) return;
  const message = await channel.messages.fetch(recruitment.messageId).catch(() => null);
  if (!message) return;
  await message.delete().catch((error) => logger.warn("[ura] failed to delete recruitment card", error));
}

async function sendApplicationNotice(guild: Guild, recruitmentId: number, applicationId: number) {
  const recruitment = await getUraRecruitmentById(recruitmentId);
  const application = await getUraApplicationById(applicationId);
  if (!recruitment || !application) return false;
  const owner = await guild.client.users.fetch(recruitment.ownerId).catch(() => null);
  const applicant = await guild.client.users.fetch(application.applicantId).catch(() => null);
  if (!owner || !applicant) return false;
  const applicantMember = await guild.members.fetch(application.applicantId).catch(() => null);
  const embed = new EmbedBuilder()
    .setColor(0x22c55e)
    .setTitle("📨 申請が届きました")
    .setDescription(`募集 **#${recruitment.id}**（${typeLabel(recruitment.type)}）への申請です。`)
    .setAuthor({
      name: applicantMember?.displayName ?? applicant.username,
      iconURL: applicantMember?.displayAvatarURL({ size: 256 }) ?? applicant.displayAvatarURL({ size: 256 }),
    })
    .addFields(
      { name: "申請者", value: `<@${applicant.id}>`, inline: true },
      { name: "一言", value: application.note.slice(0, 1024) || "（なし）" },
      { name: "募集開始", value: formatJstDate(recruitment.createdAt), inline: false },
    )
    .setFooter({ text: "この情報は募集者だけに表示されています" });
  await owner.send({
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`${URA_PREFIX}application:select:${recruitment.id}:${application.id}`).setLabel("この人を選ぶ").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`${URA_PREFIX}application:dismiss:${recruitment.id}:${application.id}`).setLabel("見送る").setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
  return true;
}

async function notifyApplicants(guild: Guild, recruitmentId: number, selectedApplicantId?: string) {
  const applications = await listUraApplications(recruitmentId);
  for (const application of applications) {
    if (application.applicantId === selectedApplicantId) continue;
    const user = await guild.client.users.fetch(application.applicantId).catch(() => null);
    if (!user) continue;
    await user.send("この募集は終了しました。また別の募集をご利用ください。").catch(() => undefined);
  }
}

async function createPrivateMatchChannel(guild: Guild, recruitmentId: number, hostId: string, guestId: string) {
  const settings = await getUraRecruitmentSettings(guild.id);
  if (!settings.vcCategoryId) throw new Error("専用VCカテゴリが設定されていません。管理者に連絡してください。");
  const category = await guild.channels.fetch(settings.vcCategoryId).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory) throw new Error("専用VCカテゴリが見つかりません。");
  const recruitment = await getUraRecruitmentById(recruitmentId);
  if (!recruitment) throw new Error("募集が見つかりません。");
  const channel = await guild.channels.create({
    name: `${typeEmoji(recruitment.type)}｜裏航海-${String(recruitmentId).padStart(3, "0")}`,
    type: ChannelType.GuildVoice,
    parent: category.id,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] },
      { id: hostId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] },
      { id: guestId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] },
      ...(guild.client.user ? [{ id: guild.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers] }] : []),
    ],
  });
  return channel;
}

async function sendMatchNotice(guild: Guild, matchId: number, userId: string, otherId: string, channelId: string, text: string) {
  const user = await guild.client.users.fetch(userId).catch(() => null);
  if (!user) return;
  await user.send({
    content: text,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`${URA_PREFIX}match:block:${matchId}`).setLabel("🚫 ブロック").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`${URA_PREFIX}match:delete:${matchId}`).setLabel("🗑️ VCを削除").setStyle(ButtonStyle.Danger),
      ),
    ],
    allowedMentions: { users: [] },
  }).catch(() => undefined);
  void otherId;
  void channelId;
}

async function handleCreateSubmit(interaction: ModalSubmitInteraction, type: UraRecruitmentType) {
  if (!interaction.guild) return interaction.reply({ content: "サーバー内でのみ使用できます。", ephemeral: true });
  const settings = await getUraRecruitmentSettings(interaction.guild.id);
  if (!settings.enabled) return interaction.reply({ content: "裏航海は現在停止中です。", ephemeral: true });
  if (!settings.recruitmentChannelId) return interaction.reply({ content: "募集チャンネルが設定されていません。", ephemeral: true });
  if (isUraRateLimited(interaction.user.id, "create", 30_000)) {
    return interaction.reply({ content: "募集操作が早すぎます。少し待ってから再度お試しください。", ephemeral: true });
  }
  if (await getActiveUraMatchForUser(interaction.guild.id, interaction.user.id)) {
    return interaction.reply({ content: "現在マッチ中のため、新しい募集は作成できません。", ephemeral: true });
  }
  if (await getOpenUraRecruitmentByOwner(interaction.guild.id, interaction.user.id)) {
    return interaction.reply({ content: "既に募集中です。先に現在の募集を終了してください。", ephemeral: true });
  }
  const note = interaction.fields.getTextInputValue("note").trim() || "（なし）";
  await interaction.deferReply({ ephemeral: true });
  const result = await createPaidUraRecruitment({
    guildId: interaction.guild.id,
    recruitmentChannelId: settings.recruitmentChannelId,
    ownerId: interaction.user.id,
    type,
    note,
  });
  if (result.status === "already_open") return interaction.editReply("既に募集中です。先に現在の募集を終了してください。");
  if (result.status === "insufficient") return interaction.editReply(`残高が不足しています。募集には${URA_RECRUITMENT_FEE.toLocaleString()}必要です。`);
  const recruitment = result.recruitment;
  try {
    await postRecruitmentCard(interaction.guild, recruitment);
  } catch (error) {
    await cancelAndRefundUraRecruitment(recruitment.id);
    logger.error("[ura] failed to post recruitment card", error);
    return interaction.editReply("募集カードの投稿に失敗したため、30,000を返金しました。設定を確認してください。");
  }
  return interaction.editReply({
    content: "裏航海の募集を開始し、30,000を引き落としました。募集チャンネルを確認してください。\n募集終了ボタンは募集者本人にだけ表示されています。",
    components: recruitmentCancelComponents(recruitment.id),
  });
}

async function handleApplySubmit(interaction: ModalSubmitInteraction, recruitmentId: number) {
  if (!interaction.guild) return interaction.reply({ content: "サーバー内でのみ使用できます。", ephemeral: true });
  const recruitment = await getUraRecruitmentById(recruitmentId);
  if (!recruitment || recruitment.status !== "open") return interaction.reply({ content: "この募集は終了しています。", ephemeral: true });
  if (recruitment.ownerId === interaction.user.id) return interaction.reply({ content: "自分自身の募集には申請できません。", ephemeral: true });
  if (isUraRateLimited(interaction.user.id, "apply", 10_000)) {
    return interaction.reply({ content: "申請操作が早すぎます。少し待ってから再度お試しください。", ephemeral: true });
  }
  if (await getActiveUraMatchForUser(interaction.guild.id, interaction.user.id)) {
    return interaction.reply({ content: "現在マッチ中のため、他の募集へ申請できません。", ephemeral: true });
  }
  if (await isUraBlocked(interaction.guild.id, recruitment.ownerId, interaction.user.id)) {
    return interaction.reply({ content: "この募集には申請できません。", ephemeral: true });
  }
  if (await getUraApplication(recruitmentId, interaction.user.id)) {
    return interaction.reply({ content: "既にこの募集へ申請しています。", ephemeral: true });
  }
  const application = await createUraApplication({
    recruitmentId,
    guildId: interaction.guild.id,
    applicantId: interaction.user.id,
    note: interaction.fields.getTextInputValue("note").trim() || "（なし）",
  });
  if (!application) return interaction.reply({ content: "既にこの募集へ申請しています。", ephemeral: true });
  const notified = await sendApplicationNotice(interaction.guild, recruitmentId, application.id).catch(() => false);
  return interaction.reply({
    content: notified ? "申請を送りました。募集者からの連絡をお待ちください。" : "申請を登録しましたが、募集者へのDM送信に失敗しました。",
    ephemeral: true,
  });
}

async function handleSelectApplication(interaction: ButtonInteraction, client: Client, recruitmentId: number, applicationId: number): Promise<unknown> {
  const recruitment = await getUraRecruitmentById(recruitmentId);
  const application = await getUraApplicationById(applicationId);
  if (!recruitment || !application || recruitment.ownerId !== interaction.user.id) {
    return interaction.reply({ content: "この操作は募集者だけが実行できます。", ephemeral: true });
  }
  if (recruitment.status !== "open" || application.status !== "pending") {
    return interaction.reply({ content: "この募集はすでに終了しています。", ephemeral: true });
  }
  if (await isUraBlocked(recruitment.guildId, recruitment.ownerId, application.applicantId)) {
    return interaction.reply({ content: "この申請者とはマッチ成立できません。", ephemeral: true });
  }
  if (await getActiveUraMatchForUser(recruitment.guildId, application.applicantId)) {
    return interaction.reply({ content: "申請者は現在別のマッチ中のため、成立できません。", ephemeral: true });
  }
  await interaction.deferUpdate();
  const claimed = await markUraRecruitmentMatched(recruitmentId, application.applicantId);
  if (!claimed) return interaction.followUp({ content: "別の操作で募集が終了しました。", ephemeral: true });
  const guild = client.guilds.cache.get(recruitment.guildId) ?? await client.guilds.fetch(recruitment.guildId).catch(() => null);
  if (!guild) {
    await abortUraRecruitment(recruitmentId);
    return interaction.followUp({ content: "サーバーが見つかりません。", ephemeral: true });
  }
  let channel;
  try {
    channel = await createPrivateMatchChannel(guild, recruitmentId, recruitment.ownerId, application.applicantId);
    const match = await createUraMatch({
      guildId: recruitment.guildId,
      recruitmentId,
      hostId: recruitment.ownerId,
      guestId: application.applicantId,
      channelId: channel.id,
    });
    await deleteRecruitmentMessage(guild, recruitmentId);
    await notifyApplicants(guild, recruitmentId, application.applicantId);
    await sendMatchNotice(guild, match.id, recruitment.ownerId, application.applicantId, channel.id, `裏航海のマッチが成立しました。専用VC <#${channel.id}> をご利用ください。VCは作成から24時間後に削除されます。`);
    await sendMatchNotice(guild, match.id, application.applicantId, recruitment.ownerId, channel.id, `裏航海のマッチが成立しました。専用VC <#${channel.id}> をご利用ください。VCは作成から24時間後に削除されます。`);
    await interaction.editReply({ content: `✅ マッチを成立させ、専用VC <#${channel.id}> を作成しました。` });
  } catch (error) {
    if (channel) await channel.delete("裏航海マッチ作成失敗").catch(() => undefined);
    await abortUraRecruitment(recruitmentId);
    await refreshRecruitmentMessage(guild, recruitmentId);
    logger.error("[ura] failed to create private match", error);
    await interaction.editReply({ content: "専用VCの作成に失敗したため、募集を終了しました。" });
  }
  return undefined;
}

async function handleCancelRecruitment(interaction: ButtonInteraction, guild: Guild, recruitmentId: number) {
  const recruitment = await getUraRecruitmentById(recruitmentId);
  if (!recruitment || recruitment.ownerId !== interaction.user.id) return interaction.reply({ content: "募集者だけが終了できます。", ephemeral: true });
  const cancelled = await cancelUraRecruitment(recruitmentId, interaction.user.id);
  if (!cancelled) return interaction.reply({ content: "この募集はすでに終了しています。", ephemeral: true });
  await interaction.update({
    content: "募集を終了しました。",
    components: recruitmentCancelComponents(recruitmentId, true),
  });
  await deleteRecruitmentMessage(guild, recruitmentId);
  await notifyApplicants(guild, recruitmentId);
  return undefined;
}

export async function handleUraInteraction(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  client: Client,
): Promise<unknown> {
  const id = interaction.customId;
  if (interaction.isButton()) {
    const parts = id.split(":");
    if (id.startsWith(`${URA_PREFIX}panel:create:`)) {
      const type = parts[3] as UraRecruitmentType;
      return interaction.showModal(noteModal(`${CREATE_MODAL_PREFIX}${type}`, typeLabel(type), "note", "一言"));
    }
    if (id.startsWith(`${URA_PREFIX}recruitment:apply:`)) {
      return interaction.showModal(noteModal(`${APPLY_MODAL_PREFIX}${parts[3]}`, "裏航海へ申請", "note", "一言"));
    }
    if (id.startsWith(`${URA_PREFIX}recruitment:cancel:`)) {
      if (!interaction.guild) return interaction.reply({ content: "サーバー内でのみ使用できます。", ephemeral: true });
      return handleCancelRecruitment(interaction, interaction.guild, Number(parts[3]));
    }
    if (id.startsWith(`${URA_PREFIX}application:select:`)) {
      return handleSelectApplication(interaction, client, Number(parts[3]), Number(parts[4]));
    }
    if (id.startsWith(`${URA_PREFIX}application:dismiss:`)) {
      const recruitment = await getUraRecruitmentById(Number(parts[3]));
      if (!recruitment || recruitment.ownerId !== interaction.user.id) return interaction.reply({ content: "募集者だけが操作できます。", ephemeral: true });
      await dismissUraApplication(Number(parts[4]));
      await interaction.update({ content: "この申請を見送りました。", embeds: [], components: [] });
      return;
    }
    if (id.startsWith(`${URA_PREFIX}match:delete:`)) {
      const match = await getUraMatchById(Number(parts[3]));
      if (!match || match.status !== "active" || (match.hostId !== interaction.user.id && match.guestId !== interaction.user.id)) {
        return interaction.reply({ content: "このVCは既に終了したか、参加者ではありません。", ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });
      let channel = null;
      if (match.channelId) {
        try {
          channel = await client.channels.fetch(match.channelId);
        } catch (error) {
          if ((error as { code?: number }).code !== 10003) {
            logger.error(`[ura] failed to fetch match VC ${match.id}`, error);
            return interaction.editReply("VCを確認できませんでした。後ほど再度お試しください。");
          }
        }
      }
      if (channel) {
        if (channel.type !== ChannelType.GuildVoice || channel.guild.id !== match.guildId) {
          return interaction.editReply("対象VCを確認できませんでした。管理者に連絡してください。");
        }
        try {
          await channel.delete("裏航海の参加者による削除");
        } catch (error) {
          logger.error(`[ura] failed to delete match VC ${match.id}`, error);
          return interaction.editReply("VCの削除に失敗しました。Botの権限を確認してください。");
        }
      }
      await finishUraMatch(match.id);
      return interaction.editReply("専用VCを削除しました。");
    }
    if (id.startsWith(`${URA_PREFIX}match:report:`)) {
      return interaction.reply({ content: "通報機能は終了しました。", ephemeral: true });
    }
    if (id.startsWith(`${URA_PREFIX}match:block:`)) {
      const match = await getUraMatchById(Number(parts[3]));
      if (!match || (match.hostId !== interaction.user.id && match.guestId !== interaction.user.id)) return interaction.reply({ content: "この操作は参加者だけが実行できます。", ephemeral: true });
      const otherId = match.hostId === interaction.user.id ? match.guestId : match.hostId;
      await addUraBlock(match.guildId, interaction.user.id, otherId);
      return interaction.reply({ content: "相手をブロックしました。今後の裏航海で相互に申請・成立できません。", ephemeral: true });
    }
  }

  if (interaction.isModalSubmit()) {
    if (id.startsWith(CREATE_MODAL_PREFIX)) return handleCreateSubmit(interaction, id.slice(CREATE_MODAL_PREFIX.length) as UraRecruitmentType);
    if (id.startsWith(APPLY_MODAL_PREFIX)) return handleApplySubmit(interaction, Number(id.slice(APPLY_MODAL_PREFIX.length)));
    if (id.startsWith(`${URA_PREFIX}report:`)) return interaction.reply({ content: "通報機能は終了しました。", ephemeral: true });
  }
  return undefined;
}

export async function runUraRecruitmentCleanup(client: Client) {
  for (const guild of client.guilds.cache.values()) {
    if (syncedOpenRecruitmentGuilds.has(guild.id)) continue;
    try {
      const openRecruitments = await listOpenUraRecruitments(guild.id);
      await Promise.all(openRecruitments.map((recruitment) => refreshRecruitmentMessage(guild, recruitment.id)));
      await refreshExistingUraPanel(guild);
      syncedOpenRecruitmentGuilds.add(guild.id);
    } catch (error) {
      logger.warn(`[ura] failed to sync open recruitment cards for guild ${guild.id}`, error);
    }
  }

  const matches = await listUraMatchesReadyForDeletion(new Date());
  for (const match of matches) {
    let channel = null;
    if (match.channelId) {
      try {
        channel = await client.channels.fetch(match.channelId);
      } catch (error) {
        if ((error as { code?: number }).code !== 10003) {
          logger.error(`[ura] failed to fetch expired VC ${match.id}`, error);
          continue;
        }
      }
    }
    if (channel) {
      try {
        await channel.delete("裏航海の専用VCが作成から24時間経過");
      } catch (error) {
        logger.error(`[ura] failed to delete expired VC ${match.id}`, error);
        continue;
      }
    }
    await finishUraMatch(match.id);
  }
}

export const uraRecruitmentCommand = {
  data: new SlashCommandBuilder()
    .setName("裏航海")
    .setDescription("個通・寝落ちの裏航海を管理します")
    .addSubcommand((sub) => sub.setName("setup").setDescription("裏航海を設定します")
      .addChannelOption((option) => option.setName("panel_channel").setDescription("募集パネルを置くチャンネル").addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addChannelOption((option) => option.setName("channel").setDescription("募集カードを投稿するチャンネル").addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addChannelOption((option) => option.setName("category").setDescription("成立後に作る専用VCのカテゴリ").addChannelTypes(ChannelType.GuildCategory).setRequired(true)))
    .addSubcommand((sub) => sub.setName("panel").setDescription("設定済みチャンネルへ募集パネルを投稿します"))
    .addSubcommand((sub) => sub.setName("enable").setDescription("裏航海を有効化します"))
    .addSubcommand((sub) => sub.setName("disable").setDescription("裏航海を停止します"))
    .addSubcommand((sub) => sub.setName("block").setDescription("相手をブロックします").addUserOption((option) => option.setName("user").setDescription("ブロックする相手").setRequired(true)))
    .addSubcommand((sub) => sub.setName("unblock").setDescription("相手のブロックを解除します").addUserOption((option) => option.setName("user").setDescription("ブロック解除する相手").setRequired(true)))
    .addSubcommand((sub) => sub.setName("blocks").setDescription("自分がブロックしている相手を確認します"))
    .addSubcommand((sub) => sub.setName("list").setDescription("現在の募集一覧を確認します")),
  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild) return interaction.reply({ content: "サーバー内でのみ使用できます。", ephemeral: true });
    const subcommand = interaction.options.getSubcommand();
    if (["setup", "panel", "enable", "disable", "list"].includes(subcommand) && !adminOnly(interaction)) {
      return interaction.reply({ content: "管理者のみ実行できます。", ephemeral: true });
    }
    // Acknowledge before database or Discord API calls; slash commands expire after 3s.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (subcommand === "setup") {
      const panelChannel = interaction.options.getChannel("panel_channel", true);
      const channel = interaction.options.getChannel("channel", true);
      const category = interaction.options.getChannel("category", true);
      if (panelChannel.id === channel.id) {
        return interaction.editReply("パネルチャンネルと募集投稿チャンネルは別々に指定してください。");
      }
      await setUraRecruitmentSettings(interaction.guild.id, {
        panelChannelId: panelChannel.id,
        recruitmentChannelId: channel.id,
        vcCategoryId: category.id,
        enabled: true,
      });
      return interaction.editReply({
        content: `✅ パネルを <#${panelChannel.id}>、募集投稿を <#${channel.id}>、専用VCカテゴリを **${category.name}** に設定しました。`,
      });
    }
    if (subcommand === "panel") {
      const settings = await getUraRecruitmentSettings(interaction.guild.id);
      if (!settings.panelChannelId || !settings.recruitmentChannelId) return interaction.editReply("先に `/裏航海 setup` を実行してください。");
      const channel = await configuredPanelChannel(interaction.guild);
      if (!channel) return interaction.editReply("パネルチャンネルが見つかりません。");
      await channel.send({ embeds: [panelEmbed()], components: panelComponents() });
      return interaction.editReply(`✅ <#${channel.id}> にパネルを設置しました。`);
    }
    if (subcommand === "enable" || subcommand === "disable") {
      await setUraRecruitmentSettings(interaction.guild.id, { enabled: subcommand === "enable" });
      return interaction.editReply(subcommand === "enable" ? "✅ 裏航海を有効化しました。" : "✅ 裏航海を停止しました。");
    }
    if (subcommand === "list") {
      const rows = await listOpenUraRecruitments(interaction.guild.id);
      return interaction.editReply(rows.length ? rows.map((row) => `#${row.id} ${typeLabel(row.type as UraRecruitmentType)} <@${row.ownerId}>`).join("\n") : "募集中の募集はありません。");
    }
    if (subcommand === "blocks") {
      const blocks = await listUraBlocks(interaction.guild.id, interaction.user.id);
      return interaction.editReply(blocks.length ? blocks.map((row) => `<@${row.blockedId}>`).join("\n") : "ブロック中のユーザーはいません。");
    }
    const target = interaction.options.getUser("user", true);
    if (target.id === interaction.user.id) return interaction.editReply("自分自身は指定できません。");
    if (subcommand === "block") {
      await addUraBlock(interaction.guild.id, interaction.user.id, target.id);
      return interaction.editReply("ブロックしました。");
    }
    if (subcommand === "unblock") {
      await removeUraBlock(interaction.guild.id, interaction.user.id, target.id);
      return interaction.editReply("ブロックを解除しました。");
    }
    return interaction.editReply("操作を受け付けました。");
  },
};