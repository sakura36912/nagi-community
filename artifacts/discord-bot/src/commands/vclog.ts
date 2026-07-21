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
} from "../lib/vcReward";

interface Command {
  data: SlashCommandBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

function buildInfoEmbed(categoryIds: string[], interaction: ChatInputCommandInteraction): EmbedBuilder {
  const categoryValue =
    categoryIds.length === 0
      ? "未設定（記録なし）"
      : categoryIds
          .map((id) => {
            const ch = interaction.guild?.channels.cache.get(id);
            return ch ? `• ${ch.name}` : `• <#${id}>`;
          })
          .join("\n");

  return new EmbedBuilder()
    .setTitle("📊 VC滞在ログ 設定")
    .setColor(categoryIds.length > 0 ? 0x57f287 : 0x747f8d)
    .addFields({
      name: "記録対象カテゴリー",
      value: categoryValue,
    })
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
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: "このコマンドはサーバー内でのみ使用できます。", flags: MessageFlags.Ephemeral });
      return;
    }
    const guildId = interaction.guildId;
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();

    const isAdminSub = group === "category";
    if (isAdminSub && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: "❌ このコマンドは管理者権限が必要です。", flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (group === "category" && sub === "add") {
      const ch = interaction.options.getChannel("category", true);
      const settings = await addVcLogCategory(guildId, ch.id);
      const embed = buildInfoEmbed(settings.categoryIds, interaction);
      await interaction.editReply({ content: `✅ **${ch.name}** を追加しました。`, embeds: [embed] });
      return;
    }

    if (group === "category" && sub === "remove") {
      const ch = interaction.options.getChannel("category", true);
      const settings = await removeVcLogCategory(guildId, ch.id);
      const embed = buildInfoEmbed(settings.categoryIds, interaction);
      await interaction.editReply({ content: `✅ **${ch.name}** を除外しました。`, embeds: [embed] });
      return;
    }

    // info
    const settings = await getVcLogSettings(guildId);
    const embed = buildInfoEmbed(settings.categoryIds, interaction);
    await interaction.editReply({ embeds: [embed] });
  },
};
