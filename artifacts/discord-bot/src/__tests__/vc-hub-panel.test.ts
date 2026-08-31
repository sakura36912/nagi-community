import { describe, expect, it } from "vitest";
import { buildHubVcPanelMessage, vcCommand } from "../commands/vc.js";
import { shiftCommand } from "../commands/shift.js";

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
    expect(message.embeds[0]!.toJSON().title).toBe("🏖️ 砂浜コントロールパネル");
    expect(message.embeds[0]!.toJSON().description).not.toContain("画面共有");
  });

  it("ネスト形式の /vc hub add と従来の /vc hub-add を登録する", () => {
    const definition = vcCommand.data.toJSON() as {
      options?: Array<{ name: string; options?: Array<{ name: string }> }>;
    };
    const hubGroup = definition.options?.find((option) => option.name === "hub");

    expect(hubGroup?.options?.map((option) => option.name)).toEqual(
      expect.arrayContaining(["add", "remove", "list"]),
    );
    expect(definition.options?.some((option) => option.name === "hub-add")).toBe(true);
  });

  it("shiftコマンドをDiscordの候補に表示する", () => {
    const definition = shiftCommand.data.toJSON() as {
      default_member_permissions?: string | null;
    };
    expect(definition.default_member_permissions).toBe("0");
  });
});