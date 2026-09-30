import { describe, expect, it } from "vitest";
import type { GuildSettings } from "@workspace/db";
import { commands } from "../commands/index.js";
import { isDueDailyRoleDebit } from "../lib/economy.js";

const settings = (lastDailyDebitAt: Date | null, enabled = true) => ({
  dailyDebitRoleId: enabled ? "role-1" : null,
  dailyDebitAmount: enabled ? 250 : null,
  lastDailyDebitAt,
}) as GuildSettings;

describe("日額引き落とし", () => {
  it("日付の切り替わりは日本時間で判定し、同じ日は二重請求しない", () => {
    const previous = settings(new Date("2026-09-30T14:59:00Z")); // 23:59 JST
    expect(isDueDailyRoleDebit(previous, new Date("2026-09-30T14:59:30Z"))).toBe(false);
    expect(isDueDailyRoleDebit(previous, new Date("2026-09-30T15:00:00Z"))).toBe(true);
    expect(isDueDailyRoleDebit(settings(new Date("2026-09-30T15:00:00Z")), new Date("2026-09-30T14:59:00Z"))).toBe(false);
    expect(isDueDailyRoleDebit(settings(new Date("2026-09-30T15:00:01Z")), new Date("2026-10-01T14:59:00Z"))).toBe(false);
    expect(isDueDailyRoleDebit(settings(new Date("2026-12-31T14:59:00Z")), new Date("2026-12-31T15:00:00Z"))).toBe(true);
    expect(isDueDailyRoleDebit(settings(null, false), new Date("2026-09-30T15:00:00Z"))).toBe(false);
  });

  it("管理者向けの設定・表示・解除コマンドを登録する", () => {
    const command = commands.find((item) => item.data.name === "日額引き落とし");
    expect(command).toBeDefined();
    const definition = command!.data.toJSON() as {
      default_member_permissions?: string | null;
      options?: Array<{ name: string; options?: Array<{ name: string }> }>;
    };
    expect(definition.default_member_permissions).toBe("8");
    expect(definition.options?.map((option) => option.name)).toEqual(["set", "remove", "list"]);
    const set = definition.options?.[0];
    expect(set?.options?.map((option) => option.name)).toEqual(["role", "amount", "log_channel"]);
  });
});