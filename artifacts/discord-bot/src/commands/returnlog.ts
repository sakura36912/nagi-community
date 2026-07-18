import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { getGuildSettings, setReturnLogChannelId } from "../lib/economy";

interface Command {
  data: SlashCommandBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

export const returnlogCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("returnlog")
    .setDescription("出戻りログチャンネルの設定")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("出戻り通知を送るチャンネルを設定する")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("出戻り通知先のテキストチャンネル")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("clear").setDescription("出戻り通知を無効化する"),
    )
    .addSubcommand((sub) =>
      sub.setName("status").setDescription("現在の出戻りログ設定を確認する"),
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
      await setReturnLogChannelId(interaction.guildId, channel.id);
      await interaction.editReply(`✅ 出戻りログチャンネルを <#${channel.id}> に設定しました。`);
      return;
    }

    if (sub === "clear") {
      await setReturnLogChannelId(interaction.guildId, null);
      await interaction.editReply("✅ 出戻りログチャンネルの設定を解除しました。");
      return;
    }

    // status
    const settings = await getGuildSettings(interaction.guildId);
    const embed = new EmbedBuilder()
      .setTitle("🔄 出戻りログ設定")
      .addFields({
        name: "通知チャンネル",
        value: settings.returnLogChannelId
          ? `<#${settings.returnLogChannelId}>`
          : "未設定",
      })
      .setColor(settings.returnLogChannelId ? 0x3498db : 0x95a5a6);
    await interaction.editReply({ embeds: [embed] });
  },
};
