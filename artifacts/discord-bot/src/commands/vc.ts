import {
  ChannelType,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { createVcSchedule, cancelVcSchedule, listVcSchedules, formatDuration } from "../lib/vc";

export const vcCommand = {
  data: new SlashCommandBuilder()
    .setName("vc")
    .setDescription("ボイスチャンネルを期間付きでリネームし、期間終了後に自動削除します")
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("VCをリネームして自動削除をスケジュールします(管理者用)")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("対象のボイスチャンネル")
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice),
        )
        .addStringOption((opt) =>
          opt.setName("name").setDescription("新しいチャンネル名").setRequired(true).setMaxLength(100),
        )
        .addIntegerOption((opt) =>
          opt.setName("days").setDescription("日数").setRequired(false).setMinValue(0),
        )
        .addIntegerOption((opt) =>
          opt.setName("hours").setDescription("時間").setRequired(false).setMinValue(0),
        )
        .addIntegerOption((opt) =>
          opt.setName("minutes").setDescription("分").setRequired(false).setMinValue(1),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("list")
        .setDescription("スケジュール済みのVC一覧を表示します"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("cancel")
        .setDescription("VCの自動削除をキャンセルし、元の名前に戻します(管理者用)")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("キャンセルするボイスチャンネル")
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice),
        ),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({ content: "このコマンドはサーバー内でのみ使用できます。", ephemeral: true });
      return;
    }

    const member = await interaction.guild!.members.fetch(interaction.user.id);
    const isAdmin = member.permissions.has("ManageChannels");

    const sub = interaction.options.getSubcommand();

    // ── /vc list ──────────────────────────────────────────────────────────────
    if (sub === "list") {
      const schedules = await listVcSchedules(interaction.guildId);
      if (schedules.length === 0) {
        await interaction.reply({ content: "スケジュール済みのVCはありません。", ephemeral: true });
        return;
      }

      const now = Date.now();
      const lines = schedules.map((s) => {
        const remaining = s.scheduledDeleteAt.getTime() - now;
        const remainingLabel = remaining > 0 ? `残り ${formatDuration(remaining)}` : "まもなく削除";
        return `**${s.newName}** (<#${s.channelId}>) — <t:${Math.floor(s.scheduledDeleteAt.getTime() / 1000)}:F> (${remainingLabel})`;
      });

      await interaction.reply({
        content: `## 🕐 VC自動削除スケジュール(${schedules.length}件)\n${lines.join("\n")}`,
        ephemeral: true,
      });
      return;
    }

    // ── 管理者チェック ────────────────────────────────────────────────────────
    if (!isAdmin) {
      await interaction.reply({ content: "このコマンドはチャンネル管理権限が必要です。", ephemeral: true });
      return;
    }

    // ── /vc set ───────────────────────────────────────────────────────────────
    if (sub === "set") {
      const channel = interaction.options.getChannel("channel", true);
      const newName = interaction.options.getString("name", true).trim();
      const days = interaction.options.getInteger("days") ?? 0;
      const hours = interaction.options.getInteger("hours") ?? 0;
      const minutes = interaction.options.getInteger("minutes") ?? 0;

      const totalMs = (days * 24 * 60 + hours * 60 + minutes) * 60 * 1000;
      if (totalMs <= 0) {
        await interaction.reply({ content: "日数・時間・分のいずれかを1以上指定してください。", ephemeral: true });
        return;
      }

      // Fetch the full channel object to rename it.
      const guildChannel = await interaction.guild!.channels.fetch(channel.id);
      if (!guildChannel || !guildChannel.isVoiceBased()) {
        await interaction.reply({ content: "指定されたチャンネルが見つかりません。", ephemeral: true });
        return;
      }

      const originalName = guildChannel.name;
      const scheduledDeleteAt = new Date(Date.now() + totalMs);

      // Rename immediately.
      await guildChannel.setName(newName, `/vc set by ${interaction.user.tag}`);

      // Persist the schedule.
      await createVcSchedule(
        interaction.guildId,
        channel.id,
        newName,
        originalName,
        scheduledDeleteAt,
        interaction.user.id,
      );

      const unixTs = Math.floor(scheduledDeleteAt.getTime() / 1000);
      await interaction.reply(
        `✅ <#${channel.id}> を **${newName}** にリネームしました。\n🗑️ 自動削除: <t:${unixTs}:F>（<t:${unixTs}:R>）`,
      );
      return;
    }

    // ── /vc cancel ────────────────────────────────────────────────────────────
    if (sub === "cancel") {
      const channel = interaction.options.getChannel("channel", true);
      const schedule = await cancelVcSchedule(interaction.guildId, channel.id);

      if (!schedule) {
        await interaction.reply({ content: "そのチャンネルにはスケジュールが設定されていません。", ephemeral: true });
        return;
      }

      // Restore the original name.
      try {
        const guildChannel = await interaction.guild!.channels.fetch(channel.id);
        if (guildChannel?.isVoiceBased()) {
          await guildChannel.setName(schedule.originalName, `/vc cancel by ${interaction.user.tag}`);
        }
      } catch {
        // Channel may have been deleted manually — ignore.
      }

      await interaction.reply(
        `✅ <#${channel.id}> の自動削除をキャンセルし、名前を **${schedule.originalName}** に戻しました。`,
      );
    }
  },
};
