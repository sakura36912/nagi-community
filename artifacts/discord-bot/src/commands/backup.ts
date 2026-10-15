import {
  AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
  PermissionFlagsBits, SlashCommandBuilder, type ButtonInteraction, type ChatInputCommandInteraction,
  type Client,
} from "discord.js";
import { exportCurrentDatabaseJsonBackup } from "@workspace/db";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../lib/logger";

export const BACKUP_PREFIX = "database-backup:";
let exporting = false;

/** Team membership alone is insufficient: only the application/team owner. */
export async function isBackupOwner(client: Client, userId: string): Promise<boolean> {
  const application = await client.application?.fetch();
  const owner = application?.owner;
  return !!owner && ("ownerId" in owner ? owner.ownerId : owner.id) === userId;
}

export const backupCommand = {
  data: new SlashCommandBuilder().setName("backup").setDescription("データベースをJSONでバックアップ（Bot所有者限定）")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) => sub.setName("export").setDescription("全サーバー・全ユーザーの保存データをJSONで取得します")),
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      if (!await isBackupOwner(interaction.client, interaction.user.id)) {
        await interaction.editReply("この機能はBotアプリケーションの所有者専用です。サーバー管理者権限だけでは実行できません。");
        return;
      }
      const button = (action: string, label: string, style: ButtonStyle) => new ButtonBuilder()
        .setCustomId(`${BACKUP_PREFIX}${action}:${interaction.user.id}`).setLabel(label).setStyle(style);
      await interaction.editReply({
        content: "全サーバー・全ユーザーの残高、履歴、設定などをJSONで書き出します。取得先はこのBotが現在接続しているDBです。\n個人情報を含むため、ファイルは公開・転送せず安全に保管してください。添付は本人にだけ表示します。DB外の画像・ファイル本体は含みません。\n実行しますか？",
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          button("confirm", "JSONバックアップを取得", ButtonStyle.Primary),
          button("cancel", "キャンセル", ButtonStyle.Secondary),
        )],
        allowedMentions: { parse: [] },
      });
    } catch {
      await interaction.editReply("Bot所有者の確認に失敗しました。安全のため実行していません。");
    }
  },
};

export async function handleBackupButton(interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith(BACKUP_PREFIX)) return false;
  const [action, actorId] = interaction.customId.slice(BACKUP_PREFIX.length).split(":");
  if (actorId !== interaction.user.id) {
    await interaction.reply({ content: "バックアップを開始した本人のみ操作できます。", flags: MessageFlags.Ephemeral });
    return true;
  }
  await interaction.deferUpdate();
  if (action === "cancel") {
    await interaction.editReply({ content: "バックアップをキャンセルしました。", components: [] });
    return true;
  }
  let root: string | undefined;
  let ownsJob = false;
  try {
    if (action !== "confirm" || !await isBackupOwner(interaction.client, interaction.user.id)) {
      await interaction.editReply({ content: "所有者権限を確認できません。実行していません。", components: [] });
      return true;
    }
    if (exporting) {
      await interaction.editReply({ content: "別のバックアップを作成中です。完了後にもう一度実行してください。", components: [] });
      return true;
    }
    exporting = ownsJob = true;
    await interaction.editReply({ content: "読み取り専用でJSONバックアップを作成しています…", components: [] });
    root = await mkdtemp(join(tmpdir(), "private-db-export-"));
    const backup = await exportCurrentDatabaseJsonBackup({
      outputRoot: root, source: "bot-runtime", maxPartBytes: 7 * 1024 * 1024,
    });
    // One bounded file per request also avoids combined-message upload limits.
    // No public messages or download routes are used.
    for (let offset = 0; offset < backup.files.length; offset++) {
      const payload = {
        content: `バックアップ送信中（${offset + 1}/${backup.files.length}ファイル）。完了表示までお待ちください。`,
        files: backup.files.slice(offset, offset + 1).map((file) =>
          new AttachmentBuilder(join(backup.directory, file), { name: file })),
        allowedMentions: { parse: [] as never[] },
      };
      if (offset === 0) await interaction.editReply(payload);
      else await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
    }
    await interaction.editReply({
      content: `✅ JSONバックアップ完了：${backup.manifest.tableCount}テーブル・${backup.manifest.totalRows}行。\nmanifest.json と全${backup.manifest.parts.length}個の data-*.json を保存してください。ファイルを分割している場合も、すべて揃えて1つのバックアップです。`,
      allowedMentions: { parse: [] },
    });
    logger.info(`[backup] JSON export completed tables=${backup.manifest.tableCount} rows=${backup.manifest.totalRows} parts=${backup.manifest.parts.length}`);
  } catch (error) {
    logger.error(`[backup] JSON export/delivery failed (${error instanceof Error ? error.name : "unknown"})`);
    await interaction.editReply({
      content: "バックアップの作成または送信に失敗しました。一部のファイルが届いていても、完了表示のないものは完全なバックアップではありません。時間をおいて再実行してください。",
      components: [],
    });
  } finally {
    if (ownsJob) exporting = false;
    if (root) await rm(root, { recursive: true, force: true });
  }
  return true;
}
