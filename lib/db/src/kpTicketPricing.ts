import type { KpTicketQuote, KpTicketSelection, KpTicketSettings } from "./schema/kpTicket";

export class KpTicketError extends Error {}
export const KP_TICKET_MAX_PRICE = 2_147_483_647;

export function isKpDrink(item: { category: string; effectType: string | null; targetRoleId: string | null }): boolean {
  return item.category === "kp" && !item.effectType && !item.targetRoleId;
}

export function quoteKpTicket(
  item: { id: number; name: string; price: number; category: string; effectType: string | null; targetRoleId: string | null },
  settings: Pick<KpTicketSettings, "vipPrice" | "extensionPrice">,
  selection: KpTicketSelection,
): KpTicketQuote {
  if (!isKpDrink(item)) throw new KpTicketError("通常のKPshop商品をドリンクとして選択してください。");
  if (!selection.castId || typeof selection.vip !== "boolean" || typeof selection.extension !== "boolean"
    || !Number.isInteger(selection.quantity) || selection.quantity! < 1 || selection.quantity! > 25
    || selection.itemId !== item.id) throw new KpTicketError("注文内容が不完全です。最初から選び直してください。");
  if (selection.vip && settings.vipPrice === null) throw new KpTicketError("VIP料金が未設定です。管理者が設定するまでVIP付きの支払いはできません。");
  if (selection.extension && settings.extensionPrice === null) throw new KpTicketError("延長料金が未設定です。管理者が設定するまで延長付きの支払いはできません。");
  const vipPrice = selection.vip ? settings.vipPrice! : 0;
  const extensionPrice = selection.extension ? settings.extensionPrice! : 0;
  const total = item.price * selection.quantity! + vipPrice + extensionPrice;
  if ([item.price, vipPrice, extensionPrice, total].some(n => !Number.isSafeInteger(n) || n < 0 || n > KP_TICKET_MAX_PRICE)) {
    throw new KpTicketError("金額が扱える範囲を超えています。管理者に連絡してください。");
  }
  return { itemId: item.id, itemName: item.name, unitPrice: item.price, quantity: selection.quantity!, vipPrice, extensionPrice, total };
}
