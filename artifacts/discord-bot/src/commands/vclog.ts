import {
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import {
  getVcLogSettings,
  addVcLogCategory,
  removeVcLogCategory,
  setVcLogNotifyChannel,
} from "../lib/vcReward";

interface Command {
  data: SlashCommandBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

function buildInfoEmbed(
  categoryIds: string[],
  notifyChannelId: string | null | undefined,
  interaction: ChatInputCommandInteraction,
): EmbedBuilder {
  const categoryValue =
    categoryIds.length === 0
      ? "未設定（記録なし）"
      : categoryIds
          .map((id) => {
            const ch = interaction.guild?.channels.cache.get(id);
            return ch ? `• ${ch.name}` : `• <#${id}>`;
          })
          .join("\n");

  const notifyValue = notifyChannelId ? `<#${notifyChannelId}>` : "未設定（通知なし）";

  return new EmbedBuilder()
    .setTitle("📊 VC滞在ログ 設定")
    .setColor(categoryIds.length > 0 ? 0x57f287 : 0x747f8d)
    .addFields(
      { name: "記録対象カテゴリー", value: categoryValue },
      { name: "入退室通知チャンネル", value: notifyValue },
    )
    .setFooter({
      text: categoryIds.length > 0
        ? "指定カテゴリー内のVCのみ滞在時間を記録します"
        : "カテゴリーを追加すると記録が開始されます",
    });
}

export const vclogCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("vclog")
    .setDescription("VC滞在時間ログの設定")
    .setDefaultMemberPermissions(0)
    .addSubcommand((sub) =>
      sub.setName("info").setDescription("現在の設定を確認する"),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("category")
        .setDescription("記録対象カテゴリーの管理（管理者）")
        .addSubcommand((sub) =>
          sub
            .setName("add")
            .setDescription("記録対象カテゴリーを追加する")
            .addChannelOption((opt) =>
              opt
                .setName("category")
                .setDescription("追加するカテゴリー")
                .addChannelTypes(ChannelType.GuildCategory)
                .setRequired(true),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("remove")
            .setDescription("記録対象カテゴリーを除外する")
            .addChannelOption((opt) =>
              opt
                .setName("category")
                .setDescription("除外するカテゴリー")
                .addChannelTypes(ChannelType.GuildCategory)
                .setRequired(true),
            ),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("channel")
        .setDescription("入退室通知チャンネルの設定（管理者）")
        .addSubcommand((sub) =>
          sub
            .setName("set")
            .setDescription("入退室通知を送るチャンネルを設定する")
            .addChannelOption((opt) =>
              opt
                .setName("channel")
                .setDescription("通知先テキストチャンネル")
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true),
            ),
        )
        .addSubcommand((sub) =>
          sub.setName("remove").setDescription("入退室通知チャンネルの設定を解除する"),
        ),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: "このコマンドはサーバー内でのみ使用できます。", flags: MessageFlags.Ephemeral });
      return;
    }
    const guildId = interaction.guildId;
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (group === "category" && sub === "add") {
      const ch = interaction.options.getChannel("category", true);
      const settings = await addVcLogCategory(guildId, ch.id);
      const embed = buildInfoEmbed(settings.categoryIds, settings.notifyChannelId, interaction);
      await interaction.editReply({ content: `✅ **${ch.name}** を追加しました。`, embeds: [embed] });
      return;
    }

    if (group === "category" && sub === "remove") {
      const ch = interaction.options.getChannel("category", true);
      const settings = await removeVcLogCategory(guildId, ch.id);
      const embed = buildInfoEmbed(settings.categoryIds, settings.notifyChannelId, interaction);
      await interaction.editReply({ content: `✅ **${ch.name}** を除外しました。`, embeds: [embed] });
      return;
    }

    if (group === "channel" && sub === "set") {
      const ch = interaction.options.getChannel("channel", true);
      const settings = await setVcLogNotifyChannel(guildId, ch.id);
      const embed = buildInfoEmbed(settings.categoryIds, settings.notifyChannelId, interaction);
      await interaction.editReply({ content: `✅ 入退室通知チャンネルを <#${ch.id}> に設定しました。`, embeds: [embed] });
      return;
    }

    if (group === "channel" && sub === "remove") {
      const settings = await setVcLogNotifyChannel(guildId, null);
      const embed = buildInfoEmbed(settings.categoryIds, settings.notifyChannelId, interaction);
      await interaction.editReply({ content: "✅ 入退室通知チャンネルの設定を解除しました。", embeds: [embed] });
      return;
    }

    // info
    const settings = await getVcLogSettings(guildId);
    const embed = buildInfoEmbed(settings.categoryIds, settings.notifyChannelId, interaction);
    await interaction.editReply({ embeds: [embed] });
  },
};
