/**
 * /vc — VC 管理コマンド
 *   rename      : VCを即リネーム（管理者）
 *   hub-add     : 入ると自動VCを生成するトリガーチャンネルを登録（管理者）
 *   hub-remove  : Hub チャンネル登録を解除（管理者）
 *   hub-list    : 登録済み Hub 一覧を表示（管理者）
 */

import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type VoiceState,
} from "discord.js";
import {
  addHubChannel,
  getHubChannels,
  removeHubChannel,
  getHubByChannelId,
  createHubSession,
  getHubSession,
  deleteHubSession,
} from "@workspace/db";
import { logger } from "../lib/logger";

// ─── /vc command ────────────────────────────────────────────────────────────

export const vcCommand = {
  data: new SlashCommandBuilder()
    .setName("vc")
    .setDescription("VCを管理します")
    // ── rename ────────────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("rename")
        .setDescription("VCを新しい名前にリネームします")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("リネームするVCチャンネル")
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName("new-name")
            .setDescription("新しいチャンネル名")
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(100),
        ),
    )
    // ── hub-add ───────────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("hub-add")
        .setDescription(
          "入ると自動でVCを作成・転送するトリガーチャンネルを登録します",
        )
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("トリガーにするVCチャンネル")
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(true),
        )
        .addChannelOption((opt) =>
          opt
            .setName("category")
            .setDescription(
              "生成VCを置くカテゴリ（省略するとトリガーと同じカテゴリ）",
            )
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(false),
        )
        .addStringOption((opt) =>
          opt
            .setName("name_template")
            .setDescription(
              "生成VCの名前テンプレート。{user} がメンバー名に置換されます（例: {user}のVC）",
            )
            .setMaxLength(90)
            .setRequired(false),
        ),
    )
    // ── hub-remove ────────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("hub-remove")
        .setDescription("Hub チャンネル登録を解除します")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("解除するVCチャンネル")
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(true),
        ),
    )
    // ── hub-list ──────────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("hub-list")
        .setDescription("登録済みの Hub チャンネル一覧を表示します"),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({
        content: "このコマンドはサーバー内でのみ使用できます。",
        ephemeral: true,
      });
      return;
    }

    const sub = interaction.options.getSubcommand();

    // ── rename ────────────────────────────────────────────────────────────
    if (sub === "rename") {
      await handleRename(interaction);
      return;
    }

    // hub-* subcommands require ManageChannels
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
      await interaction.reply({
        content: "このコマンドを使用するには ManageChannels 権限が必要です。",
        ephemeral: true,
      });
      return;
    }

    // ── hub-add ───────────────────────────────────────────────────────────
    if (sub === "hub-add") {
      const channel      = interaction.options.getChannel("channel", true);
      const categoryOpt  = interaction.options.getChannel("category");
      const templateOpt  = interaction.options.getString("name_template");
      const nameTemplate = templateOpt?.trim() || "{user}のVC";

      await addHubChannel(
        interaction.guildId,
        channel.id,
        categoryOpt?.id ?? null,
        nameTemplate,
      );

      const categoryDisplay = categoryOpt
        ? `<#${categoryOpt.id}>`
        : "（トリガーと同じカテゴリ）";
      await interaction.reply({
        content:
          `✅ <#${channel.id}> を Hub チャンネルとして登録しました。\n` +
          `名前テンプレート: \`${nameTemplate}\`\n` +
          `生成先カテゴリ: ${categoryDisplay}`,
        ephemeral: true,
      });
      return;
    }

    // ── hub-remove ────────────────────────────────────────────────────────
    if (sub === "hub-remove") {
      const channel = interaction.options.getChannel("channel", true);
      const removed = await removeHubChannel(interaction.guildId, channel.id);
      if (!removed) {
        await interaction.reply({
          content: `<#${channel.id}> は Hub として登録されていません。`,
          ephemeral: true,
        });
        return;
      }
      await interaction.reply({
        content: `✅ <#${channel.id}> の Hub 登録を解除しました。`,
        ephemeral: true,
      });
      return;
    }

    // ── hub-list ──────────────────────────────────────────────────────────
    if (sub === "hub-list") {
      const hubs = await getHubChannels(interaction.guildId);
      if (hubs.length === 0) {
        await interaction.reply({
          content:
            "Hub チャンネルはまだ登録されていません。`/vc hub-add` で追加できます。",
          ephemeral: true,
        });
        return;
      }
      const embed = new EmbedBuilder()
        .setTitle("🔀 Hub チャンネル一覧")
        .setColor(0x5865f2)
        .addFields(
          hubs.map((h) => ({
            name: `<#${h.hubChannelId}>`,
            value: [
              `テンプレート: \`${h.nameTemplate}\``,
              h.categoryId
                ? `生成先カテゴリ: <#${h.categoryId}>`
                : "生成先カテゴリ: トリガーと同じ",
            ].join("\n"),
            inline: false,
          })),
        );
      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }
  },
};

