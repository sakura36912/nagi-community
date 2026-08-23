import { describe, expect, it } from "vitest";
import { buildHubVcPanelMessage } from "../commands/vc.js";

describe("Hub VCインチャットパネル", () => {
  it("通常のHubでは画面共有コントロールを表示する", () => {
    const message = buildHubVcPanelMessage("channel-1", "owner-1", true);
    const row = message.components[0]!;

    expect(row.components).toHaveLength(2);
    expect(message.embeds[0]!.toJSON().description).toContain("画面共有");
  });

  it("画面共有コントロールを無効にしたHubではVC名変更だけを表示する", () => {
    const message = buildHubVcPanelMessage("channel-1", "owner-1", true, false);
    const row = message.components[0]!;

    expect(row.components).toHaveLength(1);
    expect((row.components[0]!.toJSON() as { label?: string }).label).toBe("VC名変更");
    expect(message.embeds[0]!.toJSON().description).not.toContain("画面共有");
  });
});