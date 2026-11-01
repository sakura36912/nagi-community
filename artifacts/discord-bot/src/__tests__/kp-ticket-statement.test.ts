import { describe, expect, it } from "vitest";
import type { KpTicketSession } from "@workspace/db";
import { kpTicketStatement } from "../lib/kpTicketStatement";

function paid(id: string, extras = false): KpTicketSession {
  return {
    id, guildId: "guild", channelId: "ticket", userId: `buyer-${id}`,
    phase: "paid", version: 1, createdAt: new Date(0), paidAt: new Date(1000),
    expiresAt: new Date(0), logMessageId: null,
    selection: { castId: `cast-${id}`, vip: extras, extension: extras,
      quote: { itemId: 1, itemName: "ドリンク", quantity: 2, unitPrice: 100,
        vipPrice: extras ? 500 : 0, extensionPrice: extras ? 200 : 0, total: extras ? 900 : 200 } },
  };
}
describe("KP ticket paid statement", () => {
  it("includes extra-only purchases in VIP/extension totals without adding a drink", () => {
    const additional = paid("extra");
    additional.selection.quote = { itemId: null, itemName: "VIP・延長のみ（ドリンクなし）",
      unitPrice: 0, quantity: 0, vipPrice: 500, extensionPrice: 200, total: 700 };
    const result = kpTicketStatement([paid("1"), additional], "円");
    expect(result.embeds[0]!.toJSON().fields![0]!.value).toBe(
      "ドリンク代: 200円\nVIP料金: 500円\n延長料金: 200円\n支払い済み合計: 900円");
    expect(result.embeds[0]!.toJSON().description).not.toContain("× 0個");
  });
  it("combines original and additional paid orders using historical prices, even expired or unlogged orders", () => {
    const result = kpTicketStatement([paid("1", true), paid("2")], "円");
    expect(result.embeds[0]!.toJSON().fields![0]!.value).toBe(
      "ドリンク代: 400円\nVIP料金: 500円\n延長料金: 200円\n支払い済み合計: 1,100円");
    const text = (result.files[0]!.attachment as Buffer).toString("utf8");
    expect(text).toContain("注文ID: 1");
    expect(text).toContain("注文ID: 2");
    expect(text).toContain("buyer-2");
    expect(result.allowedMentions).toEqual({ parse: [] });
  });
  it("keeps a long statement within embed limits and includes every order in the text attachment", () => {
    const orders = Array.from({ length: 80 }, (_, index) => paid(String(index)));
    const result = kpTicketStatement(orders, "円");
    expect(result.embeds[0]!.toJSON().description!.length).toBeLessThan(4096);
    expect(result.embeds[0]!.toJSON().fields![0]!.value).toContain("16,000円");
    const text = (result.files[0]!.attachment as Buffer).toString("utf8");
    expect(text.match(/注文ID:/g)).toHaveLength(80);
    expect(text).toContain("注文ID: 79");
  });
  it("does not silently omit corrupt or unpaid orders", () => {
    const order = paid("1");
    order.selection.quote = undefined;
    expect(() => kpTicketStatement([order], "円")).toThrow("不完全");
    expect(() => kpTicketStatement([{ ...paid("2"), phase: "confirm" }], "円")).toThrow("不完全");
  });
});
