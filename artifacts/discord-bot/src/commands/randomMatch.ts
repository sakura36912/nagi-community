import { randomInt } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type ModalSubmitInteraction,
} from "discord.js";
import {
  addRandomMatchBlock,
  attachRandomMatchChannel,
  cancelRandomMatch,
  clearRandomMatchQueue,
  createRandomMatchIfWaiting,
  createRandomMatchReport,
  finishRandomMatch,
  getActiveRandomMatchForUser,
  getRandomMatchByChannelId,
  getRandomMatchById,
  getRandomMatchCooldown,
  getRandomMatchSettings,
  isRandomMatchBlocked,
  joinRandomMatchQueue,
  leaveRandomMatchQueue,
  listRandomMatchBlocks,
  listRandomMatchQueue,
  listRandomMatchReports,
  listRandomMatchesReadyForDeletion,
  markRandomMatchDeleteAt,
  RANDOM_MATCH_ANY,
  RANDOM_MATCH_FEMALE,
  RANDOM_MATCH_MALE,
  removeRandomMatchBlock,
  requeueRandomMatchUsers,
  setRandomMatchSettings,
  type RandomMatch,
  type RandomMatchPreference,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { getGuildSettings } from "../lib/economy";

export const RANDOM_MATCH_PREFIX = "random-match:";
export const RANDOM_MATCH_REPORT_MODAL_PREFIX = `${RANDOM_MATCH_PREFIX}report-modal:`;
const REPORT_BUTTON_PREFIX = `${RANDOM_MATCH_PREFIX}report:`;
const MATCH_CANCEL_BUTTON_PREFIX = `${RANDOM_MATCH_PREFIX}cancel-match:`;
const REMATCH_COOLDOWN_MS = 10 * 60 * 1000;
const MALE_ROLE_NAME = "男性";
const FEMALE_ROLE_NAME = "女性";

type RandomMatchCommand = {
  data: { name: string; toJSON: () => unknown };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
};

function guildIdOf(interaction: { guildId: string | null }): string {
  if (!interaction.guildId) throw new Error("この操作はサーバー内でのみ使用できます。");
  return interaction.guildId;
}

function preferenceLabel(preference: RandomMatchPreference): string {
  if (preference === RANDOM_MATCH_MALE) return "男性";
  if (preference === RANDOM_MATCH_FEMALE) return "女性";
  return "指定なし";
}

function r18Label(r18Allowed: boolean): string {
  return r18Allowed ? "R18○" : "R18×";
}

function hasGender(member: { roles: { cache: { some: (fn: (role: { name: string }) => boolean) => boolean } } }, gender: "male" | "female") {
  const targetName = gender === "male" ? MALE_ROLE_NAME : FEMALE_ROLE_NAME;
  return member.roles.cache.some((role) => role.name === targetName);
}

function memberGender(member: { roles: { cache: { some: (fn: (role: { name: string }) => boolean) => boolean } } }): "male" | "female" | "unknown" {
  const male = hasGender(member, "male");
  const female = hasGender(member, "female");
  if (male === female) return "unknown";
  return male ? "male" : "female";
}

function preferenceAccepts(preference: string, gender: "male" | "female" | "unknown") {
  return preference === RANDOM_MATCH_ANY || preference === gender;
}

function buildPanel() {
  const embed = new EmbedBuilder()
    .setTitle("🕯️ 裏募集｜完全ランダムマッチ")
    .setColor(0x6d4aff)
    .setDescription(
      "1対1で話したい人同士を、BOTが完全ランダムでマッチングします。\n\n"
      + "参加者一覧は公開されません。相手の指定・選択はできず、成立後は凪の専用VCへ案内されます。\n\n"
      + "利用中に問題があった場合は、マッチ後に届く通報ボタンから管理へ報告してください。",
    )
    .addFields({
      name: "参加条件",
      value: "性別条件とR18可否を選んで参加してください。\n"
        + "・指定なし：全員から抽選\n・男性指定：男性ロールの相手から抽選\n・女性指定：女性ロールの相手から抽選\n"
        + "・R18○同士、R18×同士のみマッチします。",
    });

  const joinR18AllowedRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${RANDOM_MATCH_PREFIX}join:any:r18yes`)
      .setLabel("指定なし・R18○")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${RANDOM_MATCH_PREFIX}join:male:r18yes`)
      .setLabel("男性指定・R18○")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${RANDOM_MATCH_PREFIX}join:female:r18yes`)
      .setLabel("女性指定・R18○")
      .setStyle(ButtonStyle.Secondary),
  );
  const joinR18DeniedRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${RANDOM_MATCH_PREFIX}join:any:r18no`)
      .setLabel("指定なし・R18×")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${RANDOM_MATCH_PREFIX}join:male:r18no`)
      .setLabel("男性指定・R18×")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${RANDOM_MATCH_PREFIX}join:female:r18no`)
      .setLabel("女性指定・R18×")
      .setStyle(ButtonStyle.Secondary),
  );
  const cancelRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${RANDOM_MATCH_PREFIX}cancel`)
      .setLabel("待機をキャンセル")
      .setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [joinR18AllowedRow, joinR18DeniedRow, cancelRow] };
}

function matchActionRow(matchId: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${MATCH_CANCEL_BUTTON_PREFIX}${matchId}`)
      .setLabel("マッチングをキャンセル")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${REPORT_BUTTON_PREFIX}${matchId}`)
      .setLabel("このマッチを通報")
      .setStyle(ButtonStyle.Danger),
  );
}

async function notifyMatchUsers(guild: Guild, match: RandomMatch, channelId: string) {
  const users = await Promise.all([
    guild.client.users.fetch(match.userAId),
    guild.client.users.fetch(match.userBId),
  ]);
  const otherByUser = new Map([
    [match.userAId, match.userBId],
    [match.userBId, match.userAId],
  ]);
  await Promise.all(
    users.map(async (user) => {
      const otherId = otherByUser.get(user.id);
      await user.send({
        content:
          `✅ 裏募集のマッチが成立しました。\n`
          + `相手：<@${otherId}>\n`
          + `専用VC：<#${channelId}>\n\n`
          + "相手の変更は原則できません。終了したい場合はキャンセル、問題があれば通報を選択してください。",
        components: [matchActionRow(match.id)],
      }).catch((err) => logger.warn(`[random-match] Failed to DM match result user=${user.id}`, err));
    }),
  );
}

