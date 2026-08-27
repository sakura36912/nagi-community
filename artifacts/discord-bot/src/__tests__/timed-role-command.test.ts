import { describe, expect, it } from "vitest";
import { commands } from "../commands/index.js";

describe("/期間限定ロール", () => {
  it("ユーザーではなくロールだけを対象にする", () => {
    const command = commands.find((entry) => entry.data.name === "期間限定ロール");
    const definition = command?.data.toJSON() as {
      options?: Array<{ name: string; options?: Array<{ name: string; type: number }> }>;
    };
    const grant = definition.options?.find((option) => option.name === "付与");

    expect(grant?.options?.some((option) => option.type === 6)).toBe(false);
    expect(grant?.options?.find((option) => option.name === "ロール")?.type).toBe(8);
    expect(grant?.options?.find((option) => option.name === "期間")?.type).toBe(4);
    expect(grant?.options?.find((option) => option.name === "単位")?.type).toBe(3);
  });
});