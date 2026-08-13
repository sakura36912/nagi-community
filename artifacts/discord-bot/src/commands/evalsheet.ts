/**
 * /evalsheet — 評価シート設定コマンド（管理者専用）
 *
 *   setup           : ロール → フォーラムの紐付けを追加・更新（繰り返し呼ぶことで複数登録可）
 *   remove          : 指定ロールの紐付けを解除
 *   roster-category : 自己紹介検索カテゴリを設定（省略で解除）
 *   nameboard       : 名簿URLを設定（省略で解除）
 *   info            : 現在の全紐付けと共通設定を表示
 */

import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import {
  upsertEvalSheetConfig,
  listEvalSheetConfigs,
  deleteEvalSheetConfig,
} from "@workspace/db";
import {
  getEvalSheetSettings,
  setEvalNameboardUrl,
  setRosterCategoryId,
  setEvalDeadlineNotify,
  setEvalReminderDaysBefore,
  listEvalSheets,
  getSheetVcSeconds,
} from "../lib/economy";
import { buildNameboardComponents, buildSheetEmbed, findSelfIntro } from "../lib/sheet";

export const evalsheetCommand = {
  data: new SlashCommandBuilder()
    .setName("evalsheet")
    .setDescription("評価シートの設定を管理します（管理者）")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

    // ── setup ───────────────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("setup")
        .setDescription(
          "ロールとフォーラムを紐づけます（同じロールで再実行すると上書き）",
        )
        .addRoleOption((opt) =>
          opt
            .setName("role")
            .setDescription("評価シートを自動作成するトリガーロール")
            .setRequired(true),
        )
        .addChannelOption((opt) =>
          opt
            .setName("forum")
            .setDescription("評価シートを投稿するフォーラムチャンネル")
            .addChannelTypes(ChannelType.GuildForum)
            .setRequired(true),
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

    // ── remove ──────────────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("指定したロールの紐付けを解除します")
        .addRoleOption((opt) =>
          opt
            .setName("role")
            .setDescription("紐付けを解除するロール")
            .setRequired(true),
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

    // ── reminder-timing ─────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("reminder-timing")
        .setDescription("フォーラムスレッドへのリマインダーを期日の何日前に送るか設定します")
        .addIntegerOption((opt) =>
          opt
            .setName("days")
            .setDescription("期日の何日前に送るか（0 = 期日当日）")
            .setMinValue(0)
            .setMaxValue(30)
            .setRequired(true),
        ),
    )

    // ── deadline-notify ─────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("deadline-notify")
        .setDescription("評価期日当日 0:00 に通知するチャンネルとロールを設定します")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("通知を投稿するテキストチャンネル（省略で解除）")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false),
        )
        .addRoleOption((opt) =>
          opt
            .setName("role")
            .setDescription("通知でメンションするロール（省略でメンションなし）")
            .setRequired(false),
        ),
    )

    // ── info ────────────────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("info")
        .setDescription("現在の全紐付けと共通設定を表示します"),
    )

    // ── refresh-embeds ──────────────────────────────────────────────────────
    .addSubcommand((sub) =>
      sub
        .setName("refresh-embeds")
        .setDescription("このサーバーの全評価シートのアバターをサーバープロフィールに更新します"),
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
      const role       = interaction.options.getRole("role", true);
      const forum      = interaction.options.getChannel("forum", true);
      const periodDays = interaction.options.getInteger("period_days") ?? 14;

      await upsertEvalSheetConfig(
        interaction.guildId,
        role.id,
        forum.id,
        periodDays,
      );

      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("✅ 紐付けを登録しました")
            .setColor(0x57f287)
            .addFields(
              { name: "ロール", value: `<@&${role.id}>`, inline: true },
              { name: "フォーラム", value: `<#${forum.id}>`, inline: true },
              { name: "評価期間", value: `${periodDays} 日`, inline: true },
            )
            .setFooter({ text: "同じロールで再実行すると上書きされます" }),
        ],
        ephemeral: true,
      });
      return;
    }

    // ── remove ────────────────────────────────────────────────────────────
    if (sub === "remove") {
      const role    = interaction.options.getRole("role", true);
      const removed = await deleteEvalSheetConfig(interaction.guildId, role.id);
      if (!removed) {
        await interaction.reply({
          content: `<@&${role.id}> は評価シートのトリガーロールとして登録されていません。`,
          ephemeral: true,
        });
        return;
      }
      await interaction.reply({
        content: `✅ <@&${role.id}> の紐付けを解除しました。`,
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

    // ── reminder-timing ───────────────────────────────────────────────────
    if (sub === "reminder-timing") {
      const days = interaction.options.getInteger("days", true);
      await setEvalReminderDaysBefore(interaction.guildId, days);
      await interaction.reply({
        content: days === 0
          ? "✅ フォーラムリマインダーを **期日当日** に送るよう設定しました。"
          : `✅ フォーラムリマインダーを **期日の ${days} 日前** に送るよう設定しました。`,
        ephemeral: true,
      });
      return;
    }

    // ── deadline-notify ───────────────────────────────────────────────────
    if (sub === "deadline-notify") {
      const channel = interaction.options.getChannel("channel");
      const role    = interaction.options.getRole("role");
      await setEvalDeadlineNotify(
        interaction.guildId,
        channel?.id ?? null,
        role?.id ?? null,
      );
      const lines: string[] = [];
      lines.push(channel ? `通知チャンネル: <#${channel.id}>` : "通知チャンネル: 解除");
      lines.push(role ? `メンションロール: <@&${role.id}>` : "メンションロール: なし");
      await interaction.reply({
        content: `✅ 期日通知を設定しました\n${lines.join("\n")}`,
        ephemeral: true,
      });
      return;
    }

    // ── info ──────────────────────────────────────────────────────────────
    if (sub === "info") {
      const [configs, globalSettings] = await Promise.all([
        listEvalSheetConfigs(interaction.guildId),
        getEvalSheetSettings(interaction.guildId),
      ]);

      const embed = new EmbedBuilder()
        .setTitle("📋 評価シート設定")
        .setColor(0x5865f2);

      // ロール → フォーラム マッピング一覧
      if (configs.length === 0) {
        embed.addFields({
          name: "ロール × フォーラム 紐付け",
          value:
            "未設定です。`/evalsheet setup` でロールとフォーラムを紐づけてください。",
          inline: false,
        });
      } else {
        embed.addFields({
          name: `ロール × フォーラム 紐付け（${configs.length} 件）`,
          value: configs
            .map(
              (c) =>
                `<@&${c.roleId}> → <#${c.forumChannelId}>（${c.evalPeriodDays} 日）`,
            )
            .join("\n"),
          inline: false,
        });
      }

      // 共通設定
      embed.addFields(
        {
          name: "自己紹介カテゴリ",
          value: globalSettings?.rosterCategoryId
            ? `<#${globalSettings.rosterCategoryId}>`
            : "未設定",
          inline: true,
        },
        {
          name: "名簿URL",
          value: globalSettings?.nameboardUrl
            ? `[リンク](${globalSettings.nameboardUrl})`
            : "未設定",
          inline: true,
        },
        {
          name: "フォーラムリマインダー",
          value: globalSettings?.reminderDaysBefore
            ? `期日の ${globalSettings.reminderDaysBefore} 日前`
            : "期日当日",
          inline: true,
        },
        {
          name: "期日通知チャンネル",
          value: globalSettings?.deadlineNotifyChannelId
            ? `<#${globalSettings.deadlineNotifyChannelId}>`
            : "未設定",
          inline: true,
        },
        {
          name: "期日通知ロール",
          value: globalSettings?.deadlineNotifyRoleId
            ? `<@&${globalSettings.deadlineNotifyRoleId}>`
            : "なし（メンションなし）",
          inline: true,
        },
      );

      if (globalSettings?.updatedAt) {
        embed.setTimestamp(globalSettings.updatedAt);
      }

      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }

    // ── refresh-embeds ────────────────────────────────────────────────────
    if (sub === "refresh-embeds") {
      await interaction.deferReply({ ephemeral: true });

      const sheets = await listEvalSheets(interaction.guildId);
      const targets = sheets.filter((s) => s.messageId);

      let updated = 0;
      let failed = 0;

      const settings = await getEvalSheetSettings(interaction.guildId);

      for (const sheet of targets) {
        try {
          // sheet.messageId stores the forum thread ID (thread.id).
          // In Discord forum posts, thread.id === starterMessage.id, so the
          // same ID correctly addresses both the thread channel and its
          // starter (embed) message.
          const thread = await interaction.client.channels
            .fetch(sheet.messageId!)
            .catch(() => null);
          if (!thread?.isTextBased()) { failed++; continue; }

          const message = await thread.messages
            .fetch(sheet.messageId!)
            .catch(() => null);
          if (!message) { failed++; continue; }

          const targetUser = await interaction.client.users
            .fetch(sheet.userId)
            .catch(() => null);
          if (!targetUser) { failed++; continue; }

          let displayName = targetUser.displayName;
          let member: GuildMember | null = null;
          try {
            member = await interaction.guild!.members.fetch(sheet.userId).catch(() => null);
            if (member) displayName = member.displayName;
          } catch { /* fallback */ }

          const [vcSeconds, selfIntro] = await Promise.all([
            getSheetVcSeconds(sheet.guildId, sheet.userId, sheet.startDate, sheet.endDate),
            findSelfIntro(interaction.guild!, sheet.userId, settings?.rosterCategoryId ?? null),
          ]);

          const embed = buildSheetEmbed({
            targetUser,
            member,
            displayName,
            startDate: sheet.startDate,
            endDate: sheet.endDate,
            vcSeconds,
            nameboardUrl: settings?.nameboardUrl ?? null,
            selfIntro,
            createdByLabel: "アバター一括更新",
            guildIconUrl: interaction.guild?.iconURL() ?? null,
          });

          await message.edit({ embeds: [embed], components: buildNameboardComponents(settings?.nameboardUrl ?? null) });
          updated++;
        } catch {
          failed++;
        }
      }

      await interaction.editReply(
        `✅ ${updated} 件の評価シートを更新しました。` +
        (failed > 0 ? `（${failed} 件はスレッドが見つからないためスキップ）` : ""),
      );
      return;
    }
  },
};
