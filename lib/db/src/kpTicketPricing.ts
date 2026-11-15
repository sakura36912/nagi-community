import type { KpTicketCustomerPayment, KpTicketQuote, KpTicketSelection, KpTicketSettings } from "./schema/kpTicket";

export class KpTicketError extends Error {}
export const KP_TICKET_MAX_PRICE = 2_147_483_647;
export const KP_VIP_HUB_ID = "1570354388462215248";
export const KP_VIP_PRICE_PER_CUSTOMER = 200_000;
export const KP_VIP_BLACK_MEMBER_PRICE_PER_CUSTOMER = 100_000;
/** Kept for callers that display the standard one-customer base price. */
export const KP_VIP_PRICES = { shared: 400_000, solo: KP_VIP_PRICE_PER_CUSTOMER } as const;
/** Kept for callers that display the discounted one-customer base price. */
export const KP_VIP_BLACK_MEMBER_PRICE = KP_VIP_BLACK_MEMBER_PRICE_PER_CUSTOMER;
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
  orderUserId = selection.customerIds?.[0] ?? "buyer",
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
  const customerIds = selection.customerIds ?? [orderUserId];
  if (customerIds.length < 1 || customerIds.length > 2 || customerIds[0] !== orderUserId
    || new Set(customerIds).size !== customerIds.length || customerIds.some(id => !id)) {
    throw new KpTicketError("お客様の選択が不正です。最初から選び直してください。");
  }
  if ((selection.vipTier === "shared" && customerIds.length !== 2)
    || (selection.vipTier === "solo" && customerIds.length !== 1)
    || (!selection.vip && customerIds.length !== 1)) {
    throw new KpTicketError("お客様の人数とVIP種類が一致しません。最初から選び直してください。");
  }
  const products = item === null ? [] : Array.isArray(item) ? item : [item];
  let lines: KpTicketQuote["items"];
  if (selection.drinkSelections) {
    const drinkSelections = selection.drinkSelections;
    const expectedPairs = customerIds.flatMap(customerId => castIds.map(castId => `${customerId}:${castId}`));
    const selectedPairs = drinkSelections.map(line => `${line.customerId ?? customerIds[0]}:${line.castId}`);
    if (selection.itemId !== undefined || selection.quantity !== undefined
      || drinkSelections.length !== products.length || drinkSelections.length > expectedPairs.length
      || new Set(selectedPairs).size !== drinkSelections.length
      || drinkSelections.some(line => !castIds.includes(line.castId)
        || !customerIds.includes(line.customerId ?? customerIds[0]!))) {
      throw new KpTicketError("キャストごとのドリンク選択が不完全です。最初から選び直してください。");
    }
    const productsById = new Map(products.map(product => [product.id, product]));
    lines = drinkSelections.map(line => {
      const product = productsById.get(line.itemId);
      if (!product || !isKpDrink(product) || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 25) {
        throw new KpTicketError("通常のKPshopドリンクを選び直してください。");
      }
      return { customerId: line.customerId ?? customerIds[0]!, castId: line.castId, itemId: product.id,
        itemName: product.name, unitPrice: product.price, quantity: line.quantity };
    });
    if (lines.length > 0 && lines.length !== expectedPairs.length) {
      throw new KpTicketError("各お客様・各キャストの1stドリンクを選択してください。");
    }
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
    if (customerIds.length > 1 && product) {
      throw new KpTicketError("2人利用では、お客様ごとにドリンクを選択してください。");
    }
    lines = product ? [{ customerId: customerIds[0]!, castId: selection.castId, itemId: product.id, itemName: product.name, unitPrice: product.price,
      quantity: selection.quantity! }] : [];
  }
  const expectedDrinkCount = customerIds.length * castIds.length;
  if (lines!.length && lines!.length !== expectedDrinkCount) {
    throw new KpTicketError("2人指名では、各キャストの1stドリンクを選択してください。");
  }
  if (!lines!.length && !selection.vip && !selection.extension) {
    throw new KpTicketError("2人指名では、各キャストの1stドリンクを選択してください。");
  }
  if (selection.vipDiscountApplied && !selection.vip) {
    throw new KpTicketError("VIP割引の対象が不正です。最初から選び直してください。");
  }
  const vipPricePerCustomer = selection.vip
    ? selection.vipDiscountApplied ? KP_VIP_BLACK_MEMBER_PRICE_PER_CUSTOMER : KP_VIP_PRICE_PER_CUSTOMER
    : 0;
  const vipPrice = vipPricePerCustomer * customerIds.length;
  const extensionPrice = selection.extension ? KP_EXTENSION_PRICE : 0;
  const drinkTotal = lines!.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
  const unitPrice = lines![0]?.unitPrice ?? 0;
  const quantity = lines!.reduce((sum, line) => sum + line.quantity, 0);
  const total = drinkTotal + vipPrice + extensionPrice;
  if ([...lines!.map(line => line.unitPrice), drinkTotal, total].some(n => !Number.isSafeInteger(n) || n < 0 || n > KP_TICKET_MAX_PRICE)) {
    throw new KpTicketError("金額が扱える範囲を超えています。管理者に連絡してください。");
  }
  const customerPayments: KpTicketCustomerPayment[] = customerIds.map(customerId => {
    const customerDrinkPrice = lines!.filter(line => line.customerId === customerId)
      .reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
    const customerVipPrice = customerId === orderUserId ? vipPricePerCustomer + (selection.extension ? extensionPrice : 0)
      : vipPricePerCustomer;
    return { customerId, drinkPrice: customerDrinkPrice, vipPrice: vipPricePerCustomer,
      extensionPrice: customerId === orderUserId ? extensionPrice : 0,
      total: customerDrinkPrice + customerVipPrice };
  });
  return { itemId: lines![0]?.itemId ?? null,
    itemName: lines!.length ? lines!.map(line => line.itemName).join(" / ") : "ドリンクなし",
    unitPrice, quantity, items: lines, customerPayments, vipPrice, extensionPrice, total };
}
