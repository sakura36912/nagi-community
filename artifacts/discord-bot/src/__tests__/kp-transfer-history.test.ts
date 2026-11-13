import { describe, expect, it } from "vitest";
import { kpTransferHistory } from "../lib/kpTransferHistory";

describe("KP ticket transfer history report", () => {
  it("lists sender, amount, time, and an all-history attachment", () => {
    const report = kpTransferHistory([{
      senderId: "sender-1",
      amount: -2500,
      createdAt: new Date("2026-11-15T03:00:00.000Z"),
    }], "円", "nagi");
    const embed = report.embeds[0]!.toJSON();
    expect(embed.title).toBe("凪への送金履歴");
    expect(embed.description).toContain("<@sender-1>");
    expect(embed.description).toContain("2,500円");
    expect(embed.footer?.text).toContain("チャンネルは保存されていない");
    expect(report.files[0]!.name).toBe("nagi-transfer-history.txt");
    expect((report.files[0]!.attachment as Buffer).toString("utf8")).toContain("送金者ID: sender-1");
  });

  it("states clearly when there are no transfers", () => {
    const report = kpTransferHistory([], "円", "nagi");
    const embed = report.embeds[0]!.toJSON();
    expect(embed.description).toContain("送金記録はありません");
    expect(embed.fields?.find(field => field.name === "送金合計")?.value).toBe("0円");
  });
});
