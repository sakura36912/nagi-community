import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, UserSelectMenuBuilder } from "discord.js";
import type { KpTicketPhase, KpTicketSession } from "@workspace/db";
import { KP_SHOP_NAME } from "./kpShop";

export const KP_TICKET_PREFIX = "shop:kp-ticket:";
export const ticketId = (action: string, session: KpTicketSession, page = 0) =>
  `${KP_TICKET_PREFIX}${action}:${session.id}:${session.version}:${page}`;

export function ticketControls(session: KpTicketSession) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(ticketId("reset", session)).setLabel("最初から選び直す").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(ticketId("cancel", session)).setLabel("キャンセル").setStyle(ButtonStyle.Danger),
  );
}

export function ticketMenu(session: KpTicketSession, action: KpTicketPhase, placeholder: string, options: { label: string; value: string; description?: string }[]) {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId(ticketId(action, session)).setPlaceholder(placeholder)
      .addOptions(options.map(o => ({ ...o, label: o.label.slice(0, 100), ...(o.description ? { description: o.description.slice(0, 100) } : {}) }))),
  );
}

export function ticketCustomerMenu(session: KpTicketSession) {
  return new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
    new UserSelectMenuBuilder().setCustomId(ticketId("guest", session))
      .setPlaceholder("2人目のお客様を選択").setMinValues(1).setMaxValues(1),
  );
}

export function pagedTicketMenu(
  session: KpTicketSession, action: "cast" | "cast2" | "drink" | "drink2", placeholder: string,
  options: { label: string; value: string; description?: string }[], page = 0,
) {
  const pages = Math.ceil(options.length / 25);
  if (!pages || !Number.isInteger(page) || page < 0 || page >= pages) throw new Error("選択肢またはページが無効です。");
  const rows: (ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>)[] = [
    ticketMenu(session, action, `${placeholder} (${page + 1}/${pages})`, options.slice(page * 25, (page + 1) * 25)),
  ];
  if (pages > 1) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(ticketId(`${action}-page`, session, page - 1)).setLabel("前へ").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(ticketId(`${action}-page`, session, page + 1)).setLabel("次へ").setStyle(ButtonStyle.Secondary).setDisabled(page === pages - 1),
  ));
  rows.push(ticketControls(session));
  return rows;
}

export function ticketSummary(session: KpTicketSession, currency: string, paid = false) {
  const s = session.selection, q = s.quote;
  const castIds = s.castIds ?? (s.castId ? [s.castId] : []);
  const drinkDescription = q?.items?.length
    ? q.items.map(item => `<@${item.customerId ?? session.userId}> → <@${item.castId}>：${item.itemName} × ${item.quantity}個`).join("\n")
    : q?.itemName ?? "未選択";
  const drinkPrices = q?.items?.length
    ? q.items.map(item => `<@${item.castId}>：${item.unitPrice.toLocaleString()}${currency} × ${item.quantity}`).join("\n")
    : q?.itemId === null ? "ドリンクなし" : `${q?.unitPrice.toLocaleString()}${currency} × ${q?.quantity}個`;
  const embed = new EmbedBuilder().setTitle(`${KP_SHOP_NAME} ${paid ? "購入ログ" : "支払い内容の確認"}`)
    .setColor(paid ? 0x2ecc71 : 0xf5a623)
    .addFields(
      { name: "お客様", value: (s.customerIds ?? [session.userId]).map(id => `<@${id}>`).join("\n"), inline: true },
      { name: "指名キャスト", value: castIds.map(id => `<@${id}>`).join("\n") || "未選択", inline: true },
      ...(s.vip ? [{ name: "VIP", value: `${s.vipTier === "shared" ? "お客様2人" : s.vipTier === "solo" ? "お客様1人" : "希望する"}・キャスト${castIds.length}人（${q?.vipPrice.toLocaleString()}${currency}）` }] : []),
      ...(q?.customerPayments?.length ? [{
        name: "お客様ごとの支払額",
        value: q.customerPayments.map(payment =>
          `<@${payment.customerId}>：VIP ${payment.vipPrice.toLocaleString()}${currency}`
          + (payment.drinkPrice ? `・ドリンク ${payment.drinkPrice.toLocaleString()}${currency}` : "")
          + (payment.extensionPrice ? `・延長 ${payment.extensionPrice.toLocaleString()}${currency}` : "")
          + `・合計 ${payment.total.toLocaleString()}${currency}`,
        ).join("\n").slice(0, 1024),
      }] : []),
      ...(paid && s.vip && s.guestId ? [{ name: "同伴のお客様（過去の記録）", value: `<@${s.guestId}>` }] : []),
      ...(s.extension ? [{ name: "延長", value: `1回（${q?.extensionPrice.toLocaleString()}${currency}）` }] : []),
      { name: "ドリンク", value: drinkDescription.slice(0, 1024) },
      { name: "単価・数量", value: drinkPrices.slice(0, 1024) },
      { name: "合計金額", value: `${q?.total.toLocaleString()}${currency}` },
    ).setFooter({ text: `注文ID: ${session.id}` });
  if (paid) embed.setTimestamp(session.paidAt ?? new Date());
  else embed.setDescription(session.selection.paymentMessageId
    ? "各お客様は自分の支払いボタンを押してください。両者の確認が完了するまで引き落としません。"
    : (s.customerIds?.length ?? 1) === 2
      ? "内容を確認して「2人へ支払い依頼を送る」を押してください。依頼を送るだけでは引き落としません。"
      : "内容を確認して「支払い確定」を押してください。確定するまでは引き落としません。");
  return embed;
}

export function confirmTicketRows(session: KpTicketSession) {
  if ((session.selection.customerIds?.length ?? 1) === 2) {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(ticketId("request-payments", session))
          .setLabel("2人へ支払い依頼を送る").setStyle(ButtonStyle.Success),
      ),
      ticketControls(session),
    ];
  }
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(ticketId("confirm", session)).setLabel("支払い確定").setStyle(ButtonStyle.Success),
    ),
    ticketControls(session),
  ];
}

export function customerPaymentRows(session: KpTicketSession, disabled = false) {
  const payments = session.selection.quote?.customerPayments ?? [];
  const approved = new Set(session.selection.paymentApprovals ?? []);
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...payments.map(payment => new ButtonBuilder()
      .setCustomId(`${KP_TICKET_PREFIX}pay:${session.id}:${payment.customerId}`)
      .setLabel(`${payment.total.toLocaleString()}＄を支払う`)
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled || approved.has(payment.customerId))),
  )];
}
