import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { setLeaveLogChannelId, getGuildSettings } from "../lib/economy";

interface Command {
  data: SlashCommandBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

export const leavelogCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("leavelog")
    .setDescription("退出ログの設定")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("メンバー退出時の通知チャンネルを設定する")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("通知先テキストチャンネル")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("clear").setDescription("退出通知を無効化する"),
    )
    .addSubcommand((sub) =>
      sub.setName("status").setDescription("現在の退出ログ設定を確認する"),
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
      await setLeaveLogChannelId(guildId, channel.id);
      await interaction.editReply(`✅ 退出通知チャンネルを <#${channel.id}> に設定しました。`);
      return;
    }

    if (sub === "clear") {
      await setLeaveLogChannelId(guildId, null);
      await interaction.editReply("✅ 退出通知を無効化しました。");
      return;
    }

    // status
    const settings = await getGuildSettings(guildId);
    await interaction.editReply(
      settings.leaveLogChannelId
        ? `📋 退出通知チャンネル: <#${settings.leaveLogChannelId}>`
        : "📋 退出通知は現在無効です。`/leavelog set` で設定してください。",
    );
  },
};
