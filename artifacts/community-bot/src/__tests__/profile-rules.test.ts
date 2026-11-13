import { describe, expect, it } from "vitest";
import {
  configuredProfileRank, getProfileCasinoStats, PROFILE_RANK_TIERS,
  type ProfileSettings,
} from "@workspace/db";

describe("profile card data rules", () => {
  it("uses the highest matching configured KP rank role", () => {
    const settings: ProfileSettings = {
      displayRoleIds: [], visibleFields: {}, color: null, backgroundUrl: null, frameStyle: "wanted",
      rankRoles: [
        { roleId: "crew", tier: "regular" },
        { roleId: "vip", tier: "vip" },
        { roleId: "legend", tier: "special" },
      ],
    };
    expect(configuredProfileRank(["crew", "vip"], settings.rankRoles)).toBe("vip");
    expect(configuredProfileRank(["vip", "legend"], settings.rankRoles)).toBe("special");
    expect(configuredProfileRank(["other"], settings.rankRoles)).toBeNull();
    expect(PROFILE_RANK_TIERS).toEqual(["regular", "vip", "vip_plus", "special"]);
  });

  it("aggregates saved casino ledgers and dealer settlements without session memory", () => {
    const stats = getProfileCasinoStats([
      { amount: 75, reason: "ハイアンドロー勝利（賭け: 50）" },
      { amount: -25, reason: "ルーレット敗北（賭け: 25）" },
      { amount: 100, reason: "スロット旧記録（賭け: 50）" },
      { amount: 20, reason: "スロット当選（賭け: 80）[net-v2]" },
      { amount: 5000, reason: "管理者付与" },
    ], [{ bet: 200, payout: 500, result: "WON" }]);
    expect(stats).toEqual({ totalBet: 405, net: 420, wins: 4, maxPayout: 500, games: 5 });
  });
});
