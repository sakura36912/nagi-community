import type { KpTicketQuote, KpTicketSelection, KpTicketSettings } from "./schema/kpTicket";

export class KpTicketError extends Error {}
export const KP_TICKET_MAX_PRICE = 2_147_483_647;
export const KP_VIP_HUB_ID = "1570354388462215248";
export const KP_VIP_PRICES = { shared: 100_000, solo: 200_000 } as const;
export const KP_EXTENSION_PRICE = 50_000;

export function isKpDrink(item: { category: string; effectType: string | null; targetRoleId: string | null }): boolean {
  return item.category === "kp" && !item.effectType && !item.targetRoleId;
}

export function quoteKpTicket(
  item: { id: number; name: string; price: number; category: string; effectType: string | null; targetRoleId: string | null } | null,
  _settings: Pick<KpTicketSettings, "vipPrice" | "extensionPrice">,
  selection: KpTicketSelection,
): KpTicketQuote {
  if ((selection.vip || selection.extension) && selection.serviceVersion !== 2) {
    throw new KpTicketError("以前のVIP・延長の受付は終了しました。最初から選び直してください。引き落としは行っていません。");
  }
  if (selection.extension && (!selection.fixedCastId || !selection.baseOrderId)) {
    throw new KpTicketError("延長は支払い済み注文の追加注文からのみ利用できます。");
  }
  if (selection.extension && (selection.vip || selection.vipActive)) {
    throw new KpTicketError("VIP利用には延長を追加できません。");
  }
  if (selection.vip && (selection.vipActive || !selection.vipTier || !(selection.vipTier in KP_VIP_PRICES))) {
    throw new KpTicketError("VIPを選び直してください。VIPの重複購入はできません。");
  }
  if (selection.vip && selection.vipTier === "shared"
    && (!selection.guestId || selection.guestId === selection.castId)) {
    throw new KpTicketError("VIPを一緒に利用するお客様を選択してください。");
  }
  if (selection.fixedCastId && selection.castId !== selection.fixedCastId) {
    throw new KpTicketError("追加注文の指名キャストは変更できません。");
  }
  if (item && !isKpDrink(item)) throw new KpTicketError("通常のKPshop商品をドリンクとして選択してください。");
  if (!selection.castId || typeof selection.vip !== "boolean" || typeof selection.extension !== "boolean") {
    throw new KpTicketError("注文内容が不完全です。最初から選び直してください。");
  }
  if (item ? (!Number.isInteger(selection.quantity) || selection.quantity! < 1 || selection.quantity! > 25
    || selection.itemId !== item.id) : (selection.itemId !== undefined || selection.quantity !== undefined
      || (!selection.vip && !selection.extension))) {
    throw new KpTicketError("注文内容が不完全です。最初から選び直してください。");
  }
  const unitPrice = item?.price ?? 0, quantity = item ? selection.quantity! : 0;
  const vipPrice = selection.vip ? KP_VIP_PRICES[selection.vipTier!] : 0;
  const extensionPrice = selection.extension ? KP_EXTENSION_PRICE : 0;
  const total = unitPrice * quantity + vipPrice + extensionPrice;
  if ([unitPrice, total].some(n => !Number.isSafeInteger(n) || n < 0 || n > KP_TICKET_MAX_PRICE)) {
    throw new KpTicketError("金額が扱える範囲を超えています。管理者に連絡してください。");
  }
  return { itemId: item?.id ?? null, itemName: item?.name ?? "ドリンクなし",
    unitPrice, quantity, vipPrice, extensionPrice, total };
}
