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
  setPromotionLogSettings,
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
    // ── 再加入通知チャンネル ──────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("再加入時の通知チャンネルを設定する")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("通知先テキストチャンネル")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("clear").setDescription("再加入通知を無効化する"),
    )
    // ── 昇格通知（入門前ロール外れ） ────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("promotion_set")
        .setDescription("入門前ロールが外れた際の昇格通知を設定する")
        .addRoleOption((opt) =>
          opt
            .setName("watch_role")
            .setDescription("監視する入門前ロール（これが外れると通知）")
            .setRequired(true),
        )
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("昇格通知先チャンネル（省略で再加入通知チャンネルと共用）")
            .addChannelTypes(ChannelType.GuildText),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("promotion_clear").setDescription("昇格通知を無効化する"),
    )
    // ── 除外ロール ───────────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("exclude_add")
        .setDescription("このロールのみ保持での退出→再参加は出戻りにカウントしない")
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
    )
    // ── 確認 ────────────────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub.setName("status").setDescription("現在の出戻りログ設定をすべて確認する"),
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: "サーバー内でのみ使用できます。", ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const guildId = interaction.guildId;
    const sub = interaction.options.getSubcommand();

    // ── 再加入通知チャンネル ────────────────────────────────────────────────
    if (sub === "set") {
      const channel = interaction.options.getChannel("channel", true);
      await setReturnLogChannelId(guildId, channel.id);
      await interaction.editReply(`✅ 再加入通知チャンネルを <#${channel.id}> に設定しました。`);
      return;
    }

    if (sub === "clear") {
      await setReturnLogChannelId(guildId, null);
      await interaction.editReply("✅ 再加入通知を無効化しました。");
      return;
    }

    // ── 昇格通知 ────────────────────────────────────────────────────────────
    if (sub === "promotion_set") {
      const watchRole = interaction.options.getRole("watch_role", true);
      const channel = interaction.options.getChannel("channel");
      const settings = await getGuildSettings(guildId);
      const channelId = channel?.id ?? settings.returnLogChannelId ?? null;
      if (!channelId) {
        await interaction.editReply("❌ 通知先チャンネルを指定するか、先に `/returnlog set` で再加入通知チャンネルを設定してください。");
        return;
      }
      await setPromotionLogSettings(guildId, channelId, watchRole.id);
      await interaction.editReply(
        `✅ 昇格通知を設定しました。\n` +
        `監視ロール: <@&${watchRole.id}>\n` +
        `通知チャンネル: <#${channelId}>`,
      );
      return;
    }

    if (sub === "promotion_clear") {
      await setPromotionLogSettings(guildId, null, null);
      await interaction.editReply("✅ 昇格通知を無効化しました。");
      return;
    }

    // ── 除外ロール ───────────────────────────────────────────────────────────
    if (sub === "exclude_add") {
      const role = interaction.options.getRole("role", true);
      const settings = await getGuildSettings(guildId);
      const current = settings.returnLogExcludedRoleIds
        ? settings.returnLogExcludedRoleIds.split(",").filter(Boolean)
        : [];
      if (current.includes(role.id)) {
        await interaction.editReply(`ℹ️ <@&${role.id}> はすでに除外リストに含まれています。`);
        return;
      }
      await setReturnLogExcludedRoleIds(guildId, [...current, role.id]);
      await interaction.editReply(`✅ <@&${role.id}> を除外ロールに追加しました。`);
      return;
    }

    if (sub === "exclude_remove") {
      const role = interaction.options.getRole("role", true);
      const settings = await getGuildSettings(guildId);
      const current = settings.returnLogExcludedRoleIds
        ? settings.returnLogExcludedRoleIds.split(",").filter(Boolean)
        : [];
      const next = current.filter((id) => id !== role.id);
      if (next.length === current.length) {
        await interaction.editReply(`ℹ️ <@&${role.id}> は除外リストに含まれていません。`);
        return;
      }
      await setReturnLogExcludedRoleIds(guildId, next);
      await interaction.editReply(`✅ <@&${role.id}> を除外ロールから解除しました。`);
      return;
    }

    if (sub === "exclude_list") {
      const settings = await getGuildSettings(guildId);
      const ids = settings.returnLogExcludedRoleIds
        ? settings.returnLogExcludedRoleIds.split(",").filter(Boolean)
        : [];
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle("🔄 出戻りログ — 除外ロール")
            .addFields({ name: "除外ロール", value: ids.length ? ids.map((id) => `<@&${id}>`).join("\n") : "なし" })
            .setColor(0x3498db),
        ],
      });
      return;
    }

    // ── status ───────────────────────────────────────────────────────────────
    const settings = await getGuildSettings(guildId);
    const excludedIds = settings.returnLogExcludedRoleIds
      ? settings.returnLogExcludedRoleIds.split(",").filter(Boolean)
      : [];

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("🔄 出戻りログ設定")
          .addFields(
            {
              name: "再加入通知チャンネル",
              value: settings.returnLogChannelId ? `<#${settings.returnLogChannelId}>` : "未設定",
            },
            {
              name: "昇格通知（入門前ロール外れ）",
              value: settings.promotionWatchRoleId
                ? `監視ロール: <@&${settings.promotionWatchRoleId}>\n通知先: ${settings.promotionLogChannelId ? `<#${settings.promotionLogChannelId}>` : "未設定"}`
                : "無効",
            },
            {
              name: "除外ロール（カウントしない）",
              value: excludedIds.length ? excludedIds.map((id) => `<@&${id}>`).join("\n") : "なし",
            },
          )
          .setColor(settings.returnLogChannelId || settings.promotionWatchRoleId ? 0x3498db : 0x95a5a6),
      ],
    });
  },
};
