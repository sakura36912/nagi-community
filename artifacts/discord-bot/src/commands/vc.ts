/**
 * /vc rename — immediately rename a voice channel (admin only).
 *
 * Required bot permission: ManageChannels
 */

import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { logger } from "../lib/logger";

export const vcCommand = {
  data: new SlashCommandBuilder()
    .setName("vc")
    .setDescription("VCをリネームします")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
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
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: "このコマンドはサーバー内でのみ使用できます。", ephemeral: true });
      return;
    }
    await handleRename(interaction);
  },
};

async function handleRename(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = interaction.options.getChannel("channel", true);
  const newName = interaction.options.getString("new-name", true).trim();

  // Runtime permission check for the invoking member (defence-in-depth in addition
  // to setDefaultMemberPermissions, which Discord clients enforce on the UI side).
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.reply({
      content: "このコマンドを使用するには ManageChannels 権限が必要です。",
      ephemeral: true,
    });
    return;
  }

  // Verify bot has ManageChannels permission
  const me = interaction.guild?.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.reply({
      content: "BotにManageChannels権限がないため、VCをリネームできません。",
      ephemeral: true,
    });
    return;
  }

  // Rename immediately — no duration picker.
  const voiceChannel = interaction.guild?.channels.cache.get(channel.id)
    ?? await interaction.guild?.channels.fetch(channel.id).catch(() => null);

  if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
    await interaction.reply({ content: "対象のボイスチャンネルが見つかりませんでした。", ephemeral: true });
    return;
  }

  await voiceChannel.setName(newName);
  await interaction.reply({ content: `<#${channel.id}> を **${newName}** にリネームしました。`, ephemeral: true });
}

