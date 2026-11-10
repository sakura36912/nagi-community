import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  saved: vi.fn(), current: vi.fn(), pending: vi.fn(), error: vi.fn(),
}));
vi.mock("../lib/vcReward", () => ({ getTotalChestVcSeconds: m.saved }));
vi.mock("../lib/chestTracker", () => ({
  getCurrentTavernSeconds: m.current, getPendingTavernSeconds: m.pending,
}));
vi.mock("../lib/logger", () => ({ logger: { error: m.error } }));
import { voyageJournalPurchaseError } from "../lib/voyageJournal";

beforeEach(() => {
  vi.clearAllMocks();
  m.saved.mockResolvedValue(0); m.current.mockReturnValue(0); m.pending.mockReturnValue(0);
});
describe("voyage journal tavern time requirement", () => {
  it.each([0, 359999])("rejects less than 100 hours (%s seconds)", async seconds => {
    m.saved.mockResolvedValue(seconds);
    expect(await voyageJournalPurchaseError("guild", "user", "航海日誌")).toContain("100時間以上");
    expect(m.saved).toHaveBeenCalledWith("guild", "user");
  });
  it.each([360000, 720000])("allows 100 hours or more (%s seconds)", async seconds => {
    m.saved.mockResolvedValue(seconds);
    expect(await voyageJournalPurchaseError("guild", "user", "航海日誌")).toBeNull();
  });
  it("includes the currently tracked session and pending writes without using session-log totals", async () => {
    m.saved.mockResolvedValue(359000);
    m.pending.mockReturnValue(400); m.current.mockReturnValue(600);
    expect(await voyageJournalPurchaseError("guild", "user", "航海日誌")).toBeNull();
    expect(m.pending).toHaveBeenCalledWith("guild", "user");
    expect(m.current).toHaveBeenCalledWith("guild", "user");
  });
  it("does not apply to other products or query their time", async () => {
    expect(await voyageJournalPurchaseError("guild", "user", "ドリンク")).toBeNull();
    expect(m.saved).not.toHaveBeenCalled();
  });
  it("fails closed when time cannot be fetched", async () => {
    m.saved.mockRejectedValueOnce(new Error("DB unavailable"));
    expect(await voyageJournalPurchaseError("guild", "user", "航海日誌")).toContain("確認できません");
  });
  it("rejects invalid time data", async () => {
    m.saved.mockResolvedValue(NaN);
    expect(await voyageJournalPurchaseError("guild", "user", "航海日誌")).toContain("購入は行っていません");
  });
});
