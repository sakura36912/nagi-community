import { describe, expect, it } from "vitest";
import type { GuildSettings } from "@workspace/db";
import { commands } from "../commands/index.js";
import {
  collectMonthlyDebitCharges,
  isDueMonthlyRoleDebit,
  type MonthlyRoleDebitRule,
} from "../lib/economy.js";

const rules: MonthlyRoleDebitRule[] = [
  { roleId: "role-a", amount: 300, logChannelId: "log-a" },
  { roleId: "role-b", amount: 500, logChannelId: "log-b" },
];

describe("複数ロールの月額引き落とし", () => {
  it("複数保有者は合計して1回、単一保有者はそのロールの金額だけ請求する", () => {
    const members = new Map([
      ["both", ["role-a", "role-b"]],
      ["only-a", ["role-a"]],
      ["unrelated", ["role-c"]],
    ]);
    expect(collectMonthlyDebitCharges(members, rules)).toEqual([
      { userId: "both", amount: 800, rules },
      { userId: "only-a", amount: 300, rules: [rules[0]] },
    ]);
  });

  it("合計がウォレットの整数上限を超えても対象者ごとに判定できる", () => {
    expect(collectMonthlyDebitCharges(
      new Map([["both", ["role-a", "role-b"]]]),
      [{ roleId: "role-a", amount: 2_147_483_647, logChannelId: "log" }, rules[1]!],
    )).toEqual([{
      userId: "both",
      amount: 2_147_484_147,
      rules: [{ roleId: "role-a", amount: 2_147_483_647, logChannelId: "log" }, rules[1]!],
    }]);
  });

  it("JSTの25日から処理し、ロール設定がない日は実行しない", () => {
    const settings = { lastMonthlyDebitAt: null } as GuildSettings;
    expect(isDueMonthlyRoleDebit(settings, new Date("2026-10-24T14:59:00Z"), rules)).toBe(false);
    expect(isDueMonthlyRoleDebit(settings, new Date("2026-10-24T15:00:00Z"), rules)).toBe(true);
    expect(isDueMonthlyRoleDebit(settings, new Date("2026-10-24T15:00:00Z"), [])).toBe(false);
    expect(isDueMonthlyRoleDebit(
      { lastMonthlyDebitAt: new Date("2026-10-24T15:01:00Z") } as GuildSettings,
      new Date("2026-10-25T00:00:00Z"),
      rules,
    )).toBe(false);
  });

  it("setはロールごとの金額、removeは個別解除を受け付ける", () => {
    const command = commands.find((item) => item.data.name === "月額引き落とし");
    expect(command).toBeDefined();
    const definition = command!.data.toJSON() as {
      default_member_permissions?: string | null;
      options?: Array<{ name: string; options?: Array<{ name: string; required?: boolean }> }>;
    };
    expect(definition.default_member_permissions).toBe("8");
    expect(definition.options?.map((option) => option.name)).toEqual(["set", "remove", "list"]);
    expect(definition.options?.[1]?.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "role", required: false }),
    ]));
  });
});