import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ButtonInteraction, ChatInputCommandInteraction, StringSelectMenuInteraction } from "discord.js";
import type { KpTicketSession } from "@workspace/db";

const m = vi.hoisted(() => ({
  settings: vi.fn(), configure: vi.fn(), getSession: vi.fn(), create: vi.fn(), advance: vi.fn(),
  panel: vi.fn(), register: vi.fn(), settle: vi.fn(), deliver: vi.fn(),
  guildSettings: vi.fn(), getItem: vi.fn(), listItems: vi.fn(), error: vi.fn(),
}));
vi.mock("@workspace/db", async importOriginal => ({
  ...await importOriginal<typeof import("@workspace/db")>(),
  getKpTicketSettings: m.settings, configureKpTicket: m.configure,
  getKpTicketSession: m.getSession, createKpTicketSession: m.create, advanceKpTicketSession: m.advance,
  isKpTicketPanel: m.panel, registerKpTicketPanel: m.register, settleKpTicket: m.settle, deliverKpTicketLog: m.deliver,
}));
vi.mock("../lib/economy", () => ({
  getGuildSettings: m.guildSettings, getShopItem: m.getItem, listShopItems: m.listItems,
}));
vi.mock("../lib/logger", () => ({ logger: { error: m.error } }));
import { handleKpTicketInteraction, executeKpTicketCommand } from "../commands/kpTicket";
import { KP_TICKET_PREFIX, ticketId } from "../lib/kpTicketUi";

const drink = { id: 1, name: "ドリンク", price: 100, category: "kp", effectType: null, targetRoleId: null };
let session: KpTicketSession;
let settings: { guildId: string; castRoleIds: string[]; vipPrice: number | null; extensionPrice: number | null };
function member(id: string, roleIds: string[], bot = false) {
  return { id, displayName: id, user: { bot }, roles: { cache: new Map(roleIds.map(id => [id, {}])) } };
}
function fixture() {
  const eligible = [member("black-cast", ["black"]), member("white-cast", ["white"]),
    member("both-cast", ["black", "white"]), member("outsider", []), member("robot", ["black"], true)];
  const members = new Map(eligible.map(m => [m.id, m]));
  return {
    id: "1000000000000000000", customId: `${KP_TICKET_PREFIX}start`,
    guildId: "guild", channelId: "ticket", user: { id: "buyer" }, message: { id: "panel" }, values: [] as string[],
    guild: {
      id: "guild", roles: { fetch: vi.fn(async id => ({ id })) },
      members: { me: { id: "bot" }, fetch: vi.fn(async arg => typeof arg === "string" ? members.get(arg) : members) },
    },
    channel: { id: "ticket", isThread: () => false, permissionsFor: () => ({ has: () => true }),
      send: vi.fn().mockResolvedValue({ id: "receipt" }) },
    isButton: () => true, isStringSelectMenu: () => false,
    deferReply: vi.fn().mockResolvedValue(undefined), deferUpdate: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined), followUp: vi.fn().mockResolvedValue(undefined),
  };
}
const run = (i: ReturnType<typeof fixture>) => handleKpTicketInteraction(i as unknown as ButtonInteraction);
async function choose(i: ReturnType<typeof fixture>, value: string) {
  i.customId = ticketId(session.phase, session);
  i.values = [value];
  i.isButton = () => false; i.isStringSelectMenu = () => true;
  await handleKpTicketInteraction(i as unknown as StringSelectMenuInteraction);
}
beforeEach(() => {
  vi.clearAllMocks();
  settings = { guildId: "guild", castRoleIds: ["black", "white"], vipPrice: 500, extensionPrice: 200 };
  session = { id: "1000000000000000000", guildId: "guild", channelId: "ticket", userId: "buyer",
    phase: "cast", version: 0, selection: {}, expiresAt: new Date(Date.now() + 1200000),
    createdAt: new Date(), paidAt: null, logMessageId: null };
  m.settings.mockImplementation(async () => settings);
  m.create.mockImplementation(async () => session);
  m.getSession.mockImplementation(async () => session);
  m.advance.mockImplementation(async (_previous, phase, selection) => {
    session = { ...session, phase, selection, version: session.version + 1 };
    return session;
  });
  m.panel.mockResolvedValue(true);
  m.guildSettings.mockResolvedValue({ currencyName: "円" });
  m.getItem.mockResolvedValue(drink);
  m.listItems.mockResolvedValue([drink]);
  m.settle.mockImplementation(async () => {
    session = { ...session, phase: "paid", paidAt: new Date() };
    return { status: "paid", session };
  });
  m.deliver.mockImplementation(async (_id, send) => send(session));
});

