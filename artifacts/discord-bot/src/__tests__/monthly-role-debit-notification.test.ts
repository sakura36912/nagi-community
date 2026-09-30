import { describe, expect, it, vi } from "vitest";
import type { Guild } from "discord.js";
import type { GuildSettings } from "@workspace/db";

const economy = vi.hoisted(() => ({
  distributeMonthlyRoleDebit: vi.fn(),
  markMonthlyRoleDebitProcessed: vi.fn(),
}));
vi.mock("../lib/economy", () => economy);
import { runMonthlyRoleDebitForGuild } from "../lib/monthlyRoleDebit.js";

describe("複数ロールの月額不足通知", () => {
  it("両方のロールを解除し、各ログ先にはそのロールの額と合計額を区別して送る", async () => {
    const rules = [
      { roleId: "role-a", amount: 300, logChannelId: "log-a" },
      { roleId: "role-b", amount: 500, logChannelId: "log-b" },
    ];
    economy.distributeMonthlyRoleDebit.mockResolvedValue({
      chargedCount: 0, totalCharged: 0, insufficientCount: 1,
      insufficient: [{ userId: "member", amount: 800, rules }],
    });
    economy.markMonthlyRoleDebitProcessed.mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);
    const member = {
      id: "member", user: { bot: false },
      roles: { cache: new Map([["role-a", {}], ["role-b", {}]]), remove },
    };
    const logA = { isTextBased: () => true, send: vi.fn().mockResolvedValue(undefined) };
    const logB = { isTextBased: () => true, send: vi.fn().mockResolvedValue(undefined) };
    const guild = {
      id: "guild", name: "テスト",
      members: { cache: new Map([["member", member]]), fetch: vi.fn().mockResolvedValue(undefined) },
      channels: { cache: new Map([["log-a", logA], ["log-b", logB]]) },
    } as unknown as Guild;
    await runMonthlyRoleDebitForGuild(guild, { currencyName: "円" } as GuildSettings, rules, new Date());

    expect(remove).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledWith("role-a", expect.any(String));
    expect(remove).toHaveBeenCalledWith("role-b", expect.any(String));
    for (const [send, localAmount, roleId] of [[logA.send, "300", "role-a"], [logB.send, "500", "role-b"]] as const) {
      expect(send).toHaveBeenCalledOnce();
      const payload = send.mock.calls[0]![0];
      const description = payload.embeds[0].toJSON().fields[0].value;
      expect(description).toContain(`対象額 ${localAmount}円`);
      expect(description).toContain("合計請求額 800円");
      expect(description).toContain(roleId);
      expect(payload.allowedMentions).toEqual({ parse: [] });
    }
    expect(economy.markMonthlyRoleDebitProcessed).toHaveBeenCalledOnce();
  });
});