import {
  AttachmentBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits,
  SlashCommandBuilder, type ChatInputCommandInteraction,
} from "discord.js";
import { deleteGcsObject, downloadImageAsBuffer, uploadImageFromUrl } from "../lib/gcsStorage";
import {
  deleteChinchiroDiceImage, getChinchiroDiceImages, setChinchiroDiceImage,
  validDiceFace,
} from "../lib/chinchiroDiceImages";

const IMAGE_TYPES: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
};
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export function chinchiroDiceCommandData() {
  return new SlashCommandBuilder().setName("chinchiro-dice")
    .setDescription("複数人チンチロのサイコロ画像を設定する")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((s) => s.setName("set").setDescription("サイコロ画像を登録する")
      .addIntegerOption((o) => o.setName("face").setDescription("サイコロの目（1〜6）").setMinValue(1).setMaxValue(6).setRequired(true))
      .addAttachmentOption((o) => o.setName("image").setDescription("PNG / JPG / GIF / WebP画像").setRequired(true)))
    .addSubcommand((s) => s.setName("list").setDescription("登録済み画像を一覧表示する"))
    .addSubcommand((s) => s.setName("delete").setDescription("サイコロ画像を削除する")
      .addIntegerOption((o) => o.setName("face").setDescription("サイコロの目（1〜6）").setMinValue(1).setMaxValue(6).setRequired(true)));
}

export const chinchiroDiceCommand = {
  data: chinchiroDiceCommandData(),
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) return;
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: "❌ 管理者専用です。", flags: MessageFlags.Ephemeral }); return;
    }
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (sub === "list") {
      const images = await getChinchiroDiceImages(interaction.guildId);
      await interaction.editReply({
        embeds: [new EmbedBuilder().setTitle("🎲 チンチロ — サイコロ画像一覧")
          .setDescription([1, 2, 3, 4, 5, 6].map((face) => `${images.has(face) ? "✅" : "❌"} ${face}の目${images.has(face) ? "" : "（未設定）"}`).join("\n"))],
      }); return;
    }
    const face = interaction.options.getInteger("face", true);
    if (!validDiceFace(face)) { await interaction.editReply("❌ 目は1〜6で指定してください。"); return; }
    const images = await getChinchiroDiceImages(interaction.guildId);
    if (sub === "delete") {
      const objectPath = images.get(face);
      if (!objectPath) { await interaction.editReply(`❌ ${face}の目は登録されていません。`); return; }
      await deleteGcsObject(objectPath);
      await deleteChinchiroDiceImage(interaction.guildId, face);
      await interaction.editReply(`✅ ${face}の目の画像を削除しました。`); return;
    }
    const attachment = interaction.options.getAttachment("image", true);
    if (!attachment.contentType || !IMAGE_TYPES[attachment.contentType] || (attachment.size ?? 0) > MAX_IMAGE_BYTES) {
      await interaction.editReply("❌ PNG / JPG / GIF / WebP の画像（10MB以下）を添付してください。"); return;
    }
    const ext = IMAGE_TYPES[attachment.contentType];
    const objectPath = `chinchiro-dice/${interaction.guildId}/${face}.${ext}`;
    try {
      await uploadImageFromUrl(attachment.url, objectPath, attachment.contentType);
      const previous = images.get(face);
      await setChinchiroDiceImage(interaction.guildId, face, objectPath);
      if (previous && previous !== objectPath) await deleteGcsObject(previous);
      const buffer = await downloadImageAsBuffer(objectPath);
      const files = buffer ? [new AttachmentBuilder(buffer, { name: `dice-${face}.${ext}` })] : [];
      await interaction.editReply({
        content: `✅ ${face}の目の画像を登録しました。`,
        embeds: [new EmbedBuilder().setTitle("🎲 サイコロ画像登録").setDescription(`${face}の目`).setImage(files.length ? `attachment://dice-${face}.${ext}` : null)],
        files,
      });
    } catch (error) {
      await interaction.editReply(`❌ 画像の登録に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};