// ─── /vc rename ──────────────────────────────────────────────────────────────

async function handleRename(interaction: ChatInputCommandInteraction): Promise<void> {
  const me = interaction.guild?.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.reply({
      content: "BotにManageChannels権限がないため、VCをリネームできません。",
      ephemeral: true,
    });
    return;
  }

  const channel = interaction.options.getChannel("channel", true);
  const newName = interaction.options.getString("new-name", true).trim();

  const voiceChannel =
    interaction.guild?.channels.cache.get(channel.id) ??
    (await interaction.guild?.channels.fetch(channel.id).catch(() => null));

  if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
    await interaction.reply({
      content: "対象のボイスチャンネルが見つかりませんでした。",
      ephemeral: true,
    });
    return;
  }

  await voiceChannel.setName(newName);
  await interaction.reply({
    content: `<#${channel.id}> を **${newName}** にリネームしました。`,
    ephemeral: true,
  });
}

// ─── Hub join / leave (called from index.ts voiceStateUpdate) ────────────────

/**
 * メンバーが Hub チャンネルに入ったとき:
 *   1. 新しいVCを生成
 *   2. メンバーを転送
 *   3. セッションを記録
 */
export async function handleHubJoin(newState: VoiceState): Promise<void> {
  if (!newState.channelId || !newState.member) return;

  const hub = await getHubByChannelId(newState.channelId);
  if (!hub) return;

  const guild       = newState.guild;
  const member      = newState.member;
  const displayName = member.displayName;
  const channelName = hub.nameTemplate.replace("{user}", displayName).slice(0, 100);

  // 生成先カテゴリ: hub 設定 → hub 自身の親カテゴリ → なし
  const hubChannel = guild.channels.cache.get(newState.channelId);
  const categoryId = hub.categoryId ?? hubChannel?.parentId ?? undefined;

  try {
    const newVc = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildVoice,
      parent: categoryId,
    });

    await createHubSession(guild.id, newVc.id, member.id, hub.id);

    // メンバーを新VCに転送
    await member.voice.setChannel(newVc).catch(async () => {
      // 転送失敗（権限不足など）→ 作成した空VCを削除
      await deleteHubSession(newVc.id);
      await newVc.delete().catch(() => {});
    });
  } catch (err) {
    logger.error(
      `[vcHub] handleHubJoin error member=${member.id} hub=${hub.hubChannelId}`,
      err,
    );
  }
}

/**
 * メンバーが Hub によって生成されたVCを離れたとき:
 *   チャンネルが空になっていれば自動削除する
 */
export async function handleHubLeave(oldState: VoiceState): Promise<void> {
  if (!oldState.channelId) return;

  const session = await getHubSession(oldState.channelId);
  if (!session) return;

  const guild   = oldState.guild;
  const channel = guild.channels.cache.get(oldState.channelId);
  if (!channel || !channel.isVoiceBased()) return;

  // まだ誰かいるなら何もしない
  if (channel.members.size > 0) return;

  try {
    await deleteHubSession(oldState.channelId);
    await channel.delete();
    logger.info(
      `[vcHub] Auto-deleted empty hub VC: ${channel.name} (${oldState.channelId})`,
    );
  } catch (err) {
    logger.error(
      `[vcHub] handleHubLeave delete error channel=${oldState.channelId}`,
      err,
    );
  }
}
