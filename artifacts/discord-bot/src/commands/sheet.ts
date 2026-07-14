import {
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type Client,
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
  setEvalSheetForumConfig,
  setEvalNameboardUrl,
} from "../lib/economy";
import { logger } from "../lib/logger";

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

export function buildSheetEmbed(opts: {
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

/**
 * After an eval-period extension purchase, edit the forum thread's first
 * message so the embed shows the new end date.  Fire-and-forget: call without
 * await so it doesn't slow down the purchase confirmation reply.
 */
export async function applySheetEmbedUpdate(
  client: Client,
  guildId: string,
  info: {
    newEndDate: Date;
    channelId: string | null;
    messageId: string | null;
    startDate: Date;
    userId: string;
  },
): Promise<void> {
  const { channelId, messageId, startDate, newEndDate, userId } = info;
  if (!channelId || !messageId) return;

  logger.info(`[sheet] applySheetEmbedUpdate: userId=${userId} channelId=${channelId} messageId=${messageId}`);
  try {
    // messageId stores the forum thread ID.
    // The starter message of a forum thread has the same ID as the thread.
    const thread = await client.channels.fetch(messageId);
    logger.info(`[sheet] thread fetched: ${thread?.id} isTextBased=${thread?.isTextBased()}`);
    if (!thread?.isTextBased()) return;

    const message = await thread.messages.fetch(messageId);
    logger.info(`[sheet] starter message fetched: ${message.id}`);
    const targetUser = await client.users.fetch(userId);

    let displayName = targetUser.displayName;
    try {
      const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId);
      const member = await guild.members.fetch(userId);
      displayName = member.displayName;
    } catch { /* fallback to user displayName */ }

    const [settings, vcSeconds] = await Promise.all([
      getEvalSheetSettings(guildId),
      getSheetVcSeconds(guildId, userId, startDate, newEndDate),
    ]);

    const embed = buildSheetEmbed({
      targetUser,
      displayName,
      startDate,
      endDate: newEndDate,
      vcSeconds,
      nameboardUrl: settings?.nameboardUrl,
      createdByLabel: "評価期間延長券により更新",
    });

    await message.edit({ embeds: [embed] });
    logger.info(`[sheet] ✅ embed updated for user=${userId}`);
  } catch (err) {
    logger.error(`[sheet] Failed to refresh embed for user=${userId}`, err);
  }
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
      sub
        .setName("settings")
        .setDescription("評価シートのロール・フォーラム設定を変更します（管理者）")
        .addChannelOption((opt) =>
          opt
            .setName("forum")
            .setDescription("自動投稿先のフォーラムチャンネル")
            .addChannelTypes(15) // ChannelType.GuildForum = 15
            .setRequired(false),
        )
        .addRoleOption((opt) =>
          opt.setName("trigger_role_1").setDescription("自動作成を起動するロール①").setRequired(false),
        )
        .addRoleOption((opt) =>
          opt.setName("trigger_role_2").setDescription("自動作成を起動するロール②").setRequired(false),
        )
        .addRoleOption((opt) =>
          opt.setName("trigger_role_3").setDescription("自動作成を起動するロール③").setRequired(false),
        )
        .addIntegerOption((opt) =>
          opt
            .setName("eval_days")
            .setDescription("評価期間（日数・デフォルト14）")
            .setMinValue(1)
            .setMaxValue(90)
            .setRequired(false),
        )
        .addStringOption((opt) =>
          opt
            .setName("url")
            .setDescription("名簿URL（クリアするには '-' を入力）")
            .setRequired(false),
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

    // ── settings ────────────────────────────────────────────────────────────
    if (sub === "settings") {
      if (!isAdmin) {
        await interaction.reply({ content: "このコマンドはサーバー管理権限が必要です。", ephemeral: true });
        return;
      }
      await interaction.deferReply({ ephemeral: true });

      const current = await getEvalSheetSettings(guildId);
      const lines: string[] = [];

      // Nameboard URL
      const urlInput = interaction.options.getString("url");
      if (urlInput !== null) {
        const newUrl = urlInput === "-" ? null : urlInput;
        await setEvalNameboardUrl(guildId, newUrl);
        lines.push(newUrl ? `✅ 名簿URL: ${newUrl}` : "✅ 名簿URLを削除しました。");
      }

      // Forum / roles / eval days
      const forumChannel = interaction.options.getChannel("forum");
      const role1 = interaction.options.getRole("trigger_role_1");
      const role2 = interaction.options.getRole("trigger_role_2");
      const role3 = interaction.options.getRole("trigger_role_3");
      const evalDaysInput = interaction.options.getInteger("eval_days");

      const hasForumUpdate = forumChannel !== null || role1 !== null || role2 !== null || role3 !== null || evalDaysInput !== null;
      if (hasForumUpdate) {
        const newForumId = forumChannel ? forumChannel.id : (current?.forumChannelId ?? null);
        const newRoles: string[] =
          role1 || role2 || role3
            ? [role1?.id, role2?.id, role3?.id].filter((id): id is string => !!id)
            : (current?.triggerRoleIds?.split(",").filter(Boolean) ?? []);
        const newDays = evalDaysInput ?? current?.evalPeriodDays ?? 14;
        await setEvalSheetForumConfig(guildId, newForumId, newRoles.length ? newRoles : null, newDays);

        if (forumChannel) lines.push(`✅ 投稿フォーラム: <#${forumChannel.id}>`);
        if (role1 || role2 || role3) {
          const mentions = newRoles.map((id) => `<@&${id}>`).join("、");
          lines.push(`✅ トリガーロール: ${mentions}`);
        }
        if (evalDaysInput !== null) lines.push(`✅ 評価期間: ${evalDaysInput}日`);
      }

      if (lines.length === 0) {
        // Show current settings
        const s = current;
        const roleList = s?.triggerRoleIds
          ? s.triggerRoleIds.split(",").filter(Boolean).map((id) => `<@&${id}>`).join("、")
          : "未設定";
        const embed = new EmbedBuilder()
          .setTitle("📋 評価シート設定")
          .setColor(0x2ecc71)
          .addFields(
            { name: "📋 名簿URL", value: s?.nameboardUrl ?? "未設定", inline: false },
            { name: "📢 投稿フォーラム", value: s?.forumChannelId ? `<#${s.forumChannelId}>` : "未設定", inline: true },
            { name: "🔔 トリガーロール", value: roleList, inline: true },
            { name: "📅 評価期間", value: `${s?.evalPeriodDays ?? 14}日`, inline: true },
          );
        await interaction.editReply({ embeds: [embed] });
      } else {
        await interaction.editReply({ content: lines.join("\n") });
      }
      return;
    }

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
