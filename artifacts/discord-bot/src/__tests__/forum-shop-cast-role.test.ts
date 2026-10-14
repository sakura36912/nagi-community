import { beforeEach, describe, expect, it, vi } from "vitest";
import { Collection, type ButtonInteraction, type StringSelectMenuInteraction, type UserSelectMenuInteraction } from "discord.js";

const mocks = vi.hoisted(() => ({
  getPanel: vi.fn(), getItem: vi.fn(), buy: vi.fn(), settings: vi.fn(),
  savePanel: vi.fn(), setMessage: vi.fn(),
}));
vi.mock("@workspace/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@workspace/db")>(),
  getShopForumPanel: mocks.getPanel,
  upsertShopForumPanel: mocks.savePanel, setShopForumPanelMessage: mocks.setMessage,
}));
vi.mock("../lib/economy", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/economy")>(),
  getShopItem: mocks.getItem, buyItemQuantity: mocks.buy, getGuildSettings: mocks.settings,
}));
import { commands, handleForumCastPage, handleForumPurchaseCast, handleForumPurchaseQuantity } from "../commands/index";

function fixture(role = true, bot = false) {
  const cast = { id: "cast", displayName: "担当キャスト", user: { bot, username: "cast" },
    roles: { cache: new Collection(role ? [["cast-role", { id: "cast-role" }]] : []) } };
  const guild = {
    id: "guild", roles: { fetch: vi.fn(async () => ({ id: "cast-role" })) },
    members: { fetch: vi.fn(async (options: unknown) => options && typeof options === "object" && "withPresences" in options
      ? new Collection([["cast", cast]]) : cast) },
    channels: { cache: new Collection(), fetch: vi.fn(async () => ({ isTextBased: () => true, send: vi.fn().mockResolvedValue(undefined) })) },
  };
  return {
    guildId: "guild", channelId: "thread", guild, user: { id: "buyer" }, memberPermissions: { has: () => true },
    customId: "shop:forum-cast:10:2", values: ["cast"],
    update: vi.fn().mockResolvedValue(undefined), deferUpdate: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined), editReply: vi.fn().mockResolvedValue(undefined),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPanel.mockResolvedValue({ shopItemId: 10, logChannelId: "log", castRoleId: "cast-role" });
  mocks.getItem.mockResolvedValue({ id: 10, category: "forum", price: 100, name: "商品", effectType: null, targetRoleId: null });
  mocks.settings.mockResolvedValue({ currencyName: "円" });
  mocks.buy.mockResolvedValue({ ok: true, item: { name: "商品", price: 100 }, totalPrice: 200 });
  mocks.savePanel.mockResolvedValue({
    panel: { shopItemId: 10, panelMessageId: null, castRoleId: "cast-role" },
    item: { id: 10, name: "商品", price: 100 },
  });
  mocks.setMessage.mockResolvedValue(undefined);
});

describe("forum shop cast-role enforcement", () => {
  it("displays a role-only string picker after choosing quantity, and refreshes on page navigation", async () => {
    const interaction = fixture();
    interaction.customId = "shop:forum-quantity:10";
    interaction.values = ["2"];
    await handleForumPurchaseQuantity(interaction as unknown as StringSelectMenuInteraction);
    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    const menu = interaction.editReply.mock.calls[0][0].components[0].components[0].toJSON();
    expect(menu.options.map((option: { value: string }) => option.value)).toEqual(["cast"]);
    expect(menu.type).toBe(3);
    interaction.customId = "shop:forum-cast-page:10:2:0";
    await handleForumCastPage(interaction as unknown as ButtonInteraction);
    expect(interaction.guild.members.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.buy).not.toHaveBeenCalled();
  });
  it.each(["string", "legacy-user"])("rejects non-role members before any debit via %s selector", async () => {
    const interaction = fixture(false);
    await handleForumPurchaseCast(interaction as unknown as StringSelectMenuInteraction | UserSelectMenuInteraction);
    expect(interaction.guild.members.fetch).toHaveBeenCalledWith({ user: "cast", force: true });
    expect(interaction.editReply.mock.calls.at(-1)?.[0]).toContain("対象ロールを持っていない");
    expect(mocks.buy).not.toHaveBeenCalled();
    expect(mocks.settings).not.toHaveBeenCalled();
  });
  it("rejects a bot even if it holds the role", async () => {
    await handleForumPurchaseCast(fixture(true, true) as unknown as StringSelectMenuInteraction);
    expect(mocks.buy).not.toHaveBeenCalled();
  });
  it("fails closed for old panels with no role configured, and never offers everyone", async () => {
    mocks.getPanel.mockResolvedValue({ shopItemId: 10, logChannelId: "log", castRoleId: null });
    const interaction = fixture();
    interaction.customId = "shop:forum-quantity:10";
    interaction.values = ["2"];
    await handleForumPurchaseQuantity(interaction as unknown as StringSelectMenuInteraction);
    expect(interaction.editReply.mock.calls[0][0]).toMatchObject({ components: [] });
    expect(interaction.guild.members.fetch).not.toHaveBeenCalled();
    interaction.customId = "shop:forum-cast:10:2";
    interaction.values = ["cast"];
    await handleForumPurchaseCast(interaction as unknown as StringSelectMenuInteraction);
    expect(mocks.buy).not.toHaveBeenCalled();
  });
  it("allows an eligible member through the unchanged purchase and logging flow", async () => {
    const interaction = fixture();
    await handleForumPurchaseCast(interaction as unknown as StringSelectMenuInteraction);
    expect(mocks.buy).toHaveBeenCalledWith("guild", "buyer", 10, "円", 2);
    expect(interaction.editReply.mock.calls.at(-1)?.[0]).toContain("購入を受け付けました");
  });
  it("stops selection when full member fetch fails, without any charge", async () => {
    const interaction = fixture();
    interaction.customId = "shop:forum-quantity:10";
    interaction.values = ["2"];
    interaction.guild.members.fetch.mockRejectedValueOnce(new Error("Discord member lookup failed"));
    await handleForumPurchaseQuantity(interaction as unknown as StringSelectMenuInteraction);
    expect(interaction.editReply.mock.calls.at(-1)?.[0]).toMatchObject({ components: [], content: "Discord member lookup failed" });
    expect(mocks.buy).not.toHaveBeenCalled();
  });
  it("checks the current panel role again if the administrator changed it after showing choices", async () => {
    mocks.getPanel.mockResolvedValue({ shopItemId: 10, logChannelId: "log", castRoleId: "new-role" });
    await handleForumPurchaseCast(fixture() as unknown as StringSelectMenuInteraction);
    expect(mocks.buy).not.toHaveBeenCalled();
  });
  it("permits purchase when the cast holds only the second configured role", async () => {
    mocks.getPanel.mockResolvedValue({ shopItemId: 10, logChannelId: "log", castRoleId: "other-role", castRoleIds: ["other-role", "cast-role"] });
    await handleForumPurchaseCast(fixture() as unknown as StringSelectMenuInteraction);
    expect(mocks.buy).toHaveBeenCalledOnce();
  });
  it("blocks an old selection if all matching roles were removed from the current configuration", async () => {
    mocks.getPanel.mockResolvedValue({ shopItemId: 10, logChannelId: "log", castRoleId: "other", castRoleIds: ["other", "new"] });
    await handleForumPurchaseCast(fixture() as unknown as StringSelectMenuInteraction);
    expect(mocks.buy).not.toHaveBeenCalled();
  });
});

