import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import {
  getGuildSettings,
  setReturnLogChannelId,
  setReturnLogExcludedRoleIds,
} from "../lib/economy";

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
    )
    .addSubcommand((sub) =>
      sub
        .setName("exclude_add")
        .setDescription("このロールを持っているだけでは出戻りにカウントしない")
        .addRoleOption((opt) =>
          opt.setName("role").setDescription("除外するロール").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("exclude_remove")
        .setDescription("除外ロールの設定を解除する")
        .addRoleOption((opt) =>
          opt.setName("role").setDescription("解除するロール").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("exclude_list").setDescription("現在の除外ロール一覧を表示する"),
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

    if (sub === "exclude_add") {
      const role = interaction.options.getRole("role", true);
      const settings = await getGuildSettings(interaction.guildId);
      const current = settings.returnLogExcludedRoleIds
        ? settings.returnLogExcludedRoleIds.split(",").filter(Boolean)
        : [];
      if (current.includes(role.id)) {
        await interaction.editReply(`ℹ️ <@&${role.id}> はすでに除外リストに含まれています。`);
        return;
      }
      await setReturnLogExcludedRoleIds(interaction.guildId, [...current, role.id]);
      await interaction.editReply(`✅ <@&${role.id}> を除外ロールに追加しました。\nこのロールのみを持つメンバーが退出→再参加しても出戻りにカウントされません。`);
      return;
    }

    if (sub === "exclude_remove") {
      const role = interaction.options.getRole("role", true);
      const settings = await getGuildSettings(interaction.guildId);
      const current = settings.returnLogExcludedRoleIds
        ? settings.returnLogExcludedRoleIds.split(",").filter(Boolean)
        : [];
      const next = current.filter((id) => id !== role.id);
      if (next.length === current.length) {
        await interaction.editReply(`ℹ️ <@&${role.id}> は除外リストに含まれていません。`);
        return;
      }
      await setReturnLogExcludedRoleIds(interaction.guildId, next);
      await interaction.editReply(`✅ <@&${role.id}> を除外ロールから解除しました。`);
      return;
    }

    if (sub === "exclude_list") {
      const settings = await getGuildSettings(interaction.guildId);
      const ids = settings.returnLogExcludedRoleIds
        ? settings.returnLogExcludedRoleIds.split(",").filter(Boolean)
        : [];
      const embed = new EmbedBuilder()
        .setTitle("🔄 出戻りログ — 除外ロール一覧")
        .addFields({
          name: "除外ロール",
          value: ids.length === 0 ? "なし" : ids.map((id) => `<@&${id}>`).join("\n"),
        })
        .setColor(0x3498db);
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // status
    const settings = await getGuildSettings(interaction.guildId);
    const ids = settings.returnLogExcludedRoleIds
      ? settings.returnLogExcludedRoleIds.split(",").filter(Boolean)
      : [];
    const embed = new EmbedBuilder()
      .setTitle("🔄 出戻りログ設定")
      .addFields(
        {
          name: "通知チャンネル",
          value: settings.returnLogChannelId
            ? `<#${settings.returnLogChannelId}>`
            : "未設定",
        },
        {
          name: "除外ロール",
          value: ids.length === 0 ? "なし" : ids.map((id) => `<@&${id}>`).join("\n"),
        },
      )
      .setColor(settings.returnLogChannelId ? 0x3498db : 0x95a5a6);
    await interaction.editReply({ embeds: [embed] });
  },
};
