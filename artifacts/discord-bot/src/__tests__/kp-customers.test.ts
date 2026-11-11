import { describe, expect, it } from "vitest";
import type { KpTicketSession } from "@workspace/db";
import { kpCustomers } from "../lib/kpCustomers";

function order(id: string, userId = "buyer", channelId = "ticket"): KpTicketSession {
  return { id, guildId: "guild", channelId, userId, phase: "paid", version: 1,
    selection: { castId: "cast", quote: { itemId: 1, itemName: "ドリンク", unitPrice: 100,
      quantity: 2, total: 200, vipPrice: 0, extensionPrice: 0 } },
    paidAt: new Date("2026-11-12T09:00:00Z"), createdAt: new Date(),
    expiresAt: new Date(0), logMessageId: null };
}
const text = (result: ReturnType<typeof kpCustomers>) => (result.files[0]!.attachment as Buffer).toString("utf8");

describe("KP customers from settled order snapshots", () => {
  it("counts additional orders but counts each ticket only once, including deleted tickets", () => {
    const result = kpCustomers([order("1"), order("2"), order("3", "buyer", "deleted-ticket")], "円");
    expect(text(result)).toContain("利用チケット: 2件 / 注文: 3件 / 累計: 600円");
    expect(text(result)).toContain("担当キャストID: cast");
    expect(text(result)).toContain("JST");
    expect(result.allowedMentions.parse).toEqual([]);
  });
  it("keeps pending/cancelled orders out, isolates the selected customer and includes complete paid history", () => {
    const result = kpCustomers([order("1"), order("2", "other"),
      { ...order("pending"), phase: "confirm" }, { ...order("cancelled"), phase: "cancelled" }], "$", "buyer");
    expect(text(result)).toContain("注文ID: 1");
    expect(text(result)).not.toMatch(/注文ID: (2|pending|cancelled)/);
    expect(text(result)).not.toContain("顧客ID: other");
    expect(text(result)).toContain("2026/11/12 18:00:00 JST");
    expect(result.embeds[0]!.toJSON().fields![1]!.value).toContain("1チケット / 1注文 / 200$");
  });
  it("paginates long histories while exporting all matching orders", () => {
    const orders = Array.from({ length: 25 }, (_, n) => order(String(n).padStart(2, "0")));
    const result = kpCustomers(orders, "円", "buyer", 2);
    expect(result.embeds[0]!.toJSON().footer!.text).toContain("2/4ページ");
    expect(text(result).match(/注文ID:/g)).toHaveLength(25);
    expect(result.embeds[0]!.toJSON().description!.length).toBeLessThan(4096);
  });
  it("handles absent customers and validates pages and missing payment snapshots", () => {
    expect(text(kpCustomers([], "円", "unknown"))).not.toContain("注文ID:");
    expect(() => kpCustomers([], "円", undefined, 2)).toThrow("ページ");
    expect(() => kpCustomers([], "円", undefined, 0)).toThrow("ページ");
    expect(() => kpCustomers([{ ...order("1"), selection: {} }], "円")).toThrow("不完全");
  });
  it("sorts customers by latest payment and preserves precise totals above the database integer range", () => {
    const orders = [order("1", "earlier"), { ...order("2", "latest"), paidAt: new Date("2026-11-13T09:00:00Z") },
      ...Array.from({ length: 3 }, (_, n) => {
        const row = order(`big-${n}`);
        row.selection.quote!.total = 2147483647;
        return row;
      })];
    const result = kpCustomers(orders, "円");
    expect(result.embeds[0]!.toJSON().description!.startsWith("<@latest>")).toBe(true);
    expect(text(result)).toContain("6,442,450,941円");
  });
});
