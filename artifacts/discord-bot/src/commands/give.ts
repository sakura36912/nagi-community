import { EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { grantAdminCurrency, MAX_GRANT_AMOUNT } from "../lib/adminGrant";
import { getGuildSettings } from "../lib/economy";
import { logger } from "../lib/logger";

export const giveCommand = {
  data: new SlashCommandBuilder()
    .setName("give")
    .setDescription("指定ユーザーへ通貨を付与します（管理者専用）")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addUserOption(opt => opt.setName("user").setDescription("付与先のユーザー").setRequired(true))
    .addIntegerOption(opt => opt.setName("amount").setDescription("付与する金額")
      .setRequired(true).setMinValue(1).setMaxValue(MAX_GRANT_AMOUNT)),
  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guildId || !interaction.guild) {
      await interaction.reply({ content: "サーバー内でのみ使用できます。", ephemeral: true });
      return;
    }
    // Enforce at execution too, even if Discord command permissions are overridden.
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: "このコマンドは管理者のみ使用できます。", ephemeral: true });
      return;
    }
    const target = interaction.options.getUser("user", true);
    const amount = interaction.options.getInteger("amount", true);
    if (target.bot || !Number.isSafeInteger(amount) || amount < 1 || amount > MAX_GRANT_AMOUNT) {
      await interaction.reply({
        content: target.bot ? "Botには付与できません。" : "付与額は1〜2,147,483,647の整数で指定してください。",
        ephemeral: true,
      });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const member = await interaction.guild.members.fetch(target.id).catch(() => null);
    if (!member) {
      await interaction.editReply("対象ユーザーのサーバー在籍を確認できません。付与していません。");
      return;
    }
    let result: Awaited<ReturnType<typeof grantAdminCurrency>>;
    let currencyName: string;
    try {
      ({ currencyName } = await getGuildSettings(interaction.guildId));
      result = await grantAdminCurrency(
        interaction.guildId, target.id, interaction.user.id, amount, interaction.id,
      );
    } catch (error) {
      logger.error("[give] Admin currency grant failed", error);
      await interaction.editReply(
        "通貨付与を完了できませんでした。残高上限や接続状態を確認してください。"
        + "応答が不明な場合は、再実行する前に残高・取引履歴を確認してください。",
      );
      return;
    }
    // Do not treat a Discord reply failure as a failed (already committed) credit.
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(0x2ecc71)
        .setDescription(result.duplicate
          ? "この操作は処理済みです。二重付与はしていません。"
          : `<@${target.id}> に **${amount.toLocaleString()}${currencyName}** を付与しました。`)
        .addFields({ name: "現在の残高", value: `${result.balance.toLocaleString()}${currencyName}` })],
      allowedMentions: { parse: [] },
    });
  },
};
