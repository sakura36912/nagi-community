import { describe, expect, it } from "vitest";
import type { KpTicketSession } from "@workspace/db";
import { kpCastSales } from "../lib/kpCastSales";
import { kpBusinessDay } from "../lib/kpBusinessDay";

const period = kpBusinessDay("2026-11-02");
function paid(cast: string | undefined, total: number, channelId = "deleted-ticket"): KpTicketSession {
  return {
    id: "order", guildId: "guild", channelId, userId: "private-buyer",
    phase: "paid", version: 1, createdAt: new Date(0), paidAt: new Date(1),
    expiresAt: new Date(0), logMessageId: null,
    selection: { castId: cast, quote: { itemId: 1, itemName: "private-product",
      unitPrice: total, quantity: 1, vipPrice: 0, extensionPrice: 0, total } },
  };
}
const report = (orders: KpTicketSession[]) => kpCastSales(orders, "通貨", period);
const text = (result: ReturnType<typeof report>) => (result.files[0]!.attachment as Buffer).toString("utf8");

describe("KP cast-only sales", () => {
  it("combines additional orders across deleted and current tickets by cast ID", () => {
    const result = report([paid("111", 300), paid("222", 900), paid("111", 400, "current-ticket")]);
    const description = result.embeds[0]!.toJSON().description!;
    expect(description).toBe("<@222>：900通貨\n<@111>：700通貨");
    expect(text(result)).toContain("キャストID: 111：700通貨");
    expect(result.embeds[0]!.toJSON().fields![1]!.value).toContain("2026-11-02 18:00");
    expect(result.allowedMentions).toEqual({ parse: [] });
    expect(text(result)).not.toMatch(/private-buyer|private-product|注文件数|注文ID|チケットID|ドリンク代/);
  });
  it("uses full historical paid totals including old extras without repricing", () => {
    const order = paid("111", 900);
    Object.assign(order.selection.quote!, { unitPrice: 200, vipPrice: 500, extensionPrice: 200 });
    expect(text(report([order]))).toContain("111：900通貨");
  });
  it("preserves missing cast records in a separate bucket and zero-price sales", () => {
    const result = report([paid(undefined, 50), paid(undefined, 60), paid("111", 0)]);
    expect(text(result)).toContain("キャスト未記録：110通貨");
    expect(text(result)).toContain("111：0通貨");
  });
  it("adds totals beyond the safe Number integer limit exactly", () => {
    const orders = Array.from({ length: 6 }, () => paid("111", Number.MAX_SAFE_INTEGER));
    expect(text(report(orders))).toContain((BigInt(Number.MAX_SAFE_INTEGER) * 6n).toLocaleString());
  });
  it("limits the Discord preview but exports all cast totals", () => {
    const result = report(Array.from({ length: 100 }, (_, i) => paid(String(1000 + i), i)));
    const embed = result.embeds[0]!.toJSON();
    expect(embed.description!.length).toBeLessThan(4096);
    expect(embed.description).toContain("添付ファイル");
    expect(text(result).match(/キャストID:/g)).toHaveLength(100);
    expect(text(result)).toContain("1000：0通貨");
    expect(result.files[0]!.name).toBe("kp-cast-sales.txt");
  });
  it("clearly reports an empty day", () => {
    expect(report([]).embeds[0]!.toJSON().description).toContain("支払い済みの注文がありません");
  });
  it("rejects unpaid or incomplete records rather than silently omitting them", () => {
    expect(() => report([{ ...paid("111", 1), phase: "confirm" }])).toThrow("不完全");
    const order = paid("111", 1); order.selection.quote = undefined;
    expect(() => report([order])).toThrow("不完全");
  });
});
