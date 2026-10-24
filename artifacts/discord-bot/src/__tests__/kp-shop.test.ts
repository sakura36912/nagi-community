import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StringSelectMenuInteraction } from "discord.js";
import type { ShopItem } from "@workspace/db";

const mocks = vi.hoisted(() => ({
  buy: vi.fn(), refund: vi.fn(), settings: vi.fn(), warn: vi.fn(),
}));
vi.mock("../lib/economy", () => ({
  buyItem: mocks.buy, refundPurchase: mocks.refund,
  getGuildSettings: mocks.settings, PERM_ROLE_EFFECT: "perm_role",
}));
vi.mock("../lib/logger", () => ({ logger: { warn: mocks.warn } }));
import { KP_SHOP_NAME, purchaseKpItem, supportsKpEffect } from "../lib/kpShop";

const item = { id: 3, name: "KP商品", price: 100, category: "kp", effectType: null, targetRoleId: null } as ShopItem;
function fixture() {
  const add = vi.fn().mockResolvedValue(undefined);
  const send = vi.fn().mockResolvedValue(undefined);
  const permissions = vi.fn().mockReturnValue(true);
  return {
    guildId: "guild", id: "interaction", user: { id: "buyer" },
    guild: { members: { me: { id: "bot" }, fetch: vi.fn().mockResolvedValue({ roles: { add } }) } },
    channel: { isTextBased: () => true, isThread: () => false, permissionsFor: () => ({ has: permissions }), send },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    add, send, permissions,
  };
}
const run = (i: ReturnType<typeof fixture>, product = item) =>
  purchaseKpItem(i as unknown as StringSelectMenuInteraction, product);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.buy.mockResolvedValue({ ok: true, item });
  mocks.refund.mockResolvedValue(undefined);
  mocks.settings.mockResolvedValue({ currencyName: "円" });
});
describe("KP shop purchases", () => {
  it("posts the successful purchase to the panel channel without pinging", async () => {
    const i = fixture();
    await run(i);
    expect(mocks.buy).toHaveBeenCalledWith("guild", "buyer", 3, "円");
    expect(i.send).toHaveBeenCalledOnce();
    const payload = i.send.mock.calls[0][0];
    expect(payload.embeds[0].toJSON().title).toBe(`${KP_SHOP_NAME} 購入ログ`);
    expect(payload.embeds[0].toJSON().fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "購入者", value: "<@buyer>" }),
      expect.objectContaining({ name: "購入金額", value: "100円" }),
    ]));
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });
  it("does not log rejected purchases", async () => {
    mocks.buy.mockResolvedValue({ ok: false, reason: "残高不足" });
    const i = fixture(); await run(i);
    expect(i.send).not.toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalledWith("残高不足");
  });
  it("checks log permissions before taking money", async () => {
    const i = fixture(); i.permissions.mockReturnValue(false);
    await run(i);
    expect(mocks.buy).not.toHaveBeenCalled();
  });
  it("refunds a failed role grant and does not log a purchase", async () => {
    const product = { ...item, targetRoleId: "role", effectType: "perm_role" };
    mocks.buy.mockResolvedValue({ ok: true, item: product });
    const i = fixture(); i.add.mockRejectedValue(new Error("Forbidden"));
    await run(i, product);
    expect(mocks.refund).toHaveBeenCalledWith("guild", "buyer", product);
    expect(i.send).not.toHaveBeenCalled();
  });
  it("does not refund a completed purchase when log sending fails", async () => {
    const i = fixture(); i.send.mockRejectedValue(new Error("Forbidden"));
    await run(i);
    expect(mocks.refund).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledOnce();
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining("購入は完了"));
  });
  it("grants a configured role before logging", async () => {
    const product = { ...item, targetRoleId: "role", effectType: "perm_role" };
    mocks.buy.mockResolvedValue({ ok: true, item: product });
    const i = fixture(); await run(i, product);
    expect(i.add).toHaveBeenCalledWith("role");
    expect(i.send).toHaveBeenCalledOnce();
  });
  it("rejects unsupported effects and products from another category", async () => {
    const i = fixture();
    await run(i, { ...item, category: "general" });
    await run(i, { ...item, effectType: "nickname" });
    expect(mocks.buy).not.toHaveBeenCalled();
    expect(supportsKpEffect(null)).toBe(true);
    expect(supportsKpEffect("perm_role")).toBe(true);
  });
  it("does not charge for a permanent-role item without a configured role", async () => {
    const i = fixture(); await run(i, { ...item, effectType: "perm_role" });
    expect(mocks.buy).not.toHaveBeenCalled();
  });
});
