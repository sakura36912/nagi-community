import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { getGuildSettings, setBanLogChannelId } from "../lib/economy";
interface Command {
  data: SlashCommandBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

export const bannotifyCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("bannotify")
    .setDescription("BANログチャンネルの設定")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("BAN通知を送るチャンネルを設定する")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("BAN通知先のテキストチャンネル")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("clear")
        .setDescription("BAN通知を無効化する（チャンネル設定を解除）"),
    )
    .addSubcommand((sub) =>
      sub.setName("status").setDescription("現在のBAN通知設定を確認する"),
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: "サーバー内でのみ使用できます。", ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    const sub = interaction.options.getSubcommand();

    if (sub === "set") {
      const channel = interaction.options.getChannel("channel", true);
      await setBanLogChannelId(interaction.guildId, channel.id);
      await interaction.editReply(`✅ BAN通知チャンネルを <#${channel.id}> に設定しました。`);
      return;
    }

    if (sub === "clear") {
      await setBanLogChannelId(interaction.guildId, null);
      await interaction.editReply("✅ BAN通知チャンネルの設定を解除しました。");
      return;
    }

    // status
    const settings = await getGuildSettings(interaction.guildId);
    const embed = new EmbedBuilder()
      .setTitle("🔨 BAN通知設定")
      .addFields({
        name: "通知チャンネル",
        value: settings.banLogChannelId ? `<#${settings.banLogChannelId}>` : "未設定",
      })
      .setColor(settings.banLogChannelId ? 0xe74c3c : 0x95a5a6);
    await interaction.editReply({ embeds: [embed] });
  },
};
