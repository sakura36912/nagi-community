import type { KpTicketQuote, KpTicketSelection, KpTicketSettings } from "./schema/kpTicket";

export class KpTicketError extends Error {}
export const KP_TICKET_MAX_PRICE = 2_147_483_647;

export function isKpDrink(item: { category: string; effectType: string | null; targetRoleId: string | null }): boolean {
  return item.category === "kp" && !item.effectType && !item.targetRoleId;
}

export function quoteKpTicket(
  item: { id: number; name: string; price: number; category: string; effectType: string | null; targetRoleId: string | null } | null,
  _settings: Pick<KpTicketSettings, "vipPrice" | "extensionPrice">,
  selection: KpTicketSelection,
): KpTicketQuote {
  if (selection.vip || selection.extension) {
    throw new KpTicketError("VIP・延長の受付は終了しました。最初から選び直してください。引き落としは行っていません。");
  }
  if (selection.fixedCastId && selection.castId !== selection.fixedCastId) {
    throw new KpTicketError("追加注文の指名キャストは変更できません。");
  }
  if (item && !isKpDrink(item)) throw new KpTicketError("通常のKPshop商品をドリンクとして選択してください。");
  if (!selection.castId || typeof selection.vip !== "boolean" || typeof selection.extension !== "boolean") {
    throw new KpTicketError("注文内容が不完全です。最初から選び直してください。");
  }
  if (!item || !Number.isInteger(selection.quantity) || selection.quantity! < 1 || selection.quantity! > 25
    || selection.itemId !== item.id) {
    throw new KpTicketError("注文内容が不完全です。最初から選び直してください。");
  }
  const unitPrice = item.price, quantity = selection.quantity!;
  const total = unitPrice * quantity;
  if ([unitPrice, total].some(n => !Number.isSafeInteger(n) || n < 0 || n > KP_TICKET_MAX_PRICE)) {
    throw new KpTicketError("金額が扱える範囲を超えています。管理者に連絡してください。");
  }
  return { itemId: item.id, itemName: item.name,
    unitPrice, quantity, vipPrice: 0, extensionPrice: 0, total };
}
