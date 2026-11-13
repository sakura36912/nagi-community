import { AttachmentBuilder, EmbedBuilder } from "discord.js";

export type KpRecipientTransfer = {
  senderId: string;
  amount: number;
  createdAt: Date;
};

const formatDate = (value: Date) =>
  `${value.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false })} JST`;

export function kpTransferHistory(
  transfers: KpRecipientTransfer[],
  currency: string,
  recipientId: string,
) {
  const total = transfers.reduce((sum, transfer) => sum + BigInt(Math.abs(transfer.amount)), 0n);
  const preview = transfers.slice(0, 15).map((transfer, index) =>
    `**${index + 1}.** <@${transfer.senderId}> — **${Math.abs(transfer.amount).toLocaleString()}${currency}**\n${formatDate(transfer.createdAt)}`,
  );
  const embed = new EmbedBuilder()
    .setTitle("凪への送金履歴")
    .setColor(0x3498db)
    .setDescription(preview.join("\n\n") || "凪宛ての送金記録はありません。")
    .addFields(
      { name: "受取人", value: `<@${recipientId}>`, inline: true },
      { name: "送金回数", value: `${transfers.length}回`, inline: true },
      { name: "送金合計", value: `${total.toLocaleString()}${currency}`, inline: true },
    )
    .setFooter({
      text: "全期間・このサーバーの記録。送金したチャンネルは保存されていないため、チケット内外は区別できません。",
    })
    .setTimestamp();
  const text = [
    "凪への送金履歴",
    `受取人ID: ${recipientId}`,
    `全期間・送金回数: ${transfers.length}回・送金合計: ${total.toLocaleString()}${currency}`,
    "日時は日本時間。既存記録には送金チャンネルが保存されていません。",
    "",
    ...transfers.map((transfer, index) =>
      `${index + 1}. ${formatDate(transfer.createdAt)} / 送金者ID: ${transfer.senderId} / 金額: ${Math.abs(transfer.amount).toLocaleString()}${currency}`,
    ),
  ].join("\n");
  return {
    embeds: [embed],
    files: [new AttachmentBuilder(Buffer.from(text, "utf8"), { name: "nagi-transfer-history.txt" })],
    allowedMentions: { parse: [] as ("users" | "roles" | "everyone")[] },
  };
}