describe("KP ticket component flow", () => {
  it("takes an additional drink order without VIP or extension fees and logs it in the ticket", async () => {
    settings.vipPrice = null; settings.extensionPrice = null;
    const i = fixture();
    i.customId = `${KP_TICKET_PREFIX}additional`;
    await run(i);
    expect(i.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(m.panel).toHaveBeenCalledWith("panel", "guild", "ticket");
    expect(m.create).toHaveBeenCalledWith(i.id, "guild", "ticket", "buyer");
    await choose(i, "black-cast");
    expect(session.phase).toBe("drink");
    await choose(i, "1");
    await choose(i, "3");
    expect(session.selection.quote).toMatchObject({ total: 300, vipPrice: 0, extensionPrice: 0 });
    expect(m.settle).not.toHaveBeenCalled();
    i.customId = ticketId("confirm", session); i.isButton = () => true; i.isStringSelectMenu = () => false;
    await run(i);
    expect(m.settle).toHaveBeenCalledOnce();
    expect(i.channel.send).toHaveBeenCalledOnce();
    expect(i.channel.send.mock.calls[0]![0].embeds[0].toJSON().fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "合計金額", value: "300円" }),
    ]));
  });
  it("rejects additional orders from an unregistered panel before creating or charging an order", async () => {
    const i = fixture(); i.customId = `${KP_TICKET_PREFIX}additional`;
    m.panel.mockResolvedValue(false);
    await run(i);
    expect(m.create).not.toHaveBeenCalled();
    expect(m.settle).not.toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("未登録") }));
  });
  it("shows only members with either cast role and never duplicates a dual-role member", async () => {
    const i = fixture(); await run(i);
    const menu = i.editReply.mock.calls[0]![0].components[0].toJSON().components[0];
    expect(menu.options.map((o: { value: string }) => o.value).sort()).toEqual(["black-cast", "both-cast", "white-cast"]);
    expect(m.settle).not.toHaveBeenCalled();
  });
  it("completes all choices, quotes the full total, and charges only after explicit confirmation", async () => {
    const i = fixture(); await run(i);
    await choose(i, "black-cast");
    await choose(i, "yes");
    await choose(i, "yes");
    await choose(i, "1");
    await choose(i, "3");
    expect(session.phase).toBe("confirm");
    expect(session.selection.quote!.total).toBe(1000);
    expect(m.settle).not.toHaveBeenCalled();
    i.customId = ticketId("confirm", session); i.isButton = () => true; i.isStringSelectMenu = () => false;
    await run(i);
    expect(m.settle).toHaveBeenCalledWith(session.id, 5, "buyer", "guild", "ticket", ["black", "white"]);
    expect(i.channel.send).toHaveBeenCalledOnce();
    const log = i.channel.send.mock.calls[0]![0];
    expect(log.embeds[0].toJSON().fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "指名キャスト", value: "<@black-cast>" }),
      expect.objectContaining({ name: "合計金額", value: "1,000円" }),
    ]));
    expect(log.allowedMentions).toEqual({ parse: [] });
  });
  it("keeps VIP unset separate from a free VIP and does not advance for an unset requested extra", async () => {
    settings.vipPrice = null;
    const i = fixture(); await choose(i, "black-cast");
    await choose(i, "yes");
    expect(session.phase).toBe("vip");
    expect(i.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("VIP料金が未設定") }));
    settings.vipPrice = 0; await choose(i, "yes");
    expect(session.phase).toBe("extension");
  });
  it("rejects an outsider, another owner, a stale component and an expired order without settling", async () => {
    const i = fixture(); await choose(i, "outsider");
    expect(session.phase).toBe("cast");
    i.user.id = "other"; i.customId = ticketId("cast", session); await run(i);
    expect(i.followUp).toHaveBeenLastCalledWith(expect.objectContaining({ content: expect.stringContaining("他の人") }));
    i.user.id = "buyer"; i.customId = `${KP_TICKET_PREFIX}cast:${session.id}:99:0`; await run(i);
    expect(i.followUp).toHaveBeenLastCalledWith(expect.objectContaining({ content: expect.stringContaining("期限切れ") }));
    session.expiresAt = new Date(0); i.customId = ticketId("cast", session); await run(i);
    expect(m.settle).not.toHaveBeenCalled();
  });
  it("rechecks the cast at confirmation and stops if their role was removed", async () => {
    const i = fixture();
    session.phase = "confirm"; session.selection = { castId: "outsider" };
    i.customId = ticketId("confirm", session); await run(i);
    expect(m.settle).not.toHaveBeenCalled();
    expect(i.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("対象ロール") }));
  });
  it("does not charge on cancel", async () => {
    const i = fixture(); i.customId = ticketId("cancel", session); await run(i);
    expect(session.phase).toBe("cancelled");
    expect(m.settle).not.toHaveBeenCalled();
  });
  it("allows log retry for a paid order even after expiry, without settling again", async () => {
    const i = fixture();
    session.phase = "paid"; session.expiresAt = new Date(0);
    session.selection = { castId: "black-cast", vip: false, extension: false,
      quote: { itemId: 1, itemName: "ドリンク", unitPrice: 100, quantity: 1, total: 100, vipPrice: 0, extensionPrice: 0 } };
    i.customId = ticketId("retry-log", session); await run(i);
    expect(m.settle).not.toHaveBeenCalled();
    expect(m.deliver).toHaveBeenCalledOnce();
  });
  it("shows the updated total without completing payment when prices changed", async () => {
    const i = fixture();
    session.phase = "confirm";
    session.selection = { castId: "black-cast", quote: { itemId: 1, itemName: "ドリンク", unitPrice: 200, quantity: 1, total: 200, vipPrice: 0, extensionPrice: 0 } };
    m.settle.mockResolvedValue({ status: "changed", session });
    i.customId = ticketId("confirm", session); await run(i);
    expect(m.deliver).not.toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("引き落としていません") }));
  });

  it("blocks confirmation when logs cannot be posted, without taking money", async () => {
    const i = fixture();
    session.phase = "confirm"; session.selection = { castId: "black-cast" };
    i.channel.permissionsFor = () => ({ has: () => false });
    i.customId = ticketId("confirm", session); await run(i);
    expect(m.settle).not.toHaveBeenCalled();
    expect(i.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("引き落としは行っていません") }));
  });
});

