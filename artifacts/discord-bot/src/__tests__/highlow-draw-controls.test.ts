import { describe, expect, it } from "vitest";
import { buildDrawReplayButton } from "../commands/highlow.js";

describe("ハイアンドローの引き分け後の操作", () => {
  it("同じゲームを続けるための『もう一度プレイ』だけを表示する", () => {
    const row = buildDrawReplayButton().toJSON();

    expect(row.components).toHaveLength(1);
    expect(row.components?.[0]).toMatchObject({
      custom_id: "hl:continue",
      label: "もう一度プレイ",
    });
  });
});