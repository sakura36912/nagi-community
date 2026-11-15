import { describe, expect, it } from "vitest";
import { quoteKpTicket, isKpDrink } from "../../../../lib/db/src/kpTicketPricing";
import type { KpTicketSelection } from "@workspace/db";
import { pagedTicketMenu } from "../lib/kpTicketUi";

const item = { id: 1, name: "ドリンク", price: 100, category: "kp", effectType: null, targetRoleId: null };
const item2 = { id: 2, name: "お茶", price: 250, category: "kp", effectType: null, targetRoleId: null };
const selection: KpTicketSelection = { castId: "cast", itemId: 1, quantity: 3, vip: false, extension: false };

describe("KP ticket pricing and paging", () => {
  const settings = { vipPrice: null, extensionPrice: null };
  const vip = (tier: "solo" | "shared"): KpTicketSelection => ({
    castId: "cast", vip: true, extension: false, serviceVersion: 2, vipTier: tier,
    customerIds: tier === "shared" ? ["buyer", "guest"] : ["buyer"],
  });
  it.each([["shared", 400000], ["solo", 200000]] as const)("charges the fixed %s VIP rate, not old settings", (tier, price) => {
    expect(quoteKpTicket(null, settings, vip(tier))).toMatchObject({ itemId: null, quantity: 0, vipPrice: price, total: price });
    if (tier === "solo") {
      expect(quoteKpTicket(item, { vipPrice: 1, extensionPrice: 1 }, { ...selection, ...vip(tier) }).total).toBe(price + 300);
    } else {
      expect(() => quoteKpTicket(item, settings, { ...selection, ...vip(tier) })).toThrow("お客様ごとにドリンク");
    }
  });
  it.each([["shared", 200000], ["solo", 100000]] as const)("halves %s VIP for the black-member orderer", (tier, price) => {
    const discounted = { ...vip(tier), vipDiscountApplied: true };
    expect(quoteKpTicket(null, settings, discounted)).toMatchObject({ vipPrice: price, total: price });
    if (tier === "solo") {
      expect(quoteKpTicket(item, settings, { ...selection, ...discounted }).total).toBe(price + 300);
    } else {
      expect(() => quoteKpTicket(item, settings, { ...selection, ...discounted })).toThrow("お客様ごとにドリンク");
    }
  });
  it("charges each of two VIP customers their full fee and assigns one drink per customer and cast", () => {
    const selection: KpTicketSelection = {
      castId: "cast-a", castIds: ["cast-a", "cast-b"], customerIds: ["buyer", "guest"],
      vip: true, vipTier: "shared", vipDiscountApplied: false, extension: false, serviceVersion: 2,
      drinkSelections: [
        { customerId: "buyer", castId: "cast-a", itemId: 1, quantity: 1 },
        { customerId: "buyer", castId: "cast-b", itemId: 2, quantity: 1 },
        { customerId: "guest", castId: "cast-a", itemId: 1, quantity: 1 },
        { customerId: "guest", castId: "cast-b", itemId: 2, quantity: 1 },
      ],
    };
    const quote = quoteKpTicket([item, item2, item, item2], settings, selection, "buyer");
    expect(quote).toMatchObject({
      vipPrice: 400000, total: 400700,
      customerPayments: [
        { customerId: "buyer", vipPrice: 200000, drinkPrice: 350, total: 200350 },
        { customerId: "guest", vipPrice: 200000, drinkPrice: 350, total: 200350 },
      ],
    });
  });
  it("sums two cast-specific first drinks and the same VIP charge", () => {
    const twoCast: KpTicketSelection = {
      castId: "cast-a", castIds: ["cast-a", "cast-b"], vip: true, extension: false,
      serviceVersion: 2, vipTier: "solo", vipDiscountApplied: true,
      drinkSelections: [
        { castId: "cast-a", itemId: 1, quantity: 1 },
        { castId: "cast-b", itemId: 2, quantity: 1 },
      ],
    };
    expect(quoteKpTicket([item, item2], settings, twoCast)).toMatchObject({
      total: 100350, vipPrice: 100000, quantity: 2,
      items: [
        { castId: "cast-a", itemId: 1, unitPrice: 100, quantity: 1 },
        { castId: "cast-b", itemId: 2, unitPrice: 250, quantity: 1 },
      ],
    });
    expect(() => quoteKpTicket([item], settings, twoCast)).toThrow("不完全");
    expect(() => quoteKpTicket([item], settings, {
      ...twoCast, drinkSelections: [{ castId: "cast-a", itemId: 1, quantity: 1 }],
    })).toThrow("各キャスト");
  });
  it("records two different first drinks against their selected casts", () => {
    const twoCast: KpTicketSelection = {
      castId: "cast-a", castIds: ["cast-a", "cast-b"], vip: false, extension: false,
      drinkSelections: [
        { castId: "cast-a", itemId: 1, quantity: 1 },
        { castId: "cast-b", itemId: 2, quantity: 1 },
      ],
    };
    expect(quoteKpTicket([item, item2], settings, twoCast)).toMatchObject({
      total: 350, items: [{ castId: "cast-a" }, { castId: "cast-b" }],
    });
  });
  it("charges 50,000 only for additional extension with or without drinks", () => {
    const extension: KpTicketSelection = { castId: "cast", fixedCastId: "cast", baseOrderId: "paid",
      serviceVersion: 2, vip: false, extension: true };
    expect(quoteKpTicket(null, settings, extension)).toMatchObject({ total: 50000, extensionPrice: 50000, vipPrice: 0 });
    expect(quoteKpTicket(item, settings, { ...selection, ...extension }).total).toBe(50300);
    expect(() => quoteKpTicket(null, settings, { ...extension, fixedCastId: undefined })).toThrow("追加注文");
    expect(() => quoteKpTicket(null, settings, { ...extension, baseOrderId: undefined })).toThrow("追加注文");
    expect(() => quoteKpTicket(null, settings, { ...extension, vipActive: true })).toThrow("延長を追加できません");
    expect(() => quoteKpTicket(null, settings, { ...extension, vip: true, vipTier: "solo" })).toThrow("延長を追加できません");
  });
  it("requires the selected second customer for shared VIP and rejects malformed extras", () => {
    expect(quoteKpTicket(null, settings, vip("shared")).total).toBe(400000);
    expect(() => quoteKpTicket(null, settings, { ...vip("shared"), customerIds: ["buyer"] })).toThrow("人数");
    expect(() => quoteKpTicket(null, settings, { ...vip("solo"), vipActive: true })).toThrow("重複");
    expect(() => quoteKpTicket(null, settings, { ...vip("solo"), vipTier: undefined })).toThrow("選び直し");
    expect(() => quoteKpTicket(null, settings, { ...vip("solo"), quantity: 1 })).toThrow("不完全");
  });
  it("quotes additional VIP or extension without forcing a drink purchase", () => {
    const extra = { castId: "cast", fixedCastId: "cast", vip: true, extension: true };
    expect(() => quoteKpTicket(null, { vipPrice: 500, extensionPrice: 200 }, extra)).toThrow("受付は終了");
    expect(() => quoteKpTicket(null, { vipPrice: 0, extensionPrice: null }, { ...extra, extension: false })).toThrow("受付は終了");
    expect(() => quoteKpTicket(null, { vipPrice: null, extensionPrice: 200 }, extra)).toThrow("受付は終了");
    expect(() => quoteKpTicket(null, { vipPrice: 500, extensionPrice: 200 }, { ...extra, vip: false, extension: false })).toThrow("不完全");
    expect(() => quoteKpTicket(null, { vipPrice: 500, extensionPrice: 200 }, { ...selection, itemId: undefined, quantity: undefined })).toThrow("不完全");
    expect(() => quoteKpTicket(item, { vipPrice: 500, extensionPrice: 200 }, { ...selection, fixedCastId: "other" })).toThrow("変更できません");
  });
  it("charges only drinks even with legacy configured extra fees", () => {
    expect(quoteKpTicket(item, { vipPrice: 500, extensionPrice: 200 }, selection))
      .toMatchObject({ total: 300, quantity: 3, vipPrice: 0, extensionPrice: 0 });
  });
  it("blocks an unset requested charge instead of treating it as free", () => {
    expect(() => quoteKpTicket(item, { vipPrice: null, extensionPrice: 200 }, { ...selection, vip: true })).toThrow("受付は終了");
    expect(() => quoteKpTicket(item, { vipPrice: 500, extensionPrice: null }, { ...selection, extension: true })).toThrow("受付は終了");
  });
  it("supports an explicitly free price and unrequested unset extras", () => {
    expect(quoteKpTicket(item, { vipPrice: 0, extensionPrice: 0 }, selection).total).toBe(300);
    expect(quoteKpTicket(item, { vipPrice: null, extensionPrice: null }, { ...selection, vip: false, extension: false }).total).toBe(300);
  });
  it.each([0, 26, -1, 1.5, NaN])("rejects invalid quantity %s", quantity => {
    expect(() => quoteKpTicket(item, { vipPrice: 0, extensionPrice: 0 }, { ...selection, quantity })).toThrow();
  });
  it("rejects another shop, role products and incomplete selections", () => {
    expect(isKpDrink({ ...item, category: "general" })).toBe(false);
    expect(isKpDrink({ ...item, targetRoleId: "role" })).toBe(false);
    expect(() => quoteKpTicket(item, { vipPrice: 0, extensionPrice: 0 }, { ...selection, castId: undefined })).toThrow();
  });
  it("rejects negative and overflowing totals", () => {
    expect(() => quoteKpTicket({ ...item, price: -100 }, { vipPrice: 0, extensionPrice: 0 }, selection)).toThrow();
    expect(() => quoteKpTicket({ ...item, price: 2147483647 }, { vipPrice: 0, extensionPrice: 0 }, selection)).toThrow();
  });
  it("paginates all candidates without exposing more than 25 in one menu", () => {
    const session = { id: "order", version: 1 } as Parameters<typeof pagedTicketMenu>[0];
    const options = Array.from({ length: 61 }, (_, i) => ({ label: `候補${i}`, value: `${i}` }));
    const result = [0, 1, 2].flatMap(page => {
      const menu = pagedTicketMenu(session, "cast", "指名", options, page)[0]!.toJSON();
      const component = menu.components[0] as { options: { value: string }[] };
      expect(component.options.length).toBeLessThanOrEqual(25);
      return component.options.map(o => o.value);
    });
    expect(result).toEqual(options.map(o => o.value));
  });
});
