import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  eligibility: vi.fn(), select: vi.fn(), insert: vi.fn(), transaction: vi.fn(),
}));
vi.mock("@workspace/db", async original => ({
  ...await original<typeof import("@workspace/db")>(),
  db: { select: m.select, insert: m.insert, transaction: m.transaction },
}));
vi.mock("../lib/voyageJournal", () => ({ voyageJournalPurchaseError: m.eligibility }));
import { buyItem, buyItemQuantity } from "../lib/economy";

beforeEach(() => {
  vi.clearAllMocks();
  m.select.mockReturnValue({ from: () => ({ where: async () => [
    { id: 98, guildId: "guild", name: "航海日誌", price: 100, category: "general" },
  ] }) });
  m.eligibility.mockResolvedValue("100時間以上必要です。引き落としは行っていません。");
});
describe("journal gating before any purchase mutation", () => {
  it.each([1, 25])("blocks quantity %s without wallet, inventory or transaction writes", async quantity => {
    expect(await buyItemQuantity("guild", "user", 98, "通貨", quantity)).toEqual({
      ok: false, reason: "100時間以上必要です。引き落としは行っていません。",
    });
    expect(m.eligibility).toHaveBeenCalledWith("guild", "user", "航海日誌");
    expect(m.insert).not.toHaveBeenCalled();
    expect(m.transaction).not.toHaveBeenCalled();
  });
  it("also protects single-item button and select purchases", async () => {
    expect((await buyItem("guild", "user", 98, "通貨")).ok).toBe(false);
    expect(m.eligibility).toHaveBeenCalledOnce();
    expect(m.insert).not.toHaveBeenCalled();
    expect(m.transaction).not.toHaveBeenCalled();
  });
  it("continues the normal purchase when the time condition passes", async () => {
    m.eligibility.mockResolvedValueOnce(null);
    m.transaction.mockResolvedValueOnce(false);
    const values = vi.fn().mockResolvedValue(undefined);
    m.insert.mockReturnValue({ values });
    expect(await buyItemQuantity("guild", "user", 98, "通貨", 2)).toMatchObject({
      ok: true, quantity: 2, totalPrice: 200,
    });
    expect(m.transaction).toHaveBeenCalledOnce();
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ guildId: "guild", userId: "user", amount: -200 }));
  });
});