async function createMatchChannel(guild: Guild, match: RandomMatch) {
  const settings = await getRandomMatchSettings(guild.id);
  if (!settings.enabled) throw new Error("裏募集は現在停止中です。");
  let categoryId = settings.categoryId;
  if (!categoryId) {
    categoryId = (await getGuildSettings(guild.id)).uraCategoryId;
    if (categoryId) await setRandomMatchSettings(guild.id, { categoryId });
  }
  if (!categoryId) throw new Error("裏募集VCカテゴリが未設定です。管理者に設定を依頼してください。");

  const parent = guild.channels.cache.get(categoryId)
    ?? await guild.channels.fetch(categoryId).catch(() => null);
  if (!parent || parent.type !== ChannelType.GuildCategory) {
    throw new Error("裏募集VCカテゴリが見つかりません。管理者に再設定を依頼してください。");
  }

  const memberA = await guild.members.fetch(match.userAId);
  const memberB = await guild.members.fetch(match.userBId);
  const botId = guild.members.me?.id;
  const channel = await guild.channels.create({
    name: `裏募集・${memberA.displayName}×${memberB.displayName}`.slice(0, 100),
    type: ChannelType.GuildVoice,
    userLimit: 2,
    parent: parent.id,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
      {
        id: memberA.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
      },
      {
        id: memberB.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
      },
      ...(botId
        ? [{
          id: botId,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels],
        }]
        : []),
    ],
  });
  await attachRandomMatchChannel(match.id, channel.id);
  return channel;
}

