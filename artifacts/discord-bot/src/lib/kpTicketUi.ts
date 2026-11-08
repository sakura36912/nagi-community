import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder } from "discord.js";
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

export function pagedTicketMenu(
  session: KpTicketSession, action: "cast" | "drink", placeholder: string,
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
  const embed = new EmbedBuilder().setTitle(`${KP_SHOP_NAME} ${paid ? "購入ログ" : "支払い内容の確認"}`)
    .setColor(paid ? 0x2ecc71 : 0xf5a623)
    .addFields(
      { name: "購入者", value: `<@${session.userId}>`, inline: true },
      { name: "指名キャスト", value: `<@${s.castId}>`, inline: true },
      // Retain paid historical extras in receipts; new orders no longer offer them.
      ...(paid && s.vip ? [{ name: "VIP希望", value: `希望する（${q?.vipPrice.toLocaleString()}${currency}）` }] : []),
      ...(paid && s.extension ? [{ name: "延長希望", value: `希望する（${q?.extensionPrice.toLocaleString()}${currency}）` }] : []),
      { name: "ドリンク", value: q?.itemName.slice(0, 1024) ?? "未選択" },
      { name: "単価・数量", value: q?.itemId === null ? "ドリンクなし" : `${q?.unitPrice.toLocaleString()}${currency} × ${q?.quantity}個` },
      { name: "合計金額", value: `${q?.total.toLocaleString()}${currency}` },
    ).setFooter({ text: `注文ID: ${session.id}` });
  if (paid) embed.setTimestamp(session.paidAt ?? new Date());
  else embed.setDescription("内容を確認して「支払い確定」を押してください。確定するまでは引き落としません。");
  return embed;
}

export function confirmTicketRows(session: KpTicketSession) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(ticketId("confirm", session)).setLabel("支払い確定").setStyle(ButtonStyle.Success),
    ),
    ticketControls(session),
  ];
}
