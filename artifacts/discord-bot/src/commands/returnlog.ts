import {
  ChannelType,
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
    .setDescription("出戻りログの設定")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("出戻りログの送信先を設定する")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("送信先テキストチャンネル")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("clear").setDescription("出戻りログを無効化する"),
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
    const guildId = interaction.guildId;
    const sub = interaction.options.getSubcommand();

    if (sub === "set") {
      const channel = interaction.options.getChannel("channel", true);
      await setReturnLogChannelId(guildId, channel.id);
      await interaction.editReply(`✅ 出戻りログの送信先を <#${channel.id}> に設定しました。`);
      return;
    }

    if (sub === "clear") {
      await setReturnLogChannelId(guildId, null);
      await interaction.editReply("✅ 出戻りログを無効化しました。");
      return;
    }

    const settings = await getGuildSettings(guildId);
    await interaction.editReply(
      settings.returnLogChannelId
        ? `📋 出戻りログの送信先: <#${settings.returnLogChannelId}>`
        : "📋 出戻りログは現在無効です。`/returnlog set` で設定してください。",
    );
  },
};