async function findAndCreateRandomMatch(guild: Guild) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const queue = await listRandomMatchQueue(guild.id);
    if (queue.length < 2) return null;

    const entries = await Promise.all(
      queue.map(async (entry) => ({
        entry,
        member: await guild.members.fetch(entry.userId).catch(() => null),
      })),
    );
    const eligible: Array<[string, string]> = [];
    for (let i = 0; i < entries.length; i += 1) {
      const left = entries[i];
      if (!left?.member) continue;
      const leftGender = memberGender(left.member);
      for (let j = i + 1; j < entries.length; j += 1) {
        const right = entries[j];
        if (!right?.member) continue;
        const rightGender = memberGender(right.member);
        if (!preferenceAccepts(left.entry.preference, rightGender)) continue;
        if (!preferenceAccepts(right.entry.preference, leftGender)) continue;
        if (left.entry.r18Allowed !== right.entry.r18Allowed) continue;
        if (await isRandomMatchBlocked(guild.id, left.entry.userId, right.entry.userId)) continue;
        eligible.push([left.entry.userId, right.entry.userId]);
      }
    }
    if (eligible.length === 0) return null;
    const pair = eligible[randomInt(eligible.length)]!;
    const match = await createRandomMatchIfWaiting(guild.id, pair[0], pair[1]);
    if (!match) continue;
    try {
      const channel = await createMatchChannel(guild, match);
      await notifyMatchUsers(guild, match, channel.id);
      return { match, channel };
    } catch (err) {
      await finishRandomMatch(match.id).catch(() => undefined);
      await requeueRandomMatchUsers(guild.id, [
        { userId: match.userAId, preference: RANDOM_MATCH_ANY, r18Allowed: match.r18Allowed },
        { userId: match.userBId, preference: RANDOM_MATCH_ANY, r18Allowed: match.r18Allowed },
      ]).catch(() => undefined);
      throw err;
    }
  }
  return null;
}

