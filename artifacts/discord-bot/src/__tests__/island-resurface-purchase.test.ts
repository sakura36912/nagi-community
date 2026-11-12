import { beforeEach, describe, expect, it, vi } from "vitest";
import { Collection, type Guild } from "discord.js";
import { islandResurfacePurchaseError } from "../lib/islandResurfacePurchase";

vi.mock("../lib/logger", () => ({ logger: { error: vi.fn() } }));
const fetch = vi.fn();
const guild = { members: { fetch } } as unknown as Guild;
const ticket = { name: "オチテモータ島浮上券", effectType: "eval_resurface" };

beforeEach(() => vi.resetAllMocks());

describe("island resurface purchase eligibility", () => {
  it.each(["本船員", "本船員,新入り"])("allows holders: %s", async names => {
    fetch.mockResolvedValue({ roles: { cache: new Collection(names.split(",").map(name => [name, { name }])) } });
    expect(await islandResurfacePurchaseError(guild, "buyer", ticket)).toBeNull();
    expect(fetch).toHaveBeenCalledWith({ user: "buyer", force: true });
  });
  it.each(["", "新入り", "漂流者", "管理者", "提督", "元本船員"])("rejects nonholders: %s", async name => {
    fetch.mockResolvedValue({ roles: { cache: new Collection(name ? [[name, { name }]] : []) } });
    expect(await islandResurfacePurchaseError(guild, "buyer", ticket)).toContain("本船員ロール");
  });
  it("protects legacy name-only tickets and renamed effect-based tickets", async () => {
    fetch.mockResolvedValue({ roles: { cache: new Collection() } });
    for (const item of [{ name: ticket.name }, { name: "浮上券", effectType: "eval_resurface" }]) {
      expect(await islandResurfacePurchaseError(guild, "buyer", item)).toContain("引き落としは行っていません");
    }
  });
  it("does not restrict other island-shop products", async () => {
    expect(await islandResurfacePurchaseError(guild, "buyer", { name: "島の商品" })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("fails closed if the member cannot be fetched", async () => {
    fetch.mockRejectedValue(new Error("Discord unavailable"));
    expect(await islandResurfacePurchaseError(guild, "buyer", ticket)).toContain("確認できません");
    expect(await islandResurfacePurchaseError(null, "buyer", ticket)).toContain("引き落としは行っていません");
  });
});
