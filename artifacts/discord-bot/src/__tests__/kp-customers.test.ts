import { describe, expect, it } from "vitest";
import type { KpTicketSession } from "@workspace/db";
import { kpCustomers } from "../lib/kpCustomers";
import { kpBusinessDay, latestKpBusinessDate } from "../lib/kpBusinessDay";

function order(id: string, userId = "buyer", channelId = "ticket"): KpTicketSession {
  return { id, guildId: "guild", channelId, userId, phase: "paid", version: 1,
    selection: { castId: "cast", quote: { itemId: 1, itemName: "ドリンク", unitPrice: 100,
      quantity: 2, total: 200, vipPrice: 0, extensionPrice: 0 } },
    paidAt: new Date("2026-11-12T09:00:00Z"), createdAt: new Date(),
    expiresAt: new Date(0), logMessageId: null };
}
const text = (result: ReturnType<typeof kpCustomers>) => (result.files[0]!.attachment as Buffer).toString("utf8");

describe("KP customers from settled order snapshots", () => {
  it("uses the current 18:00–10:00 Japan-time business period", () => {
    const now = new Date("2026-11-15T11:00:00Z"); // 2026-11-15 20:00 JST.
    const period = kpBusinessDay(latestKpBusinessDate(now));
    expect(period.start.toISOString()).toBe("2026-11-15T09:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-11-16T01:00:00.000Z");
    const result = kpCustomers([
      { ...order("before"), paidAt: new Date("2026-11-15T08:59:59Z") },
      { ...order("start"), paidAt: period.start },
      { ...order("end"), paidAt: period.end },
      { ...order("no-time"), paidAt: null },
    ], "円", undefined, 1, period);
    expect(text(result)).toContain("注文: 1件 / 累計: 200円");
    expect(text(result)).not.toContain("注文ID: before");
    expect(text(result)).not.toContain("注文ID: end");
    expect(text(result)).not.toContain("注文ID: no-time");
    expect(text(result)).toContain("2026-11-15 18:00 ～ 2026-11-16 10:00");
  });
  it("counts additional orders but counts each ticket only once, including deleted tickets", () => {
    const result = kpCustomers([order("1"), order("2"), order("3", "buyer", "deleted-ticket")], "円",
      undefined, 1, kpBusinessDay("2026-11-12"));
    expect(text(result)).toContain("利用チケット: 2件 / 注文: 3件 / 累計: 600円");
    expect(text(result)).toContain("担当キャストID: cast");
    expect(text(result)).toContain("JST");
    expect(result.allowedMentions.parse).toEqual([]);
  });
  it("lists both selected casts and each cast's first drink in customer history", () => {
    const row = order("two-cast");
    row.selection.castIds = ["cast", "cast2"];
    row.selection.quote!.items = [
      { castId: "cast", itemId: 1, itemName: "ドリンク", unitPrice: 100, quantity: 1 },
      { castId: "cast2", itemId: 2, itemName: "お茶", unitPrice: 250, quantity: 1 },
    ];
    const result = kpCustomers([row], "円", "buyer", 1, kpBusinessDay("2026-11-12"));
    expect(text(result)).toContain("キャストID: cast, cast2");
    expect(text(result)).toContain("ドリンク × 1（キャストID: cast） / お茶 × 1（キャストID: cast2）");
  });
  it("keeps pending/cancelled orders out, isolates the selected customer and includes complete paid history", () => {
    const result = kpCustomers([order("1"), order("2", "other"),
      { ...order("pending"), phase: "confirm" }, { ...order("cancelled"), phase: "cancelled" }], "$", "buyer", 1,
    kpBusinessDay("2026-11-12"));
    expect(text(result)).toContain("注文ID: 1");
    expect(text(result)).not.toMatch(/注文ID: (2|pending|cancelled)/);
    expect(text(result)).not.toContain("顧客ID: other");
    expect(text(result)).toContain("2026/11/12 18:00:00 JST");
    expect(result.embeds[0]!.toJSON().fields![1]!.value).toContain("1チケット / 1注文 / 200$");
  });
  it("paginates long histories while exporting all matching orders", () => {
    const orders = Array.from({ length: 25 }, (_, n) => order(String(n).padStart(2, "0")));
    const result = kpCustomers(orders, "円", "buyer", 2, kpBusinessDay("2026-11-12"));
    expect(result.embeds[0]!.toJSON().footer!.text).toContain("2/4ページ");
    expect(text(result).match(/注文ID:/g)).toHaveLength(25);
    expect(result.embeds[0]!.toJSON().description!.length).toBeLessThan(4096);
  });
  it("handles absent customers and validates pages and missing payment snapshots", () => {
    const period = kpBusinessDay("2026-11-12");
    expect(text(kpCustomers([], "円", "unknown", 1, period))).not.toContain("注文ID:");
    expect(() => kpCustomers([], "円", undefined, 2, period)).toThrow("ページ");
    expect(() => kpCustomers([], "円", undefined, 0, period)).toThrow("ページ");
    expect(() => kpCustomers([{ ...order("1"), selection: {} }], "円", undefined, 1, period)).toThrow("不完全");
  });
  it("sorts customers by latest payment and preserves precise totals above the database integer range", () => {
    const orders = [order("1", "earlier"), { ...order("2", "latest"), paidAt: new Date("2026-11-12T10:00:00Z") },
      ...Array.from({ length: 3 }, (_, n) => {
        const row = order(`big-${n}`);
        row.selection.quote!.total = 2147483647;
        return row;
      })];
    const result = kpCustomers(orders, "円", undefined, 1, kpBusinessDay("2026-11-12"));
    expect(result.embeds[0]!.toJSON().description!.startsWith("<@latest>")).toBe(true);
    expect(text(result)).toContain("6,442,450,941円");
  });
});
