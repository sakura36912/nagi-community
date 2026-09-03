import { describe, expect, it, vi } from "vitest";
import { reconcileVcRewardPresenceRows } from "../lib/vcRewardPresenceReconciliation.js";

function handlers() {
  return {
    clear: vi.fn(async () => undefined),
    move: vi.fn(async () => undefined),
    seed: vi.fn(async () => undefined),
  };
}

describe("VC報酬の起動時状態同期", () => {
  it("再起動中も同じ報酬対象VCにいるユーザーの入室記録を維持する", async () => {
    const h = handlers();
    const result = await reconcileVcRewardPresenceRows(
      [{ guildId: "g", userId: "u", channelId: "beach" }],
      [{ guildId: "g", userId: "u", channelId: "beach" }],
      h,
    );

    expect(result.preserved).toBe(1);
    expect(h.clear).not.toHaveBeenCalled();
    expect(h.seed).not.toHaveBeenCalled();
  });

  it("退出済みの古い記録だけを削除する", async () => {
    const h = handlers();
    const result = await reconcileVcRewardPresenceRows(
      [{ guildId: "g", userId: "left", channelId: "beach" }],
      [],
      h,
    );

    expect(result.cleared).toBe(1);
    expect(h.clear).toHaveBeenCalledWith("g", "left");
  });

  it("記録なしで接続中のユーザーは再起動時点から計測を開始する", async () => {
    const h = handlers();
    const result = await reconcileVcRewardPresenceRows(
      [],
      [{ guildId: "g", userId: "u", channelId: "beach" }],
      h,
    );

    expect(result.seeded).toBe(1);
    expect(h.seed).toHaveBeenCalledWith("g", "u", "beach");
  });

  it("報酬対象VC間を移動済みなら開始時刻を維持してチャンネルだけ直す", async () => {
    const h = handlers();
    const result = await reconcileVcRewardPresenceRows(
      [{ guildId: "g", userId: "u", channelId: "old" }],
      [{ guildId: "g", userId: "u", channelId: "new" }],
      h,
    );

    expect(result.moved).toBe(1);
    expect(h.move).toHaveBeenCalledWith("g", "u", "new");
    expect(h.seed).not.toHaveBeenCalled();
  });
});
