import { AttachmentBuilder, EmbedBuilder, escapeMarkdown } from "discord.js";
import type { KpTicketSession } from "@workspace/db";

/** Uses paid price snapshots, never the current catalogue or a wallet mutation. */
export function kpTicketStatement(orders: KpTicketSession[], currency: string) {
  let total = 0n, drinks = 0n, vip = 0n, extension = 0n;
  const lines: string[] = [];
  const preview: string[] = [];
  for (const [index, order] of orders.entries()) {
    const q = order.selection.quote;
    if (order.phase !== "paid" || !q) throw new Error("支払い済み注文の明細が不完全です。");
    total += BigInt(q.total);
    drinks += BigInt(q.unitPrice) * BigInt(q.quantity);
    vip += BigInt(q.vipPrice);
    extension += BigInt(q.extensionPrice);
    const price = `${q.total.toLocaleString()}${currency}`;
    const itemLabel = q.itemId === null ? q.itemName : `${q.itemName} × ${q.quantity}個`;
    lines.push(
      `${index + 1}. ${itemLabel}`,
      `購入者ID: ${order.userId} / 指名キャストID: ${order.selection.castId ?? "未記録"}`,
      `単価: ${q.unitPrice.toLocaleString()}${currency}`,
      `VIP: ${q.vipPrice.toLocaleString()}${currency} / 延長: ${q.extensionPrice.toLocaleString()}${currency}`,
      `支払額: ${price}`,
      `支払日時: ${order.paidAt?.toISOString() ?? "未記録"} / 注文ID: ${order.id}`, "",
    );
    if (index < 10) preview.push(
      `${index + 1}. ${escapeMarkdown(itemLabel.slice(0, 100))} — ${price}\n購入者: <@${order.userId}> / キャスト: <@${order.selection.castId}>`,
    );
  }
  const amount = (value: bigint) => `${value.toLocaleString()}${currency}`;
  const totals = `ドリンク代: ${amount(drinks)}\nVIP料金: ${amount(vip)}\n延長料金: ${amount(extension)}\n支払い済み合計: ${amount(total)}`;
  const embed = new EmbedBuilder().setTitle("キミノヒトミニKP 注文明細").setColor(0x2ecc71)
    .setDescription(orders.length
      ? preview.join("\n\n") + (orders.length > 10 ? "\n\n11件目以降を含む全明細は添付ファイルをご確認ください。" : "")
      : "このチケットには支払い済みの注文がありません。")
    .addFields({ name: `支払い済み ${orders.length}件`, value: totals })
    .setFooter({ text: "集計時点の支払い済み注文のみ・追加の引き落としなし" }).setTimestamp();
  const text = `キミノヒトミニKP 注文明細\n支払い済み ${orders.length}件\n${totals}\n`
    + "集計時点の支払い済み注文のみ。追加の引き落としはありません。\n\n" + lines.join("\n");
  return { embeds: [embed], files: [new AttachmentBuilder(Buffer.from(text, "utf8"), { name: "kp-ticket-statement.txt" })],
    allowedMentions: { parse: [] as ("users" | "roles" | "everyone")[] } };
}
