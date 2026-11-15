import type { KpTicketQuote, KpTicketSelection, KpTicketSettings } from "./schema/kpTicket";

export class KpTicketError extends Error {}
export const KP_TICKET_MAX_PRICE = 2_147_483_647;
export const KP_VIP_HUB_ID = "1570354388462215248";
export const KP_VIP_PRICES = { shared: 200_000, solo: 200_000 } as const;
export const KP_VIP_BLACK_MEMBER_PRICE = 100_000;
export const KP_EXTENSION_PRICE = 50_000;

export function isKpDrink(item: { category: string; effectType: string | null; targetRoleId: string | null }): boolean {
  return item.category === "kp" && !item.effectType && !item.targetRoleId;
}

export function quoteKpTicket(
  item: { id: number; name: string; price: number; category: string; effectType: string | null; targetRoleId: string | null }
    | { id: number; name: string; price: number; category: string; effectType: string | null; targetRoleId: string | null }[]
    | null,
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
  if (selection.fixedCastId && selection.castId !== selection.fixedCastId) {
    throw new KpTicketError("追加注文の指名キャストは変更できません。");
  }
  if (!selection.castId || typeof selection.vip !== "boolean" || typeof selection.extension !== "boolean") {
    throw new KpTicketError("注文内容が不完全です。最初から選び直してください。");
  }
  const castIds = selection.castIds ?? [selection.castId];
  if (castIds.length < 1 || castIds.length > 2 || castIds[0] !== selection.castId
    || new Set(castIds).size !== castIds.length || castIds.some(id => !id)
    || (selection.fixedCastId && (castIds.length !== 1 || castIds[0] !== selection.fixedCastId))) {
    throw new KpTicketError("指名キャストの選択が不正です。最初から選び直してください。");
  }
  const products = item === null ? [] : Array.isArray(item) ? item : [item];
  let lines: KpTicketQuote["items"];
  if (selection.drinkSelections) {
    const drinkSelections = selection.drinkSelections;
    if (selection.itemId !== undefined || selection.quantity !== undefined
      || drinkSelections.length !== products.length || drinkSelections.length > castIds.length
      || new Set(drinkSelections.map(line => line.castId)).size !== drinkSelections.length
      || drinkSelections.some(line => !castIds.includes(line.castId))) {
      throw new KpTicketError("キャストごとのドリンク選択が不完全です。最初から選び直してください。");
    }
    const productsById = new Map(products.map(product => [product.id, product]));
    lines = drinkSelections.map(line => {
      const product = productsById.get(line.itemId);
      if (!product || !isKpDrink(product) || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 25) {
        throw new KpTicketError("通常のKPshopドリンクを選び直してください。");
      }
      return { castId: line.castId, itemId: product.id, itemName: product.name, unitPrice: product.price, quantity: line.quantity };
    });
    if (new Set(lines.map(line => line.itemId)).size !== productsById.size) {
      throw new KpTicketError("選択したドリンクが重複しています。最初から選び直してください。");
    }
  } else {
    const product = products[0];
    if (products.length > 1 || (product && !isKpDrink(product))
      || (product ? (!Number.isInteger(selection.quantity) || selection.quantity! < 1 || selection.quantity! > 25
        || selection.itemId !== product.id) : (selection.itemId !== undefined || selection.quantity !== undefined
        || (!selection.vip && !selection.extension)))) {
      throw new KpTicketError("注文内容が不完全です。最初から選び直してください。");
    }
    lines = product ? [{ castId: selection.castId, itemId: product.id, itemName: product.name, unitPrice: product.price,
      quantity: selection.quantity! }] : [];
  }
  if (castIds.length === 2 && lines!.length !== 0 && lines!.length !== 2) {
    throw new KpTicketError("2人指名では、各キャストの1stドリンクを選択してください。");
  }
  if (castIds.length === 2 && !lines!.length && !selection.vip && !selection.extension) {
    throw new KpTicketError("2人指名では、各キャストの1stドリンクを選択してください。");
  }
  if (!lines!.length && !selection.vip && !selection.extension) {
    throw new KpTicketError("注文内容が不完全です。最初から選び直してください。");
  }
  if (selection.vipDiscountApplied && !selection.vip) {
    throw new KpTicketError("VIP割引の対象が不正です。最初から選び直してください。");
  }
  const vipPrice = selection.vip
    ? selection.vipDiscountApplied ? KP_VIP_BLACK_MEMBER_PRICE : KP_VIP_PRICES[selection.vipTier!]
    : 0;
  const extensionPrice = selection.extension ? KP_EXTENSION_PRICE : 0;
  const drinkTotal = lines!.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
  const unitPrice = lines![0]?.unitPrice ?? 0;
  const quantity = lines!.reduce((sum, line) => sum + line.quantity, 0);
  const total = drinkTotal + vipPrice + extensionPrice;
  if ([...lines!.map(line => line.unitPrice), drinkTotal, total].some(n => !Number.isSafeInteger(n) || n < 0 || n > KP_TICKET_MAX_PRICE)) {
    throw new KpTicketError("金額が扱える範囲を超えています。管理者に連絡してください。");
  }
  return { itemId: lines![0]?.itemId ?? null,
    itemName: lines!.length ? lines!.map(line => line.itemName).join(" / ") : "ドリンクなし",
    unitPrice, quantity, items: lines, vipPrice, extensionPrice, total };
}
