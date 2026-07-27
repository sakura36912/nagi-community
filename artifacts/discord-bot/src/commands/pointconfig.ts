import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import {
  listVcCategoryConfigs,
  upsertVcCategoryConfig,
  removeVcCategoryConfig,
  listRoleConfigs,
  upsertRoleConfig,
  removeRoleConfig,
  listRankConfigs,
  upsertRankConfig,
  removeRankConfig,
  setBoostPoints,
  getOrCreatePointSettings,
  awardEventRankPoints,
  addPoints,
} from "../lib/points";
import { logger } from "../lib/logger";

interface Command {
  data: SlashCommandBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

export const pointconfigCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("pointconfig")
    .setDescription("ポイントシステムの設定（管理者専用）")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

    // ── VC カテゴリー ──────────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("vc-add")
        .setDescription("特定カテゴリーのVC浮上時間に対するポイントレートを設定する")
        .addChannelOption((opt) =>
          opt
            .setName("category")
            .setDescription("対象のカテゴリーチャンネル")
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(true),
        )
        .addIntegerOption((opt) =>
          opt.setName("rate").setDescription("1時間あたりのポイント数").setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("vc-remove")
        .setDescription("VCカテゴリーのポイント設定を削除する")
        .addChannelOption((opt) =>
          opt
            .setName("category")
            .setDescription("削除するカテゴリーチャンネル")
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("vc-list").setDescription("VCカテゴリーのポイント設定一覧を表示する"),
    )

    // ── ロール ─────────────────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("role-add")
        .setDescription("特定ロール保持者への1日あたりのポイント数を設定する")
        .addRoleOption((opt) =>
          opt.setName("role").setDescription("対象ロール").setRequired(true),
        )
        .addIntegerOption((opt) =>
          opt.setName("points").setDescription("1日あたりのポイント数").setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("role-remove")
        .setDescription("ロールのポイント設定を削除する")
        .addRoleOption((opt) =>
          opt.setName("role").setDescription("削除するロール").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("role-list").setDescription("ロールのポイント設定一覧を表示する"),
    )

    // ── ブースト ───────────────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("boost")
        .setDescription("サーバーブースト時に付与するポイント数を設定する")
        .addIntegerOption((opt) =>
          opt.setName("points").setDescription("ブースト開始時に付与するポイント（0で無効）").setRequired(true).setMinValue(0),
        ),
    )

    // ── イベントランク ─────────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("rank-set")
        .setDescription("イベント順位ごとのポイント数を設定する")
        .addIntegerOption((opt) =>
          opt.setName("rank").setDescription("順位（1, 2, 3 …）").setRequired(true).setMinValue(1),
        )
        .addIntegerOption((opt) =>
          opt.setName("points").setDescription("付与するポイント数").setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("rank-remove")
        .setDescription("イベント順位のポイント設定を削除する")
        .addIntegerOption((opt) =>
          opt.setName("rank").setDescription("削除する順位").setRequired(true).setMinValue(1),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("rank-list").setDescription("イベント順位のポイント設定一覧を表示する"),
    )

    // ── イベント結果付与 ───────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("event-award")
        .setDescription("イベント結果に基づいてポイントを付与する")
        .addIntegerOption((opt) =>
          opt.setName("rank").setDescription("順位").setRequired(true).setMinValue(1),
        )
        .addUserOption((opt) =>
          opt.setName("user").setDescription("付与するユーザー").setRequired(true),
        ),
    )

    // ── 手動付与 ───────────────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("give")
        .setDescription("ユーザーにポイントを手動付与する")
        .addUserOption((opt) =>
          opt.setName("user").setDescription("対象ユーザー").setRequired(true),
        )
        .addIntegerOption((opt) =>
          opt.setName("points").setDescription("付与するポイント数").setRequired(true).setMinValue(1),
        )
        .addStringOption((opt) =>
          opt.setName("reason").setDescription("理由").setRequired(false).setMaxLength(100),
        ),
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: "サーバー内でのみ使用できます。", ephemeral: true });
      return;
    }
    const guildId = interaction.guildId;
    const sub = interaction.options.getSubcommand();

    await interaction.deferReply({ ephemeral: true });

    // ── vc-add ────────────────────────────────────────────────────────────────
    if (sub === "vc-add") {
      const cat  = interaction.options.getChannel("category", true);
      const rate = interaction.options.getInteger("rate", true);
      await upsertVcCategoryConfig(guildId, cat.id, rate);
      await interaction.editReply(`✅ **${cat.name}** カテゴリーのVCポイントレートを **${rate}pt/時間** に設定しました。`);
      return;
    }

    // ── vc-remove ─────────────────────────────────────────────────────────────
    if (sub === "vc-remove") {
      const cat = interaction.options.getChannel("category", true);
      const ok  = await removeVcCategoryConfig(guildId, cat.id);
      await interaction.editReply(ok ? `✅ **${cat.name}** のVCポイント設定を削除しました。` : `❌ 設定が見つかりません。`);
      return;
    }

    // ── vc-list ───────────────────────────────────────────────────────────────
    if (sub === "vc-list") {
      const configs = await listVcCategoryConfigs(guildId);
      const embed = new EmbedBuilder().setTitle("🎙️ VCカテゴリーポイント設定").setColor(0x5865f2);
      if (configs.length === 0) {
        embed.setDescription("設定なし。`/pointconfig vc-add` で追加してください。");
      } else {
        embed.addFields(
          configs.map((c) => ({
            name: `<#${c.categoryId}>`,
            value: `**${c.pointsPerHour}** pt/時間`,
            inline: true,
          })),
        );
      }
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── role-add ──────────────────────────────────────────────────────────────
    if (sub === "role-add") {
      const role   = interaction.options.getRole("role", true);
      const points = interaction.options.getInteger("points", true);
      await upsertRoleConfig(guildId, role.id, points);
      await interaction.editReply(`✅ <@&${role.id}> 保持者に **${points}pt/日** を付与するよう設定しました。`);
      return;
    }

    // ── role-remove ───────────────────────────────────────────────────────────
    if (sub === "role-remove") {
      const role = interaction.options.getRole("role", true);
      const ok   = await removeRoleConfig(guildId, role.id);
      await interaction.editReply(ok ? `✅ <@&${role.id}> のポイント設定を削除しました。` : `❌ 設定が見つかりません。`);
      return;
    }

    // ── role-list ─────────────────────────────────────────────────────────────
    if (sub === "role-list") {
      const configs = await listRoleConfigs(guildId);
      const embed = new EmbedBuilder().setTitle("🎭 ロールポイント設定").setColor(0x5865f2);
      if (configs.length === 0) {
        embed.setDescription("設定なし。`/pointconfig role-add` で追加してください。");
      } else {
        embed.addFields(
          configs.map((c) => ({
            name: `<@&${c.roleId}>`,
            value: `**${c.pointsPerDay}** pt/日`,
            inline: true,
          })),
        );
      }
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── boost ─────────────────────────────────────────────────────────────────
    if (sub === "boost") {
      const points = interaction.options.getInteger("points", true);
      await setBoostPoints(guildId, points);
      await interaction.editReply(
        points > 0
          ? `✅ サーバーブースト時に **${points}pt** を付与するよう設定しました。`
          : "✅ サーバーブーストのポイント付与を無効にしました。",
      );
      return;
    }

    // ── rank-set ──────────────────────────────────────────────────────────────
    if (sub === "rank-set") {
      const rank   = interaction.options.getInteger("rank", true);
      const points = interaction.options.getInteger("points", true);
      await upsertRankConfig(guildId, rank, points);
      await interaction.editReply(`✅ イベント **${rank}位** に **${points}pt** を設定しました。`);
      return;
    }

    // ── rank-remove ───────────────────────────────────────────────────────────
    if (sub === "rank-remove") {
      const rank = interaction.options.getInteger("rank", true);
      const ok   = await removeRankConfig(guildId, rank);
      await interaction.editReply(ok ? `✅ ${rank}位のポイント設定を削除しました。` : `❌ 設定が見つかりません。`);
      return;
    }

    // ── rank-list ─────────────────────────────────────────────────────────────
    if (sub === "rank-list") {
      const configs = await listRankConfigs(guildId);
      const embed = new EmbedBuilder().setTitle("🏆 イベント順位ポイント設定").setColor(0xf39c12);
      if (configs.length === 0) {
        embed.setDescription("設定なし。`/pointconfig rank-set` で追加してください。");
      } else {
        const medals = ["🥇", "🥈", "🥉"];
        embed.addFields(
          configs
            .sort((a, b) => a.rank - b.rank)
            .map((c) => ({
              name: `${medals[c.rank - 1] ?? `${c.rank}位`}`,
              value: `**${c.points}** pt`,
              inline: true,
            })),
        );
      }
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── event-award ───────────────────────────────────────────────────────────
    if (sub === "event-award") {
      const rank   = interaction.options.getInteger("rank", true);
      const target = interaction.options.getUser("user", true);
      const earned = await awardEventRankPoints(guildId, target.id, rank);
      if (earned === 0) {
        await interaction.editReply(`❌ ${rank}位のポイント設定がありません。先に \`/pointconfig rank-set\` で設定してください。`);
      } else {
        await interaction.editReply(`✅ <@${target.id}> にイベント ${rank}位として **${earned}pt** を付与しました。`);
        logger.info(`[points] event-award rank=${rank} user=${target.id} earned=${earned}`);
      }
      return;
    }

    // ── give ──────────────────────────────────────────────────────────────────
    if (sub === "give") {
      const target = interaction.options.getUser("user", true);
      const points = interaction.options.getInteger("points", true);
      const reason = interaction.options.getString("reason") ?? "管理者による手動付与";
      await addPoints(guildId, target.id, points, "manual", reason);
      await interaction.editReply(`✅ <@${target.id}> に **${points}pt** を付与しました。`);
      return;
    }
  },
};
