/**
 * /evalsheet — 評価シート設定コマンド（管理者専用）
 *
 *   setup           : フォーラム・トリガーロール・評価期間日数を設定
 *   roster-category : 自己紹介検索カテゴリを設定（省略で解除）
 *   nameboard       : 名簿URLを設定（省略で解除）
 *   info            : 現在の設定を表示
 */

import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import {
  getEvalSheetSettings,
  setEvalSheetForumConfig,
  setEvalNameboardUrl,
  setRosterCategoryId,
} from "../lib/economy";

export const evalsheetCommand = {
  data: new SlashCommandBuilder()
    .setName("evalsheet")
    .setDescription("評価シートの設定を管理します（管理者）")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)

    // ── setup ───────────────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("setup")
        .setDescription(
          "評価シートのフォーラム・トリガーロール・評価期間を設定します",
        )
        .addChannelOption((opt) =>
          opt
            .setName("forum")
            .setDescription("評価シートを投稿するフォーラムチャンネル")
            .addChannelTypes(ChannelType.GuildForum)
            .setRequired(true),
        )
        .addRoleOption((opt) =>
          opt
            .setName("role1")
            .setDescription("評価シートを自動作成するトリガーロール（1つ目）")
            .setRequired(true),
        )
        .addRoleOption((opt) =>
          opt
            .setName("role2")
            .setDescription("トリガーロール（2つ目）")
            .setRequired(false),
        )
        .addRoleOption((opt) =>
          opt
            .setName("role3")
            .setDescription("トリガーロール（3つ目）")
            .setRequired(false),
        )
        .addRoleOption((opt) =>
          opt
            .setName("role4")
            .setDescription("トリガーロール（4つ目）")
            .setRequired(false),
        )
        .addRoleOption((opt) =>
          opt
            .setName("role5")
            .setDescription("トリガーロール（5つ目）")
            .setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("period_days")
            .setDescription("評価期間の日数（デフォルト: 14）")
            .setMinValue(1)
            .setMaxValue(365)
            .setRequired(false),
        ),
    )

    // ── roster-category ─────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("roster-category")
        .setDescription(
          "自己紹介を検索するカテゴリを設定します（省略すると設定を解除）",
        )
        .addChannelOption((opt) =>
          opt
            .setName("category")
            .setDescription("自己紹介チャンネルが置かれているカテゴリ")
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(false),
        ),
    )

    // ── nameboard ───────────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("nameboard")
        .setDescription("名簿URLを設定します（省略すると設定を解除）")
        .addStringOption((opt) =>
          opt
            .setName("url")
            .setDescription("名簿へのURL")
            .setMaxLength(512)
            .setRequired(false),
        ),
    )

    // ── info ────────────────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("info")
        .setDescription("現在の評価シート設定を表示します"),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({
        content: "このコマンドはサーバー内でのみ使用できます。",
        ephemeral: true,
      });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "このコマンドを使用するには ManageGuild 権限が必要です。",
        ephemeral: true,
      });
      return;
    }

    const sub = interaction.options.getSubcommand();

    // ── setup ─────────────────────────────────────────────────────────────
    if (sub === "setup") {
      const forum      = interaction.options.getChannel("forum", true);
      const role1      = interaction.options.getRole("role1", true);
      const role2      = interaction.options.getRole("role2");
      const role3      = interaction.options.getRole("role3");
      const role4      = interaction.options.getRole("role4");
      const role5      = interaction.options.getRole("role5");
      const periodDays = interaction.options.getInteger("period_days") ?? 14;

      const roleIds = [role1, role2, role3, role4, role5]
        .filter((r): r is NonNullable<typeof r> => r !== null)
        .map((r) => r.id);

      await setEvalSheetForumConfig(
        interaction.guildId,
        forum.id,
        roleIds,
        periodDays,
      );

      const roleDisplay = roleIds.map((id) => `<@&${id}>`).join("、");
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("✅ 評価シート設定を更新しました")
            .setColor(0x57f287)
            .addFields(
              { name: "フォーラム", value: `<#${forum.id}>`, inline: true },
              { name: "評価期間", value: `${periodDays} 日`, inline: true },
              { name: "トリガーロール", value: roleDisplay, inline: false },
            ),
        ],
        ephemeral: true,
      });
      return;
    }

    // ── roster-category ───────────────────────────────────────────────────
    if (sub === "roster-category") {
      const category = interaction.options.getChannel("category");
      await setRosterCategoryId(interaction.guildId, category?.id ?? null);
      await interaction.reply({
        content: category
          ? `✅ 自己紹介検索カテゴリを <#${category.id}> に設定しました。`
          : "✅ 自己紹介検索カテゴリの設定を解除しました。",
        ephemeral: true,
      });
      return;
    }

    // ── nameboard ─────────────────────────────────────────────────────────
    if (sub === "nameboard") {
      const url = interaction.options.getString("url")?.trim() || null;
      await setEvalNameboardUrl(interaction.guildId, url);
      await interaction.reply({
        content: url
          ? `✅ 名簿URLを設定しました: ${url}`
          : "✅ 名簿URLの設定を解除しました。",
        ephemeral: true,
      });
      return;
    }

    // ── info ──────────────────────────────────────────────────────────────
    if (sub === "info") {
      const settings = await getEvalSheetSettings(interaction.guildId);
      if (!settings) {
        await interaction.reply({
          content:
            "評価シートの設定がまだありません。`/evalsheet setup` で設定してください。",
          ephemeral: true,
        });
        return;
      }

      const triggerIds = settings.triggerRoleIds
        ?.split(",")
        .map((r) => r.trim())
        .filter(Boolean) ?? [];

      const roleDisplay =
        triggerIds.length > 0
          ? triggerIds.map((id) => `<@&${id}>`).join("、")
          : "未設定";

      const embed = new EmbedBuilder()
        .setTitle("📋 評価シート設定")
        .setColor(0x5865f2)
        .addFields(
          {
            name: "フォーラム",
            value: settings.forumChannelId
              ? `<#${settings.forumChannelId}>`
              : "未設定",
            inline: true,
          },
          {
            name: "評価期間",
            value: `${settings.evalPeriodDays ?? 14} 日`,
            inline: true,
          },
          {
            name: "トリガーロール",
            value: roleDisplay,
            inline: false,
          },
          {
            name: "自己紹介カテゴリ",
            value: settings.rosterCategoryId
              ? `<#${settings.rosterCategoryId}>`
              : "未設定",
            inline: true,
          },
          {
            name: "名簿URL",
            value: settings.nameboardUrl
              ? `[リンク](${settings.nameboardUrl})`
              : "未設定",
            inline: true,
          },
        )
        .setTimestamp(settings.updatedAt);

      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
  },
};
