import {
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type User,
} from "discord.js";
import {
  createEvalSheet,
  deleteEvalSheet,
  getLatestEvalSheet,
  getEvalSheetSettings,
  getSheetVcSeconds,
  listEvalSheets,
} from "../lib/economy";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseDate(s: string): Date | null {
  const d = new Date(`${s}T00:00:00Z`);
  return isNaN(d.getTime()) ? null : d;
}

function formatSeconds(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return [h > 0 ? `${h}時間` : "", m > 0 ? `${m}分` : "", s > 0 ? `${s}秒` : ""]
    .filter(Boolean)
    .join("") || "0秒";
}

function buildSheetEmbed(opts: {
  targetUser: User;
  displayName: string;
  startDate: Date;
  endDate: Date;
  vcSeconds: number;
  nameboardUrl: string | null | undefined;
  createdByLabel: string;
}): EmbedBuilder {
  const { targetUser, displayName, startDate, endDate, vcSeconds, nameboardUrl, createdByLabel } = opts;
  const startTs = Math.floor(startDate.getTime() / 1000);
  const endTs = Math.floor(endDate.getTime() / 1000);
  const nameboardValue = nameboardUrl ? `[名簿を見る](${nameboardUrl})` : "未設定";

  return new EmbedBuilder()
    .setTitle(`📋 評価シート — ${displayName}`)
    .setColor(0x2ecc71)
    .setThumbnail(targetUser.displayAvatarURL())
    .addFields(
      { name: "👤 メンバー", value: `${displayName}（<@${targetUser.id}>）`, inline: false },
      { name: "📋 名簿", value: nameboardValue, inline: false },
      { name: "📅 評価開始", value: `<t:${startTs}:D>`, inline: true },
      { name: "⏰ 評価終了", value: `<t:${endTs}:D>`, inline: true },
      { name: "🎙️ 期間中のVC滞在時間", value: formatSeconds(vcSeconds), inline: false },
    )
    .setFooter({ text: createdByLabel })
    .setTimestamp();
}

// ─── Command ─────────────────────────────────────────────────────────────────

export const sheetCommand = {
  data: new SlashCommandBuilder()
    .setName("sheet")
    .setDescription("評価シートの管理")
    .addSubcommand((sub) =>
      sub
        .setName("create")
        .setDescription("評価シートを作成します（管理者）")
        .addUserOption((opt) =>
          opt.setName("member").setDescription("評価対象のメンバー").setRequired(true),
        )
        .addStringOption((opt) =>
          opt.setName("start").setDescription("評価開始日（YYYY-MM-DD）").setRequired(true),
        )
        .addStringOption((opt) =>
          opt.setName("end").setDescription("評価終了日（YYYY-MM-DD）").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("評価シートの一覧を表示します"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("delete")
        .setDescription("メンバーの評価シートを削除します（管理者）")
        .addUserOption((opt) =>
          opt.setName("member").setDescription("削除対象のメンバー").setRequired(true),
        ),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ content: "このコマンドはサーバー内でのみ使用できます。", ephemeral: true });
      return;
    }

    const sub = interaction.options.getSubcommand();
    const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;

    // ── create ──────────────────────────────────────────────────────────────
    if (sub === "create") {
      if (!isAdmin) {
        await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
        return;
      }
      await interaction.deferReply();

      const targetUser = interaction.options.getUser("member", true);
      const startStr = interaction.options.getString("start", true);
      const endStr = interaction.options.getString("end", true);

      const startDate = parseDate(startStr);
      const endDate = parseDate(endStr);
      if (!startDate || !endDate) {
        await interaction.editReply("日付の形式が正しくありません。例: `2025-01-01`");
        return;
      }
      if (endDate <= startDate) {
        await interaction.editReply("終了日は開始日より後にしてください。");
        return;
      }

      let member = null;
      try { member = await interaction.guild!.members.fetch(targetUser.id); } catch { /* ignore */ }
      const displayName = member?.displayName ?? targetUser.displayName;

      const [settings, vcSeconds] = await Promise.all([
        getEvalSheetSettings(guildId),
        getSheetVcSeconds(guildId, targetUser.id, startDate, endDate),
      ]);

      const embed = buildSheetEmbed({
        targetUser,
        displayName,
        startDate,
        endDate,
        vcSeconds,
        nameboardUrl: settings?.nameboardUrl,
        createdByLabel: `作成者: ${interaction.user.displayName}`,
      });

      const msg = await interaction.editReply({ embeds: [embed] });
      const msgId = "id" in msg ? (msg as { id: string }).id : undefined;
      await createEvalSheet(
        guildId,
        targetUser.id,
        startDate,
        endDate,
        interaction.channelId ?? undefined,
        msgId,
      );
      return;
    }

    // ── list ────────────────────────────────────────────────────────────────
    if (sub === "list") {
      await interaction.deferReply({ ephemeral: true });
      const sheets = await listEvalSheets(guildId);
      if (sheets.length === 0) {
        await interaction.editReply("評価シートがまだありません。");
        return;
      }
      const lines = sheets.map((s) => {
        const startTs = Math.floor(s.startDate.getTime() / 1000);
        const endTs = Math.floor(s.endDate.getTime() / 1000);
        const link =
          s.channelId && s.messageId
            ? ` [→](https://discord.com/channels/${guildId}/${s.channelId}/${s.messageId})`
            : "";
        return `• <@${s.userId}> <t:${startTs}:D> 〜 <t:${endTs}:D>${link}`;
      });
      const embed = new EmbedBuilder()
        .setTitle("📋 評価シート一覧")
        .setColor(0x2ecc71)
        .setDescription(lines.join("\n").slice(0, 4000));
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── delete ──────────────────────────────────────────────────────────────
    if (sub === "delete") {
      if (!isAdmin) {
        await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
        return;
      }
      await interaction.deferReply({ ephemeral: true });

      const target = interaction.options.getUser("member", true);
      const sheet = await getLatestEvalSheet(guildId, target.id);
      if (!sheet) {
        await interaction.editReply(`<@${target.id}> の評価シートは見つかりませんでした。`);
        return;
      }

      await deleteEvalSheet(sheet.id);

      if (sheet.channelId) {
        try {
          const ch = await interaction.guild!.channels.fetch(sheet.channelId);
          if (ch) await ch.delete("評価シート削除コマンド");
        } catch { /* already gone */ }
      }

      const startTs = Math.floor(sheet.startDate.getTime() / 1000);
      const endTs = Math.floor(sheet.endDate.getTime() / 1000);
      await interaction.editReply(
        `✅ <@${target.id}> の評価シート（<t:${startTs}:D> 〜 <t:${endTs}:D>）を削除しました。`,
      );
    }
  },
};