describe("forum panel cast-role configuration", () => {
  const shop = commands.find((command) => command.data.name === "shop")!;
  function setup(castRole: string | null) {
    return {
      ...fixture(),
      channel: { id: "thread", isThread: () => true, parent: { type: 15 },
        messages: { fetch: vi.fn() }, send: vi.fn(async () => ({ id: "panel-message" })) },
      reply: vi.fn().mockResolvedValue(undefined),
      options: {
        getSubcommand: () => "forum-panel", getString: (name: string) => name === "name" ? "商品" : null,
        getInteger: () => 100, getRole: (name: string) => name === "cast_role" && castRole ? { id: castRole } : null,
        getChannel: () => ({ id: "log" }),
      },
    };
  }
  it("saves the selection role separately from the purchase-grant role", async () => {
    const interaction = setup("new-cast-role");
    await shop.execute(interaction as never);
    expect(mocks.savePanel).toHaveBeenCalledWith("guild", "thread", null, expect.objectContaining({
      castRoleId: "new-cast-role", targetRoleId: null,
    }));
    expect(interaction.editReply.mock.calls[0][0].content).toContain("new-cast-role");
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.reply).not.toHaveBeenCalled();
  });
  it("preserves a configured cast role when other panel settings are edited without cast_role", async () => {
    await shop.execute(setup(null) as never);
    expect(mocks.savePanel).toHaveBeenCalledWith("guild", "thread", null, expect.objectContaining({ castRoleId: "cast-role" }));
  });
  it("keeps all configured roles when editing product settings and attaches a multi-role selector", async () => {
    mocks.getPanel.mockResolvedValue({ shopItemId: 10, logChannelId: "log", castRoleId: "cast-role", castRoleIds: ["cast-role", "second-role"] });
    const interaction = setup(null);
    await shop.execute(interaction as never);
    expect(mocks.savePanel).toHaveBeenCalledWith("guild", "thread", null, expect.objectContaining({
      castRoleIds: ["cast-role", "second-role"],
    }));
    const selector = interaction.editReply.mock.calls[0][0].components[0].components[0].toJSON();
    expect(selector.type).toBe(6);
    expect(selector.max_values).toBe(25);
  });
  it("requires an explicit role for a new panel and rejects @everyone", async () => {
    mocks.getPanel.mockResolvedValue(undefined);
    await shop.execute(setup(null) as never);
    await shop.execute(setup("guild") as never);
    expect(mocks.savePanel).not.toHaveBeenCalled();
  });
  it("acknowledges before a slow database lookup and finishes the original response", async () => {
    let finishLookup!: (panel: { shopItemId: number; castRoleId: string; logChannelId: string }) => void;
    mocks.getPanel.mockImplementationOnce(() => new Promise((resolve) => { finishLookup = resolve; }));
    const interaction = setup(null);
    const pending = shop.execute(interaction as never);
    await vi.waitFor(() => expect(mocks.getPanel).toHaveBeenCalledOnce());
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.deferReply.mock.invocationCallOrder[0]).toBeLessThan(mocks.getPanel.mock.invocationCallOrder[0]);
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.editReply).not.toHaveBeenCalled();
    finishLookup({ shopItemId: 10, castRoleId: "cast-role", logChannelId: "log" });
    await pending;
    expect(interaction.editReply).toHaveBeenCalledOnce();
    expect(interaction.reply).not.toHaveBeenCalled();
  });
  it("completes validation errors through the deferred response without posting a panel", async () => {
    mocks.getPanel.mockResolvedValueOnce(undefined);
    const interaction = setup(null);
    await shop.execute(interaction as never);
    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("cast_role") }));
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.channel.send).not.toHaveBeenCalled();
    expect(mocks.savePanel).not.toHaveBeenCalled();
  });
});
