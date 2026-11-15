import { AttachmentBuilder, EmbedBuilder, escapeMarkdown } from "discord.js";
import { KpTicketError, type KpTicketSession } from "@workspace/db";
import type { KpBusinessDay } from "./kpBusinessDay";

const date = (value: Date | null) => value
  ? value.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false }) + " JST"
  : "未記録";

/** Paid order snapshots are the source of truth: no second customer ledger or new debit. */
export function kpCustomers(
  orders: KpTicketSession[], currency: string, userId: string | undefined, page: number, period: KpBusinessDay,
) {
  const selected = orders.filter(order => order.phase === "paid" && order.paidAt
    && order.paidAt >= period.start && order.paidAt < period.end
    && (!userId || (order.selection.customerIds ?? [order.userId]).includes(userId)));
  const customers = new Map<string, {
    id: string; tickets: Set<string>; orders: number; total: bigint;
    first: Date | null; last: Date | null; casts: Set<string>;
  }>();
  for (const order of selected) {
    if (!order.selection.quote) throw new KpTicketError("支払い済み注文の明細が不完全です。管理者に確認を依頼してください。");
    const payerIds = order.selection.quote.customerPayments?.map(payment => payment.customerId)
      ?? order.selection.customerIds ?? [order.userId];
    for (const payerId of payerIds) {
      const customer = customers.get(payerId) ?? {
        id: payerId, tickets: new Set<string>(), orders: 0, total: 0n,
        first: null, last: null, casts: new Set<string>(),
      };
      customer.tickets.add(order.channelId);
      customer.orders++;
      const payment = order.selection.quote.customerPayments?.find(row => row.customerId === payerId);
      customer.total += BigInt(payment?.total ?? order.selection.quote.total);
      for (const castId of order.selection.castIds ?? (order.selection.castId ? [order.selection.castId] : [])) {
        customer.casts.add(castId);
      }
      if (order.paidAt) {
        if (!customer.first || order.paidAt < customer.first) customer.first = order.paidAt;
        if (!customer.last || order.paidAt > customer.last) customer.last = order.paidAt;
      }
      customers.set(payerId, customer);
    }
  }
  const rows = [...customers.values()].sort((a, b) =>
    (b.last?.getTime() ?? 0) - (a.last?.getTime() ?? 0) || a.id.localeCompare(b.id));
  const detail = [...selected].sort((a, b) =>
    (b.paidAt?.getTime() ?? 0) - (a.paidAt?.getTime() ?? 0) || a.id.localeCompare(b.id));
  const size = userId ? 8 : 10;
  const pages = Math.max(1, Math.ceil((userId ? detail.length : rows.length) / size));
  if (!Number.isInteger(page) || page < 1 || page > pages) throw new KpTicketError(`ページは1〜${pages}で指定してください。`);
  const summary = (row: typeof rows[number]) => [
    `顧客ID: ${row.id}`,
    `利用チケット: ${row.tickets.size}件 / 注文: ${row.orders}件 / 累計: ${row.total.toLocaleString()}${currency}`,
    `初回支払い: ${date(row.first)} / 最終支払い: ${date(row.last)}`,
    `担当キャストID: ${[...row.casts].sort().join(", ") || "未記録"}`,
  ].join("\n");
  const orderText = (order: KpTicketSession) => {
    const quote = order.selection.quote!;
    const castIds = order.selection.castIds ?? (order.selection.castId ? [order.selection.castId] : []);
    const drinks = quote.items?.length
      ? quote.items.filter(line => !userId || !line.customerId || line.customerId === userId)
        .map(line => `${line.itemName} × ${line.quantity}（キャストID: ${line.castId}）`).join(" / ")
      : `${quote.itemName} × ${quote.quantity}`;
    const payment = quote.customerPayments?.find(row => row.customerId === userId);
    const amount = payment?.total ?? quote.total;
    return `支払日時: ${date(order.paidAt)}\n注文ID: ${order.id} / チケットID: ${order.channelId}\n`
      + `キャストID: ${castIds.join(", ") || "未記録"}\n`
      + `${drinks || "ドリンク明細なし"} / 支払額: ${amount.toLocaleString()}${currency}`;
  };
  const offset = (page - 1) * size;
  const preview = userId
    ? detail.slice(offset, offset + size).map(order =>
      `${date(order.paidAt)} / ${escapeMarkdown((order.selection.quote!.items?.filter(line => !line.customerId || line.customerId === userId)
        .map(line => line.itemName).join(" / ")
        || order.selection.quote!.itemName).slice(0, 80))}\n`
      + `${(order.selection.quote!.customerPayments?.find(payment => payment.customerId === userId)?.total
        ?? order.selection.quote!.total).toLocaleString()}${currency} / キャスト: ${(order.selection.castIds
        ?? (order.selection.castId ? [order.selection.castId] : [])).map(id => `<@${id}>`).join(", ") || "未記録"}\nチケットID: ${order.channelId}`)
    : rows.slice(offset, offset + size).map(row =>
      `<@${row.id}>\nチケット ${row.tickets.size}件 / 注文 ${row.orders}件 / 累計 ${row.total.toLocaleString()}${currency}\n最終支払い: ${date(row.last)}`);
  const embed = new EmbedBuilder().setTitle(userId ? "KP島 — 顧客の利用履歴" : "KP島 — 利用顧客一覧")
    .setColor(0xd49b43)
    .setDescription(preview.join("\n\n") || "支払い済みの利用記録はありません。")
    .setFooter({ text: `${page}/${pages}ページ・${period.label}・削除済みチケットを含む・追加の引き落としなし` });
  if (userId) {
    const row = customers.get(userId);
    embed.addFields({ name: "顧客", value: `<@${userId}>（${userId}）` },
      { name: "累計", value: row ? `${row.tickets.size}チケット / ${row.orders}注文 / ${row.total.toLocaleString()}${currency}` : "記録なし" });
  } else {
    embed.addFields({ name: "顧客数", value: `${rows.length}人` });
  }
  const text = `KP島 利用顧客記録（${period.label}・支払い済みのみ・日時は日本時間）\n`
    + "チケット数はチャンネルIDの重複を除外。追加注文は注文数に含みます。\n\n"
    + rows.map(summary).join("\n\n")
    + (userId ? "\n\n【全注文履歴】\n" + detail.map(orderText).join("\n\n") : "");
  return {
    embeds: [embed],
    files: [new AttachmentBuilder(Buffer.from(text, "utf8"), { name: userId ? "kp-customer-history.txt" : "kp-customers.txt" })],
    allowedMentions: { parse: [] as never[] },
  };
}
