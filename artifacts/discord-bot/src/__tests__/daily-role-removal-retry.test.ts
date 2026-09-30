import { describe, expect, it, vi } from "vitest";
import type { Guild } from "discord.js";

const economy = vi.hoisted(() => ({
  listPendingDailyRoleRemovals: vi.fn(),
  clearPendingDailyRoleRemoval: vi.fn(),
  processDailyRoleDebit: vi.fn(),
}));
vi.mock("../lib/economy", () => economy);
import { retryPendingDailyRoleRemovals } from "../lib/dailyRoleDebit.js";

describe("日額引き落としのロール解除", () => {
  it("Discordが一時的に失敗しても未処理を残し、次回成功後に消す", async () => {
    economy.listPendingDailyRoleRemovals.mockResolvedValue([
      { guildId: "guild", userId: "user", roleId: "role" },
    ]);
    economy.clearPendingDailyRoleRemoval.mockResolvedValue(undefined);
    const remove = vi.fn().mockRejectedValueOnce(new Error("temporary error")).mockResolvedValueOnce(undefined);
    const member = { roles: { cache: new Map([["role", {}]]), remove } };
    const guild = {
      id: "guild",
      members: { cache: new Map([["user", member]]), fetch: vi.fn() },
    } as unknown as Guild;

    expect(await retryPendingDailyRoleRemovals(guild)).toEqual(["user"]);
    expect(economy.clearPendingDailyRoleRemoval).not.toHaveBeenCalled();
    expect(await retryPendingDailyRoleRemovals(guild)).toEqual([]);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(economy.clearPendingDailyRoleRemoval).toHaveBeenCalledWith("guild", "user", "role");
  });
});