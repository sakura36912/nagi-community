import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  settings: vi.fn(), account: vi.fn(), configure: vi.fn(), buy: vi.fn(), cancel: vi.fn(),
  hatch: vi.fn(), care: vi.fn(), remove: vi.fn(), grant: vi.fn(),
}));
vi.mock("@workspace/db", async importOriginal => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  return { ...actual, getPetSettings: mocks.settings, getPetAccount: mocks.account, configurePet: mocks.configure,
    buyPetItem: mocks.buy, cancelPetPurchase: mocks.cancel, hatchPet: mocks.hatch, carePet: mocks.care,
    removePet: mocks.remove, grantPetReward: mocks.grant };
});
import { executePet, handlePetButton, petCommand } from "../commands/pet";

const owner = "12345678901234567890";
function command(sub: string, options: Record<string, unknown> = {}, admin = false) {
  const fetch = vi.fn(async () => ({ permissions: { has: () => admin } }));
  return {
    id: "22345678901234567890", user: { id: owner }, guild: { id: "guild", members: { fetch } },
    options: { getSubcommand: () => sub, getString: (key: string) => options[key] ?? null,
      getInteger: (key: string) => options[key] ?? null, getNumber: (key: string) => options[key] ?? null,
      getUser: (key: string) => options[key] ?? null },
    deferReply: vi.fn(), editReply: vi.fn(),
  };
}
function button(customId: string, admin = false) {
  return { ...command("", {}, admin), customId, deferUpdate: vi.fn(), message: { edit: vi.fn() } };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.mockResolvedValue({ rare_price: 123, toy_price: 50, food_price: 20 });
  mocks.account.mockResolvedValue({ pet: { id: "12345678-1234-1234-1234-123456789012", name: "キツネ" } });
  for (const fn of [mocks.buy, mocks.cancel, mocks.hatch, mocks.care, mocks.remove, mocks.grant, mocks.configure]) fn.mockResolvedValue("成功");
});
describe("pet slash and button integration", () => {
  it("serializes the full Discord command definition with all required paths", () => {
    const definition = petCommand.data.toJSON();
    expect(definition.name).toBe("pet");
    expect(definition.options?.map(s => s.name)).toEqual(expect.arrayContaining([
      "hatch", "feed", "pet", "play", "inventory", "info", "buy", "release", "grant", "egg", "food", "delete", "config", "price", "reward",
    ]));
    expect(definition.options!.length).toBeLessThanOrEqual(25);
  });
  it.each(["grant", "egg", "food", "delete", "price", "config", "species", "reward"])("freshly rejects non-admin %s", async sub => {
    const i = command(sub);
    await executePet(i as never);
    expect(i.guild.members.fetch).toHaveBeenCalledWith({ user: owner, force: true });
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("管理者のみ") }));
    expect(mocks.configure).not.toHaveBeenCalled();
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("shows a payment confirmation and never charges when buy is first opened", async () => {
    const i = command("buy", { item: "rare", quantity: 2 });
    await executePet(i as never);
    expect(mocks.buy).not.toHaveBeenCalled();
    const reply = i.editReply.mock.calls[0]![0];
    expect(reply.content).toContain("$246");
    for (const component of reply.components[0].components) expect(component.data.custom_id.length).toBeLessThanOrEqual(100);
  });
  it("stops a non-owner from pressing another buyer's confirmation", async () => {
    const i = button(`pet:buy:other:rare:1:123:9999999999:request`);
    await handlePetButton(i as never);
    expect(mocks.buy).not.toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("本人のみ") }));
  });
  it("rejects expired payment confirmations", async () => {
    const i = button(`pet:buy:${owner}:rare:1:123:1:request`);
    await handlePetButton(i as never);
    expect(mocks.buy).not.toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("期限切れ") }));
  });
  it("routes a valid payment with the stable request ID, amount and quantity", async () => {
    const i = button(`pet:buy:${owner}:rare:2:123:9999999999:request`);
    i.message.edit.mockRejectedValueOnce(new Error("ephemeral message cannot be edited as a channel message"));
    await handlePetButton(i as never);
    expect(mocks.buy).toHaveBeenCalledWith("pet-buy:request", "guild", owner, "rare", 2, 123);
    expect(i.deferUpdate).toHaveBeenCalledOnce();
    expect(i.message.edit).not.toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: "成功", components: [] }));
  });
  it("cancels a purchase through the durable receipt, not just the display", async () => {
    const i = button(`pet:cancelbuy:${owner}:request`);
    await handlePetButton(i as never);
    expect(mocks.cancel).toHaveBeenCalledWith("pet-buy:request", "guild", owner);
    expect(mocks.buy).not.toHaveBeenCalled();
  });
  it("requires confirmation before deleting and keeps the custom ID within Discord limits", async () => {
    const i = command("delete", { user: { id: "32345678901234567890" } }, true);
    await executePet(i as never);
    expect(mocks.remove).not.toHaveBeenCalled();
    const reply = i.editReply.mock.calls[0]![0];
    expect(reply.content).toContain("取り消せません");
    expect(reply.components[0].components[0].data.custom_id.length).toBeLessThanOrEqual(100);
  });
  it("rechecks administrator permission when the deletion button is pressed", async () => {
    const i = button(`pet:remove:${owner}:other:pet-id:9999999999`, false);
    await handlePetButton(i as never);
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("管理者のみ") }));
  });
  it("uses the target and reference to deduplicate administrator-registered rewards", async () => {
    const i = command("reward", { user: { id: "target", bot: false }, item: "mythic", quantity: 1, reference: "event-win" }, true);
    await executePet(i as never);
    expect(mocks.grant).toHaveBeenCalledWith("pet-reward:guild:target:event-win", "guild", "target", owner, "mythic", 1);
  });
  it("hatches only the selected rarity, through the authenticated user's account", async () => {
    const i = command("hatch", { egg: "mythic" });
    await executePet(i as never);
    expect(mocks.hatch).toHaveBeenCalledWith(i.id, "guild", owner, "mythic");
  });
  it("blocks panel installation without live administrator permission", async () => {
    const i = command("panel");
    await executePet(i as never);
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("管理者のみ") }));
  });
  it("installs a public panel for eggs, food and toys", async () => {
    const i = { ...command("panel", {}, true), channel: { send: vi.fn() } };
    await executePet(i as never);
    expect(i.channel.send).toHaveBeenCalledOnce();
    const row = i.channel.send.mock.calls[0]![0].components[0];
    expect(row.components.map((c: { data: { custom_id: string } }) => c.data.custom_id))
      .toEqual(["pet:shop:rare", "pet:shop:food", "pet:shop:toy"]);
    expect(mocks.buy).not.toHaveBeenCalled();
  });
  it("opens an individual purchase confirmation from a public panel without modifying it", async () => {
    const i = button("pet:shop:toy");
    await handlePetButton(i as never);
    expect(mocks.buy).not.toHaveBeenCalled();
    expect(i.message.edit).not.toHaveBeenCalled();
    expect(i.deferReply).toHaveBeenCalledOnce();
    const reply = i.editReply.mock.calls[0]![0];
    expect(reply.content).toContain("おもちゃ ×1");
    expect(reply.content).toContain("$50");
    expect(reply.components[0].components[0].data.custom_id).toContain(`pet:buy:${owner}:toy:1:50:`);
  });
  it("rejects a normal egg button left on an older panel", async () => {
    const i = button("pet:shop:normal");
    await handlePetButton(i as never);
    expect(mocks.buy).not.toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("パネルでは販売していません"),
    }));
  });
});
