import { AttachmentBuilder, EmbedBuilder, escapeMarkdown } from "discord.js";
import type { KpTicketSession } from "@workspace/db";
import type { KpBusinessDay } from "./kpBusinessDay";

/** Uses paid price snapshots, never the current catalogue or a wallet mutation. */
export function kpTicketStatement(orders: KpTicketSession[], currency: string, allTickets = false, period?: KpBusinessDay) {
  let total = 0n, drinks = 0n, vip = 0n, extension = 0n;
  const lines: string[] = [];
  const preview: string[] = [];
  for (const [index, order] of orders.entries()) {
    const q = order.selection.quote;
    if (order.phase !== "paid" || !q) throw new Error("支払い済み注文の明細が不完全です。");
    total += BigInt(q.total);
    drinks += BigInt(q.items?.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0)
      ?? q.unitPrice * q.quantity);
    vip += BigInt(q.vipPrice);
    extension += BigInt(q.extensionPrice);
    const price = `${q.total.toLocaleString()}${currency}`;
    const itemLabel = q.items?.length
      ? q.items.map(item => `${item.itemName} × ${item.quantity}個（キャストID: ${item.castId}）`).join(" / ")
      : q.itemId === null ? q.itemName : `${q.itemName} × ${q.quantity}個`;
    const castIds = order.selection.castIds ?? (order.selection.castId ? [order.selection.castId] : []);
    lines.push(
      `${index + 1}. ${itemLabel}`,
      ...(allTickets ? [`チケットID: ${order.channelId}`] : []),
      `購入者ID: ${order.userId} / 指名キャストID: ${castIds.join(", ") || "未記録"}`,
      ...(q.items?.length ? q.items.map(item =>
        `${item.itemName}（キャストID: ${item.castId}）: ${item.unitPrice.toLocaleString()}${currency} × ${item.quantity}`
      ) : [`単価: ${q.unitPrice.toLocaleString()}${currency}`]),
      ...(q.vipPrice || q.extensionPrice ? [`VIP: ${q.vipPrice.toLocaleString()}${currency} / 延長: ${q.extensionPrice.toLocaleString()}${currency}`] : []),
      `支払額: ${price}`,
      `支払日時: ${order.paidAt?.toISOString() ?? "未記録"} / 注文ID: ${order.id}`, "",
    );
    if (index < 10) preview.push(
      `${index + 1}. ${escapeMarkdown(itemLabel.slice(0, 100))} — ${price}\n購入者: <@${order.userId}> / キャスト: ${castIds.map(id => `<@${id}>`).join(", ") || "未記録"}`,
    );
  }
  const amount = (value: bigint) => `${value.toLocaleString()}${currency}`;
  const totals = `ドリンク代: ${amount(drinks)}`
    + (vip || extension ? `\nVIP料金: ${amount(vip)}\n延長料金: ${amount(extension)}` : "")
    + `\n支払い済み合計: ${amount(total)}`;
  const title = allTickets ? "キミノヒトミニKP 全チケット明細" : "キミノヒトミニKP 注文明細";
  const scope = allTickets ? `同じサーバーの${period ? "指定営業日" : "全期間"}・${new Set(orders.map(order => order.channelId)).size}チケット（削除済みを含む）` : "";
  const embed = new EmbedBuilder().setTitle(title).setColor(0x2ecc71)
    .setDescription(orders.length
      ? preview.join("\n\n") + (orders.length > 10 ? "\n\n11件目以降を含む全明細は添付ファイルをご確認ください。" : "")
      : allTickets ? `このサーバー${period ? "の指定営業日" : ""}には支払い済みの注文がありません。` : "このチケットには支払い済みの注文がありません。")
    .addFields({ name: `支払い済み ${orders.length}件`, value: totals })
    .setFooter({ text: `${scope ? scope + "・" : ""}集計時点の支払い済み注文のみ・追加の引き落としなし` }).setTimestamp();
  if (period) embed.addFields({ name: "売上集計期間（支払い完了日時基準）", value: period.label });
  const text = `${title}\n${scope ? scope + "\n" : ""}${period ? period.label + "\n" : ""}支払い済み ${orders.length}件\n${totals}\n`
    + "集計時点の支払い済み注文のみ。追加の引き落としはありません。\n\n" + lines.join("\n");
  return { embeds: [embed], files: [new AttachmentBuilder(Buffer.from(text, "utf8"), { name: allTickets ? "kp-all-tickets-statement.txt" : "kp-ticket-statement.txt" })],
    allowedMentions: { parse: [] as ("users" | "roles" | "everyone")[] } };
}
