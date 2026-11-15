import { AttachmentBuilder, EmbedBuilder } from "discord.js";
import type { KpTicketSession } from "@workspace/db";
import type { KpBusinessDay } from "./kpBusinessDay";

/** Group paid snapshots by cast ID, including additional orders and deleted tickets. */
export function kpCastSales(orders: KpTicketSession[], currency: string, period: KpBusinessDay) {
  const totals = new Map<string, bigint>();
  for (const order of orders) {
    const quote = order.selection.quote;
    if (order.phase !== "paid" || !quote) throw new Error("支払い済み注文の明細が不完全です。");
    const castIds = order.selection.castIds ?? (order.selection.castId ? [order.selection.castId] : []);
    const primaryCast = castIds[0] ?? "";
    if (quote.items?.length) {
      for (const item of quote.items) {
        totals.set(item.castId, (totals.get(item.castId) ?? 0n) + BigInt(item.unitPrice) * BigInt(item.quantity));
      }
    } else {
      const unitemized = BigInt(quote.total - quote.vipPrice - quote.extensionPrice);
      totals.set(primaryCast, (totals.get(primaryCast) ?? 0n) + unitemized);
    }
    const vipPerCast = castIds.length ? BigInt(quote.vipPrice) / BigInt(castIds.length) : BigInt(quote.vipPrice);
    for (const castId of castIds) {
      totals.set(castId, (totals.get(castId) ?? 0n) + vipPerCast);
    }
    totals.set(primaryCast, (totals.get(primaryCast) ?? 0n) + BigInt(quote.extensionPrice));
  }
  const sorted = [...totals].sort(([a, x], [b, y]) => x === y ? a.localeCompare(b) : x > y ? -1 : 1);
  const amount = (value: bigint) => `${value.toLocaleString()}${currency}`;
  const preview: string[] = [];
  for (const [cast, total] of sorted) {
    const line = `${cast ? `<@${cast}>` : "キャスト未記録"}：${amount(total)}`;
    if (preview.length >= 20 || preview.join("\n").length + line.length > 3400) break;
    preview.push(line);
  }
  const title = "キミノヒトミニKP 全チケット キャスト別売上";
  const scope = "同じサーバーの全チケット（削除済みを含む）・支払い済み注文のみ";
  const embed = new EmbedBuilder().setTitle(title).setColor(0x2ecc71)
    .setDescription(sorted.length
      ? preview.join("\n") + (preview.length < sorted.length ? "\n\n全キャストの売上は添付ファイルをご確認ください。" : "")
      : "指定営業日には支払い済みの注文がありません。")
    .addFields(
      { name: "集計対象", value: scope },
      { name: "売上集計期間（支払い完了日時基準）", value: period.label },
    )
    .setFooter({ text: "追加注文を含む・購入時の確定価格・追加の引き落としなし" }).setTimestamp();
  const lines = sorted.map(([cast, total]) => `${cast ? `キャストID: ${cast}` : "キャスト未記録"}：${amount(total)}`);
  const text = [title, period.label, scope, "追加注文を含む・追加の引き落としなし", "",
    ...(lines.length ? lines : ["支払い済みの注文がありません。"])].join("\n");
  return {
    embeds: [embed],
    files: [new AttachmentBuilder(Buffer.from(text, "utf8"), { name: "kp-cast-sales.txt" })],
    allowedMentions: { parse: [] as ("users" | "roles" | "everyone")[] },
  };
}