async function joinWithPreference(
  interaction: ButtonInteraction,
  preference: RandomMatchPreference,
  r18Allowed: boolean,
) {
  const guildId = guildIdOf(interaction);
  const guild = interaction.guild;
  if (!guild) throw new Error("ギルドを取得できません。");
  const settings = await getRandomMatchSettings(guildId);
  if (!settings.enabled) {
    await interaction.reply({ content: "現在、裏募集は停止中です。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!settings.categoryId && !(await getGuildSettings(guildId)).uraCategoryId) {
    await interaction.reply({ content: "裏募集VCが未設定です。管理者に設定を依頼してください。", flags: MessageFlags.Ephemeral });
    return;
  }
  const active = await getActiveRandomMatchForUser(guildId, interaction.user.id);
  if (active) {
    await interaction.reply({ content: "すでにマッチ中です。専用VCをご利用ください。", flags: MessageFlags.Ephemeral });
    return;
  }
  const recent = await getRandomMatchCooldown(
    guildId,
    interaction.user.id,
    new Date(Date.now() - REMATCH_COOLDOWN_MS),
  );
  if (recent) {
    await interaction.reply({ content: "再マッチまで少しお待ちください。", flags: MessageFlags.Ephemeral });
    return;
  }
  if (preference !== RANDOM_MATCH_ANY) {
    const hasTargetRole = guild.members.cache.get(interaction.user.id)
      ?? await guild.members.fetch(interaction.user.id);
    if (!hasGender(hasTargetRole, preference === RANDOM_MATCH_MALE ? "male" : "female")
      && memberGender(hasTargetRole) === "unknown") {
      // The participant may still choose a target gender; this check only gives
      // a useful warning when the guild has no such role at all.
      const roleExists = guild.roles.cache.some((role) =>
        role.name === (preference === RANDOM_MATCH_MALE ? MALE_ROLE_NAME : FEMALE_ROLE_NAME),
      );
      if (!roleExists) {
        await interaction.reply({
          content: `ギルド内に「${preferenceLabel(preference)}」ロールがないため、現在はその条件で募集できません。`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }
  }
  await joinRandomMatchQueue(guildId, interaction.user.id, preference, r18Allowed);
  const result = await findAndCreateRandomMatch(guild);
  if (!result) {
    await interaction.reply({
      content: `待機に入りました（希望：${preferenceLabel(preference)}、${r18Label(r18Allowed)}）。参加者一覧は公開されません。相性の合う相手が見つかるとDMで通知します。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await interaction.reply({
    content: `マッチ成立しました。専用VC <#${result.channel.id}> をDMにも送信しました。`,
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleRandomMatchButton(interaction: ButtonInteraction) {
  if (interaction.customId === `${RANDOM_MATCH_PREFIX}cancel`) {
    const guildId = guildIdOf(interaction);
    await leaveRandomMatchQueue(guildId, interaction.user.id);
    await interaction.reply({ content: "裏募集の待機をキャンセルしました。", flags: MessageFlags.Ephemeral });
    return;
  }
  const matchPrefix = `${RANDOM_MATCH_PREFIX}join:`;
  if (!interaction.customId.startsWith(matchPrefix)) return;
  const [preferenceValue, r18Value] = interaction.customId.slice(matchPrefix.length).split(":");
  const preference = preferenceValue as RandomMatchPreference;
  const r18Allowed = r18Value === "r18yes";
  if (![RANDOM_MATCH_ANY, RANDOM_MATCH_MALE, RANDOM_MATCH_FEMALE].includes(preference)) return;
  if (r18Value !== "r18yes" && r18Value !== "r18no") return;
  await joinWithPreference(interaction, preference, r18Allowed);
}

export async function handleRandomMatchReportButton(interaction: ButtonInteraction) {
  const matchId = Number(interaction.customId.slice(REPORT_BUTTON_PREFIX.length));
  if (!Number.isInteger(matchId)) return;
  const match = await getRandomMatchById(matchId);
  if (!match || ![match.userAId, match.userBId].includes(interaction.user.id)) {
    await interaction.reply({ content: "このマッチを通報できません。", flags: MessageFlags.Ephemeral });
    return;
  }
  const modal = new ModalBuilder()
    .setCustomId(`${RANDOM_MATCH_REPORT_MODAL_PREFIX}${matchId}`)
    .setTitle("裏募集マッチを通報");
  const reason = new TextInputBuilder()
    .setCustomId("reason")
    .setLabel("通報理由")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMinLength(2)
    .setMaxLength(1000)
    .setPlaceholder("発生した問題を具体的に書いてください");
  await interaction.showModal(modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(reason),
  ));
}

export async function handleRandomMatchCancelButton(
  interaction: ButtonInteraction,
  client: Client,
) {
  const matchId = Number(interaction.customId.slice(MATCH_CANCEL_BUTTON_PREFIX.length));
  if (!Number.isInteger(matchId)) return;
  const match = await getRandomMatchById(matchId);
  if (!match || ![match.userAId, match.userBId].includes(interaction.user.id)) {
    await interaction.update({
      content: "このマッチはキャンセルできません。",
      components: [],
    });
    return;
  }
  const cancelled = await cancelRandomMatch(matchId);
  if (!cancelled) {
    await interaction.update({
      content: "このマッチはすでに終了またはキャンセルされています。",
      components: [],
    });
    return;
  }

  const guild = client.guilds.cache.get(match.guildId);
  const channel = guild?.channels.cache.get(match.channelId ?? "");
  if (channel) {
    await channel.delete("裏募集マッチのキャンセル").catch((err) =>
      logger.warn(`[random-match] Failed to delete cancelled channel match=${match.id}`, err),
    );
  }

  const otherId = match.userAId === interaction.user.id ? match.userBId : match.userAId;
  await interaction.update({
    content: "🛑 裏募集のマッチングをキャンセルしました。専用VCも終了しました。",
    components: [],
  });
  try {
    const otherUser = await client.users.fetch(otherId);
    await otherUser.send("🛑 裏募集の相手がマッチングをキャンセルしました。専用VCは終了しました。");
  } catch (err) {
    logger.warn(`[random-match] Failed to notify cancelled match partner=${otherId}`, err);
  }
}

export async function handleRandomMatchReportModal(interaction: ModalSubmitInteraction) {
  const matchId = Number(interaction.customId.slice(RANDOM_MATCH_REPORT_MODAL_PREFIX.length));
  const match = await getRandomMatchById(matchId);
  if (!match || ![match.userAId, match.userBId].includes(interaction.user.id)) {
    await interaction.reply({ content: "このマッチを通報できません。", flags: MessageFlags.Ephemeral });
    return;
  }
  const reportedId = match.userAId === interaction.user.id ? match.userBId : match.userAId;
  const reason = interaction.fields.getTextInputValue("reason").trim();
  await createRandomMatchReport(match.guildId, match.id, interaction.user.id, reportedId, reason);
  logger.warn(`[random-match] Report opened guild=${match.guildId} match=${match.id} reporter=${interaction.user.id} reported=${reportedId}`);
  const settings = await getRandomMatchSettings(match.guildId);
  const guild = interaction.client.guilds.cache.get(match.guildId)
    ?? await interaction.client.guilds.fetch(match.guildId).catch(() => null);
  const reportChannel = settings.reportChannelId
    ? guild?.channels.cache.get(settings.reportChannelId)
      ?? await guild?.channels.fetch(settings.reportChannelId).catch(() => null)
    : null;
  if (reportChannel?.isTextBased() && settings.reportRoleId) {
    await reportChannel.send({
      content: `<@&${settings.reportRoleId}>`,
      embeds: [
        new EmbedBuilder()
          .setTitle("🚨 裏募集マッチの通報")
          .setColor(0xff3b30)
          .addFields(
            { name: "マッチID", value: String(match.id), inline: true },
            { name: "通報者", value: `<@${interaction.user.id}>`, inline: true },
            { name: "通報対象", value: `<@${reportedId}>`, inline: true },
            { name: "理由", value: reason.slice(0, 1024) },
          )
          .setTimestamp(),
      ],
      allowedMentions: { roles: [settings.reportRoleId], users: [] },
    }).catch((err) =>
      logger.error(`[random-match] Failed to send report notification guild=${match.guildId}`, err),
    );
  } else {
    logger.error(`[random-match] Report notification destination is not configured guild=${match.guildId}`);
  }
  await interaction.reply({
    content: "通報を受け付けました。管理者が確認します。",
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleRandomMatchVoiceStateUpdate(
  client: Client,
  oldChannelId: string | null,
  newChannelId: string | null,
) {
  const channelId = oldChannelId ?? newChannelId;
  if (!channelId) return;
  const match = await getRandomMatchByChannelId(channelId);
  if (!match) return;
  if (newChannelId === match.channelId) {
    await markRandomMatchDeleteAt(match.id, null);
    return;
  }
  if (oldChannelId !== match.channelId) return;
  // The caller's channel cache is authoritative for this event; cleanup also
  // re-checks before deletion to avoid removing a channel after rejoin.
  const guild = client.guilds.cache.get(match.guildId);
  const channel = guild?.channels.cache.get(match.channelId!);
  if (channel?.type === ChannelType.GuildVoice && channel.members.size === 0) {
    await markRandomMatchDeleteAt(match.id, new Date());
    try {
      await channel.delete("裏募集マッチのVCが空になったため即時削除");
      await finishRandomMatch(match.id);
    } catch (err) {
      logger.error(`[random-match] Failed to immediately delete empty channel match=${match.id}`, err);
    }
  }
}

export async function runRandomMatchCleanup(client: Client) {
  const matches = await listRandomMatchesReadyForDeletion(new Date());
  for (const match of matches) {
    const guild = client.guilds.cache.get(match.guildId);
    const channel = guild?.channels.cache.get(match.channelId ?? "");
    if (channel?.type === ChannelType.GuildVoice && channel.members.size > 0) {
      await markRandomMatchDeleteAt(match.id, null);
      continue;
    }
    try {
      if (channel) await channel.delete("裏募集マッチ終了後の自動削除");
      await finishRandomMatch(match.id);
    } catch (err) {
      logger.error(`[random-match] Failed to delete channel match=${match.id}`, err);
    }
  }
}

const randomMatchCommand: RandomMatchCommand = {
  data: new SlashCommandBuilder()
    .setName("ura-match")
    .setDescription("裏募集の完全ランダムマッチを管理します")
    .addSubcommand((sub) =>
      sub.setName("panel").setDescription("このチャンネルに裏募集パネルを投稿します（管理者）"),
    )
    .addSubcommand((sub) =>
      sub.setName("setup").setDescription("裏募集の専用VCカテゴリを設定します（管理者）")
        .addChannelOption((opt) =>
          opt.setName("category").setDescription("マッチVCを作成するカテゴリ").addChannelTypes(ChannelType.GuildCategory).setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("report-setup").setDescription("通報通知先とメンション対象を設定します（管理者）")
        .addChannelOption((opt) =>
          opt.setName("channel").setDescription("通報を投稿するテキストチャンネル")
            .addChannelTypes(ChannelType.GuildText).setRequired(true),
        )
        .addRoleOption((opt) =>
          opt.setName("role").setDescription("通報時にメンションする管理者ロール").setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName("enable").setDescription("裏募集を開始します（管理者）"))
    .addSubcommand((sub) => sub.setName("disable").setDescription("裏募集を停止します（管理者）"))
    .addSubcommand((sub) =>
      sub.setName("block").setDescription("指定ユーザーとはマッチしないようにします")
        .addUserOption((opt) => opt.setName("user").setDescription("ブロック対象").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub.setName("unblock").setDescription("指定ユーザーのマッチ拒否を解除します")
        .addUserOption((opt) => opt.setName("user").setDescription("解除対象").setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName("blocks").setDescription("自分のマッチ拒否一覧を表示します"))
    .addSubcommand((sub) => sub.setName("reports").setDescription("通報一覧を表示します（管理者）")),

  async execute(interaction) {
    const guildId = guildIdOf(interaction);
    const sub = interaction.options.getSubcommand();
    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
    if (["panel", "setup", "report-setup", "enable", "disable", "reports"].includes(sub) && !isAdmin) {
      await interaction.reply({ content: "この操作はサーバー管理者のみ利用できます。", flags: MessageFlags.Ephemeral });
      return;
    }
    if (sub === "panel") {
      await interaction.reply(buildPanel());
      return;
    }
    if (sub === "setup") {
      const category = interaction.options.getChannel("category", true);
      await setRandomMatchSettings(guildId, { categoryId: category.id, enabled: true });
      await interaction.reply(`✅ 裏募集マッチVCの作成先を <#${category.id}> に設定しました。`);
      return;
    }
    if (sub === "report-setup") {
      const channel = interaction.options.getChannel("channel", true);
      const role = interaction.options.getRole("role", true);
      await setRandomMatchSettings(guildId, {
        reportChannelId: channel.id,
        reportRoleId: role.id,
      });
      await interaction.reply(
        `✅ 通報通知先を <#${channel.id}>、メンション対象を <@&${role.id}> に設定しました。`,
      );
      return;
    }
    if (sub === "enable" || sub === "disable") {
      await setRandomMatchSettings(guildId, { enabled: sub === "enable" });
      await interaction.reply(sub === "enable" ? "✅ 裏募集を開始しました。" : "✅ 裏募集を停止しました。新規参加を受け付けません。");
      if (sub === "disable") await clearRandomMatchQueue(guildId);
      return;
    }
    if (sub === "block" || sub === "unblock") {
      const user = interaction.options.getUser("user", true);
      if (user.id === interaction.user.id) {
        await interaction.reply({ content: "自分自身は指定できません。", flags: MessageFlags.Ephemeral });
        return;
      }
      if (sub === "block") {
        await addRandomMatchBlock(guildId, interaction.user.id, user.id);
        await leaveRandomMatchQueue(guildId, interaction.user.id);
        await interaction.reply({ content: `<@${user.id}> をマッチ拒否対象に追加しました。`, flags: MessageFlags.Ephemeral });
      } else {
        await removeRandomMatchBlock(guildId, interaction.user.id, user.id);
        await interaction.reply({ content: `<@${user.id}> のマッチ拒否を解除しました。`, flags: MessageFlags.Ephemeral });
      }
      return;
    }
    if (sub === "blocks") {
      const blocks = await listRandomMatchBlocks(guildId, interaction.user.id);
      await interaction.reply({
        content: blocks.length === 0
          ? "マッチ拒否対象はいません。"
          : `マッチ拒否対象:\n${blocks.map((block) => `・<@${block.blockedId}>`).join("\n")}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const reports = await listRandomMatchReports(guildId);
    await interaction.reply({
      content: reports.length === 0
        ? "通報はありません。"
        : reports.map((report) =>
          `#${report.id} <t:${Math.floor(report.createdAt.getTime() / 1000)}:R> `
          + `<@${report.reporterId}> → <@${report.reportedId}>: ${report.reason}`,
        ).join("\n"),
      flags: MessageFlags.Ephemeral,
    });
  },
};

export { randomMatchCommand };