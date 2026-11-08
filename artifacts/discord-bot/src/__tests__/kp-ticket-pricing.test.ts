import { describe, expect, it } from "vitest";
import { quoteKpTicket, isKpDrink } from "../../../../lib/db/src/kpTicketPricing";
import type { KpTicketSelection } from "@workspace/db";
import { pagedTicketMenu } from "../lib/kpTicketUi";

const item = { id: 1, name: "ドリンク", price: 100, category: "kp", effectType: null, targetRoleId: null };
const selection: KpTicketSelection = { castId: "cast", itemId: 1, quantity: 3, vip: false, extension: false };

describe("KP ticket pricing and paging", () => {
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