describe("KP ticket price administration", () => {
  it("installs a ticket panel without deciding prices and preserves unset fees", async () => {
    const roleMap = new Map([
      ["black", { id: "black", name: "黒真珠" }], ["white", { id: "white", name: "白真珠" }],
    ]);
    const channel = { id: "ticket", type: 0, isThread: () => false,
      permissionsFor: () => ({ has: () => true }), send: vi.fn().mockResolvedValue({ id: "panel" }) };
    const interaction = {
      guildId: "guild", guild: { id: "guild", roles: { fetch: vi.fn().mockResolvedValue(roleMap) }, members: { me: { id: "bot" } } },
      channel, memberPermissions: { has: () => true },
      options: { getSubcommand: () => "ticket-panel", getRole: () => null },
      deferReply: vi.fn(), editReply: vi.fn(),
    };
    await executeKpTicketCommand(interaction as unknown as ChatInputCommandInteraction);
    expect(m.configure).toHaveBeenCalledWith("guild", { castRoleIds: ["black", "white"] });
    expect(m.register).toHaveBeenCalledWith("panel", "guild", "ticket");
    expect(channel.send).toHaveBeenCalledOnce();
    const panel = channel.send.mock.calls[0]![0];
    expect(panel.embeds[0].toJSON().description).toBe("キミノヒトミニKP予約受付");
    expect(panel.components[0].toJSON().components).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "注文する", custom_id: `${KP_TICKET_PREFIX}start` }),
      expect.objectContaining({ label: "追加注文", custom_id: `${KP_TICKET_PREFIX}additional` }),
    ]));
  });

  it("lets an administrator set a price later without resetting the other price", async () => {
    m.configure.mockResolvedValue({ ...settings, vipPrice: 300 });
    const interaction = {
      guildId: "guild", guild: { id: "guild" }, memberPermissions: { has: () => true },
      options: { getSubcommand: () => "ticket-prices", getInteger: (name: string) => name === "vip" ? 300 : null, getString: () => null },
      deferReply: vi.fn(), editReply: vi.fn(),
    };
    await executeKpTicketCommand(interaction as unknown as ChatInputCommandInteraction);
    expect(m.configure).toHaveBeenCalledWith("guild", { vipPrice: 300 });
  });
  it("shows unset status without configuring any free default prices", async () => {
    settings.vipPrice = null; settings.extensionPrice = null;
    const interaction = {
      guildId: "guild", guild: { id: "guild" }, memberPermissions: { has: () => true },
      options: { getSubcommand: () => "ticket-prices", getInteger: () => null, getString: () => null },
      deferReply: vi.fn(), editReply: vi.fn(),
    };
    await executeKpTicketCommand(interaction as unknown as ChatInputCommandInteraction);
    expect(m.configure).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("未設定"));
  });
});
