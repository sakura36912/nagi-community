import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ButtonInteraction, ChatInputCommandInteraction, StringSelectMenuInteraction, ModalSubmitInteraction } from "discord.js";
import type { KpTicketSession } from "@workspace/db";

const m = vi.hoisted(() => ({
  settings: vi.fn(), configure: vi.fn(), getSession: vi.fn(), create: vi.fn(), advance: vi.fn(),
  panel: vi.fn(), register: vi.fn(), settle: vi.fn(), deliver: vi.fn(), paidOrders: vi.fn(), createAdditional: vi.fn(),
  transfers: vi.fn(),
  guildSettings: vi.fn(), getItem: vi.fn(), listItems: vi.fn(), error: vi.fn(),
  vipSource: vi.fn(),
}));
vi.mock("@workspace/db", async importOriginal => ({
  ...await importOriginal<typeof import("@workspace/db")>(),
  getKpTicketSettings: m.settings, configureKpTicket: m.configure,
  getKpTicketSession: m.getSession, createKpTicketSession: m.create, advanceKpTicketSession: m.advance,
  isKpTicketPanel: m.panel, registerKpTicketPanel: m.register, settleKpTicket: m.settle, deliverKpTicketLog: m.deliver,
  listPaidKpTicketOrders: m.paidOrders, listTransfersToRecipient: m.transfers,
  createAdditionalKpTicketSession: m.createAdditional,
}));
vi.mock("../lib/economy", () => ({
  getGuildSettings: m.guildSettings, getShopItem: m.getItem, listShopItems: m.listItems,
}));
vi.mock("../lib/logger", () => ({ logger: { error: m.error } }));
vi.mock("../lib/kpVipVc", () => ({ validateKpVipSource: m.vipSource }));
import { handleKpTicketInteraction, executeKpTicketCommand, handleKpTicketSalesDate } from "../commands/kpTicket";
import { KP_TICKET_PREFIX, ticketId } from "../lib/kpTicketUi";

const drink = { id: 1, name: "ドリンク", price: 100, category: "kp", effectType: null, targetRoleId: null };
let session: KpTicketSession;
let settings: { guildId: string; castRoleIds: string[]; vipPrice: number | null; extensionPrice: number | null };
function member(id: string, roleIds: string[], bot = false) {
  return { id, guild: { id: "guild" }, displayName: id, user: { bot }, roles: { cache: new Map(roleIds.map(id => [id, {}])) } };
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
      members: { me: { id: "bot" }, fetch: vi.fn(async arg =>
        typeof arg === "string" ? members.get(arg) : arg && "user" in arg ? members.get(arg.user) : members) },
    },
    channel: { id: "ticket", guildId: "guild", type: 12, isThread: () => true, permissionsFor: () => ({ has: () => true }),
      parent: { guildId: "guild", permissionsFor: vi.fn(() => ({ has: (): boolean => true })),
        permissionOverwrites: { edit: vi.fn() } },
      members: { add: vi.fn().mockResolvedValue(undefined) },
      permissionOverwrites: { edit: vi.fn().mockResolvedValue(undefined) },
      send: vi.fn().mockResolvedValue({ id: "receipt" }) },
    isButton: () => true, isStringSelectMenu: () => false,
    reply: vi.fn().mockResolvedValue(undefined),
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
    phase: "cast", version: 0, selection: { serviceVersion: 2 }, expiresAt: new Date(Date.now() + 1200000),
    createdAt: new Date(), paidAt: null, logMessageId: null };
  m.settings.mockImplementation(async () => settings);
  m.create.mockImplementation(async () => session);
  m.createAdditional.mockImplementation(async () => {
    session = { ...session, phase: "vip", selection: { castId: "black-cast", fixedCastId: "black-cast", vip: false, extension: false,
      serviceVersion: 2, baseOrderId: "base", vipActive: false } };
    return session;
  });
  m.getSession.mockImplementation(async () => session);
  m.advance.mockImplementation(async (_previous, phase, selection) => {
    session = { ...session, phase, selection, version: session.version + 1 };
    return session;
  });
  m.panel.mockResolvedValue(true);
  m.paidOrders.mockResolvedValue([]);
  m.transfers.mockResolvedValue([]);
  m.guildSettings.mockResolvedValue({ currencyName: "円" });
  m.getItem.mockResolvedValue(drink);
  m.listItems.mockResolvedValue([drink]);
  m.settle.mockImplementation(async () => {
    session = { ...session, phase: "paid", paidAt: new Date() };
    return { status: "paid", session };
  });
  m.deliver.mockImplementation(async (_id, send) => send(session));
  m.vipSource.mockResolvedValue(undefined);
});

describe("KP ticket component flow", () => {
  async function extrasOnly(i: ReturnType<typeof fixture>) {
    i.customId = ticketId("extras-only", session); i.isButton = () => true; i.isStringSelectMenu = () => false;
    await run(i);
  }
  it("offers two VIP types on the first order, but never extension", async () => {
    const i = fixture(); await choose(i, "black-cast");
    expect(session.phase).toBe("vip");
    await choose(i, "solo");
    expect(session.phase).toBe("drink");
    await extrasOnly(i);
    expect(session.phase).toBe("confirm");
    expect(session.selection.quote).toMatchObject({ total: 200000, vipPrice: 200000, extensionPrice: 0, itemId: null });
    expect(m.settle).not.toHaveBeenCalled();
    i.customId = ticketId("confirm", session); await run(i);
    expect(m.vipSource).toHaveBeenCalledWith(i.guild);
    expect(m.settle).toHaveBeenCalledOnce();
    expect(i.editReply.mock.calls.at(-1)![0].content).toContain("1570354388462215248");
  });
  it("purchases 100,000 VIP directly without selecting or adding a companion", async () => {
    const i = fixture(); await choose(i, "black-cast"); await choose(i, "shared");
    expect(session.phase).toBe("drink");
    expect(session.selection.guestId).toBeUndefined();
    await extrasOnly(i);
    expect(session.selection.quote).toMatchObject({ total: 100000, vipPrice: 100000 });
    i.customId = ticketId("confirm", session); await run(i);
    expect(i.channel.members.add.mock.calls.every(call => call[0] === "black-cast")).toBe(true);
    expect(m.settle).toHaveBeenCalledOnce();
    expect(i.channel.parent.permissionOverwrites.edit).not.toHaveBeenCalled();
  });
  it("rejects an old companion menu without granting access or charging", async () => {
    const i = fixture();
    session.phase = "guest";
    session.selection = { castId: "black-cast", serviceVersion: 2, vip: true, vipTier: "shared", extension: false };
    await choose(i, "outsider");
    expect(i.channel.members.add).not.toHaveBeenCalled();
    expect(m.settle).not.toHaveBeenCalled();
    expect(i.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("同伴者の選択はなくなりました") }));
  });
  it("offers 50,000 extension only through additional normal orders, without forcing a drink", async () => {
    const i = fixture(); i.customId = `${KP_TICKET_PREFIX}additional`; await run(i);
    await choose(i, "none");
    expect(session.phase).toBe("extension");
    await choose(i, "yes");
    m.listItems.mockResolvedValue([]);
    await extrasOnly(i);
    expect(session.phase).toBe("confirm");
    expect(session.selection.quote).toMatchObject({ total: 50000, extensionPrice: 50000, vipPrice: 0 });
    expect(m.settle).not.toHaveBeenCalled();
  });
  it("keeps existing VIP additions drink-only and blocks a forged extension action", async () => {
    m.createAdditional.mockImplementationOnce(async () => {
      session = { ...session, phase: "drink", selection: { castId: "black-cast", fixedCastId: "black-cast",
        serviceVersion: 2, vip: false, extension: false, vipActive: true, baseOrderId: "vip-paid" } };
      return session;
    });
    const i = fixture(); i.customId = `${KP_TICKET_PREFIX}additional`; await run(i);
    expect(session.phase).toBe("drink");
    i.customId = ticketId("extension", session); i.values = ["yes"];
    i.isButton = () => false; i.isStringSelectMenu = () => true; await run(i);
    expect(session.selection.extension).toBe(false);
    expect(m.settle).not.toHaveBeenCalled();
  });
  it("does not charge VIP if VC permissions cannot be confirmed", async () => {
    const i = fixture(); await choose(i, "black-cast"); await choose(i, "solo"); await extrasOnly(i);
    const { KpTicketError } = await import("@workspace/db");
    m.vipSource.mockRejectedValueOnce(new KpTicketError("BotのVC権限がありません"));
    i.customId = ticketId("confirm", session); await run(i);
    expect(m.settle).not.toHaveBeenCalled();
    expect(i.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("VC権限") }));
  });
  function allStatementFixture(role: string | null, admin = false) {
    const i = fixture(); i.customId = `${KP_TICKET_PREFIX}all-statement`;
    Object.assign(i.guild.members, { fetch: vi.fn().mockResolvedValue({
      permissions: { has: () => admin },
      roles: { cache: new Map(role ? [["staff", {}]] : []) },
    }) });
    Object.assign(i.guild.roles, { fetch: vi.fn().mockResolvedValue(new Map([
      ["staff", { id: "staff", name: role ?? "なし" }],
    ])) });
    return i;
  }
  it.each(["夜鴉", "黒兵", "admin"])("privately totals every ticket in the guild for %s without charging", async role => {
    const i = allStatementFixture(role === "admin" ? null : role, role === "admin");
    await run(i); await run(i);
    expect(i.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(i.guild.members.fetch).toHaveBeenCalledWith({ user: "buyer", force: true });
    expect(m.paidOrders).toHaveBeenCalledWith("guild", undefined, { start: expect.any(Date), end: expect.any(Date) });
    expect(i.editReply.mock.calls[0]![0].embeds[0].toJSON().title).toContain("全チケット");
    expect(m.transfers).not.toHaveBeenCalled();
    expect(i.channel.send).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled(); expect(m.advance).not.toHaveBeenCalled();
    expect(m.settle).not.toHaveBeenCalled();
  });
  it.each(["夜鴉", "黒兵", "admin"])("privately lists every saved transfer to 凪 for %s", async role => {
    const i = allStatementFixture(role === "admin" ? null : role, role === "admin");
    i.customId = `${KP_TICKET_PREFIX}nagi-transfers`;
    m.transfers.mockResolvedValue([{
      senderId: "sender-1", amount: -2500, createdAt: new Date("2026-11-15T03:00:00.000Z"),
    }]);
    await run(i);
    expect(i.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(m.transfers).toHaveBeenCalledWith("guild", "1276893567599644715");
    const report = i.editReply.mock.calls[0]![0];
    expect(report.embeds[0].toJSON().description).toContain("<@sender-1>");
    expect(report.embeds[0].toJSON().description).toContain("2,500円");
    expect(report.files[0].name).toBe("nagi-transfer-history.txt");
  });
  it("does not disclose transfer history to non-staff or through an unregistered panel", async () => {
    const nonStaff = allStatementFixture("黒真珠");
    nonStaff.customId = `${KP_TICKET_PREFIX}nagi-transfers`;
    await run(nonStaff);
    expect(m.transfers).not.toHaveBeenCalled();

    const unregistered = allStatementFixture("夜鴉");
    unregistered.customId = `${KP_TICKET_PREFIX}nagi-transfers`;
    m.panel.mockResolvedValueOnce(false);
    await run(unregistered);
    expect(m.transfers).not.toHaveBeenCalled();
  });
  it.each([null, "黒真珠", "夜鴉見習い"])("does not disclose other tickets to a non-staff member (%s)", async role => {
    const i = allStatementFixture(role);
    await run(i);
    expect(m.paidOrders).not.toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("夜鴉・黒兵") }));
  });
  it("does not disclose all-ticket statements when fresh membership cannot be fetched", async () => {
    const i = allStatementFixture("夜鴉");
    i.guild.members.fetch.mockRejectedValueOnce(new Error("Discord unavailable"));
    await run(i);
    expect(m.paidOrders).not.toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("操作権限を確認できません") }));
  });
  it("does not query all-ticket statements through unregistered panels", async () => {
    const i = allStatementFixture("夜鴉"); m.panel.mockResolvedValueOnce(false);
    await run(i);
    expect(m.paidOrders).not.toHaveBeenCalled();
  });
  it("reports all-ticket query failures privately without claiming a successful total", async () => {
    const i = allStatementFixture(null, true); m.paidOrders.mockRejectedValueOnce(new Error("Database unavailable"));
    await run(i);
    expect(i.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("処理に失敗") }));
    expect(m.settle).not.toHaveBeenCalled();
  });
  it.each(["夜鴉", "黒兵", "admin"])("allows the ticket statement only for fresh staff membership (%s), without charging", async role => {
    const i = allStatementFixture(role === "admin" ? null : role, role === "admin");
    i.customId = `${KP_TICKET_PREFIX}statement`;
    for (let n = 0; n < 2; n++) await run(i);
    expect(i.guild.members.fetch).toHaveBeenCalledWith({ user: "buyer", force: true });
    expect(m.paidOrders).toHaveBeenCalledWith("guild", "ticket");
    expect(i.deferReply).toHaveBeenCalledWith();
    expect(i.editReply.mock.calls[0]![0].embeds[0].toJSON().description).toContain("支払い済みの注文がありません");
    expect(m.create).not.toHaveBeenCalled();
    expect(m.advance).not.toHaveBeenCalled();
    expect(m.settle).not.toHaveBeenCalled();
  });
  it.each([null, "黒真珠", "白真珠", "夜鴉見習い", "本船員", "島民"])("blocks ticket statement access for non-staff (%s)", async role => {
    const i = allStatementFixture(role); i.customId = `${KP_TICKET_PREFIX}statement`;
    await run(i);
    expect(m.paidOrders).not.toHaveBeenCalled();
    expect(m.guildSettings).not.toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("夜鴉・黒兵") }));
    expect(m.settle).not.toHaveBeenCalled();
  });
  it("blocks the ticket statement when membership lookup fails", async () => {
    const i = allStatementFixture("夜鴉"); i.customId = `${KP_TICKET_PREFIX}statement`;
    i.guild.members.fetch.mockRejectedValueOnce(new Error("Discord unavailable"));
    await run(i);
    expect(m.paidOrders).not.toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("操作権限を確認できません") }));
  });
  it.each(["statement", "all-statement"])("rechecks revoked staff membership on every %s click", async action => {
    const i = allStatementFixture("夜鴉"); i.customId = `${KP_TICKET_PREFIX}${action}`;
    await run(i);
    m.paidOrders.mockClear();
    Object.assign(i.guild.members, { fetch: vi.fn().mockResolvedValue({
      permissions: { has: () => false }, roles: { cache: new Map() },
    }) });
    await run(i);
    expect(m.paidOrders).not.toHaveBeenCalled();
    expect(i.editReply).toHaveBeenLastCalledWith(expect.objectContaining({ content: expect.stringContaining("夜鴉・黒兵") }));
  });
  it("does not disclose statements from unregistered panels", async () => {
    const i = fixture(); i.customId = `${KP_TICKET_PREFIX}statement`;
    m.panel.mockResolvedValue(false);
    await run(i);
    expect(m.paidOrders).not.toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("未登録") }));
  });
  it("reports a statement query failure without claiming an empty or successful total", async () => {
    const i = allStatementFixture(null, true); i.customId = `${KP_TICKET_PREFIX}statement`;
    m.paidOrders.mockRejectedValueOnce(new Error("Database unavailable"));
    await run(i);
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("処理に失敗") }));
    expect(m.settle).not.toHaveBeenCalled();
  });
  it("keeps the cast fixed and allows additional drinks without selecting VIP or extension", async () => {
    settings.vipPrice = null; settings.extensionPrice = null;
    const i = fixture();
    i.customId = `${KP_TICKET_PREFIX}additional`;
    await run(i);
    expect(i.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(m.panel).toHaveBeenCalledWith("panel", "guild", "ticket");
    expect(m.createAdditional).toHaveBeenCalledWith(i.id, "guild", "ticket", "buyer");
    expect(m.create).not.toHaveBeenCalled();
    expect(i.editReply.mock.calls[0]![0].content).toContain("<@black-cast>（変更不可）");
    expect(session.phase).toBe("vip");
    await choose(i, "none"); await choose(i, "no");
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
    expect(m.createAdditional).not.toHaveBeenCalled();
    expect(m.settle).not.toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("未登録") }));
  });
  it("ignores legacy configured fees in an additional drink payment", async () => {
    const i = fixture(); i.customId = `${KP_TICKET_PREFIX}additional`; await run(i);
    await choose(i, "none"); await choose(i, "no");
    await choose(i, "1"); await choose(i, "2");
    expect(session.selection).toMatchObject({ castId: "black-cast", fixedCastId: "black-cast",
      vip: false, extension: false, quote: { total: 200 } });
    expect(m.settle).not.toHaveBeenCalled();
    i.customId = ticketId("confirm", session); i.isButton = () => true; i.isStringSelectMenu = () => false;
    await run(i);
    expect(m.settle).toHaveBeenCalledOnce();
  });
  it("does not offer extras-only payment when no drink catalogue exists", async () => {
    m.listItems.mockResolvedValue([]);
    const i = fixture(); i.customId = `${KP_TICKET_PREFIX}additional`; await run(i);
    await choose(i, "none"); await choose(i, "no");
    expect(i.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("未登録") }));
    i.customId = ticketId("extras-only", session); i.isButton = () => true; i.isStringSelectMenu = () => false;
    await run(i);
    expect(session.phase).toBe("drink");
    expect(m.settle).not.toHaveBeenCalled();
  });
  it("keeps the inherited cast on reset and rejects forged cast selection", async () => {
    const i = fixture(); i.customId = `${KP_TICKET_PREFIX}additional`; await run(i);
    i.customId = ticketId("reset", session); i.isButton = () => true; i.isStringSelectMenu = () => false;
    await run(i);
    expect(session.phase).toBe("vip");
    expect(session.selection).toMatchObject({ castId: "black-cast", fixedCastId: "black-cast", vip: false, extension: false,
      serviceVersion: 2, baseOrderId: "base", vipActive: false });
    i.customId = ticketId("cast", session); i.values = ["white-cast"];
    i.isButton = () => false; i.isStringSelectMenu = () => true;
    await run(i);
    expect(session.selection.castId).toBe("black-cast");
    expect(m.settle).not.toHaveBeenCalled();
  });
  it("rejects old VIP component IDs without advancing or charging", async () => {
    settings.vipPrice = null;
    const i = fixture(); i.customId = `${KP_TICKET_PREFIX}additional`; await run(i);
    i.customId = ticketId("vip", session); i.values = ["yes"];
    await run(i);
    expect(session.phase).toBe("vip");
    expect(i.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("操作順序") }));
    expect(m.settle).not.toHaveBeenCalled();
  });
  it("cannot start an additional order without a previous paid order", async () => {
    const { KpTicketError } = await import("@workspace/db");
    m.createAdditional.mockRejectedValueOnce(new KpTicketError("先に「注文する」から注文してください。"));
    const i = fixture(); i.customId = `${KP_TICKET_PREFIX}additional`; await run(i);
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("先に") }));
    expect(m.settle).not.toHaveBeenCalled();
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
    await choose(i, "none");
    await choose(i, "1");
    await choose(i, "3");
    expect(session.phase).toBe("confirm");
    expect(session.selection.quote!.total).toBe(300);
    expect(m.settle).not.toHaveBeenCalled();
    i.customId = ticketId("confirm", session); i.isButton = () => true; i.isStringSelectMenu = () => false;
    await run(i);
    expect(m.settle).toHaveBeenCalledWith(session.id, 4, "buyer", "guild", "ticket", ["black", "white"]);
    expect(i.channel.send).toHaveBeenCalledOnce();
    const log = i.channel.send.mock.calls[0]![0];
    expect(log.embeds[0].toJSON().fields.map((field: { name: string }) => field.name).join(" ")).not.toMatch(/VIP|延長/);
    expect(log.embeds[0].toJSON().fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "指名キャスト", value: "<@black-cast>" }),
      expect.objectContaining({ name: "合計金額", value: "300円" }),
    ]));
    expect(log.allowedMentions).toEqual({ parse: [] });
  });
  it("rejects old unpaid extras and clears them on reset", async () => {
    const i = fixture();
    session.phase = "confirm";
    session.selection = { castId: "black-cast", vip: true, extension: true };
    i.customId = ticketId("confirm", session); await run(i);
    expect(m.settle).not.toHaveBeenCalled();
    expect(i.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("受付は終了") }));
    i.customId = ticketId("reset", session); await run(i);
    expect(session.phase).toBe("cast");
    expect(session.selection).toEqual({ serviceVersion: 2 });
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

describe("KP ticket business-day date selection", () => {
  function salesFixture(date = "2026-11-08", allowed = true) {
    const i = fixture();
    Object.assign(i.guild.members, { fetch: vi.fn().mockResolvedValue({
      permissions: { has: () => allowed }, roles: { cache: new Map() },
    }) });
    Object.assign(i.guild.roles, { fetch: vi.fn().mockResolvedValue(new Map()) });
    return Object.assign(i, {
      customId: `${KP_TICKET_PREFIX}sales-modal:buyer`,
      isModalSubmit: (): boolean => true, isButton: (): boolean => false,
      fields: { getTextInputValue: () => date }, showModal: vi.fn(),
    });
  }
  const submit = (i: ReturnType<typeof salesFixture>) =>
    handleKpTicketSalesDate(i as unknown as ModalSubmitInteraction);
  it("queries exactly the requested JST overnight period privately without fetching deleted channels", async () => {
    const i = salesFixture();
    await submit(i);
    expect(i.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(i.guild.members.fetch).toHaveBeenCalledWith({ user: "buyer", force: true });
    expect(m.paidOrders).toHaveBeenCalledWith("guild", undefined, {
      start: new Date("2026-11-08T09:00:00Z"), end: new Date("2026-11-09T01:00:00Z"),
    });
    const reply = i.editReply.mock.calls[0]![0];
    expect(reply.embeds[0].toJSON().fields[1].value).toContain("2026-11-08 18:00");
    expect(reply.embeds).toHaveLength(2);
    expect(reply.embeds[0].toJSON().title).toContain("全チケット明細");
    expect(reply.embeds[1].toJSON().title).toContain("キャスト別売上");
    expect(reply.embeds[1].toJSON().fields[1].value).toContain("2026-11-08 18:00");
    expect(reply.files.map((file: { name: string }) => file.name)).toEqual([
      "kp-all-tickets-statement.txt", "kp-cast-sales.txt",
    ]);
    expect(reply.components[0].toJSON().components[0].label).toBe("営業日を指定");
    expect(m.settle).not.toHaveBeenCalled();
    expect(i.channel.send).not.toHaveBeenCalled();
  });
  it("uses the same paid records for both reports and keeps a large combined response within Discord limits", async () => {
    const i = salesFixture();
    const orders = Array.from({ length: 80 }, (_, index) => ({
      ...session, id: `order-${index}`, phase: "paid", channelId: `deleted-ticket-${index}`,
      selection: { castId: String(100000000000000000n + BigInt(index)), quote: {
        itemId: 1, itemName: "長い商品名".repeat(30), quantity: 1,
        unitPrice: 100, vipPrice: 0, extensionPrice: 0, total: 100,
      } },
    }));
    m.paidOrders.mockResolvedValueOnce(orders);
    await submit(i);
    const reply = i.editReply.mock.calls[0]![0];
    expect(m.paidOrders).toHaveBeenCalledOnce();
    expect(reply.embeds[0].toJSON().fields[0].value).toContain("8,000円");
    expect(reply.embeds.reduce((sum: number, embed: { length: number }) => sum + embed.length, 0)).toBeLessThan(6000);
    const fullText = (reply.files[0].attachment as Buffer).toString("utf8");
    const castText = (reply.files[1].attachment as Buffer).toString("utf8");
    expect(fullText.match(/注文ID:/g)).toHaveLength(80);
    expect(castText.match(/キャストID:/g)).toHaveLength(80);
    expect(reply.allowedMentions).toEqual({ parse: [] });
    expect(m.settle).not.toHaveBeenCalled();
  });
  it("opens a date modal without loading any sales data", async () => {
    const i = salesFixture(); i.customId = `${KP_TICKET_PREFIX}sales-date:buyer`;
    i.isButton = () => true;
    await handleKpTicketSalesDate(i as unknown as ButtonInteraction);
    expect(i.showModal).toHaveBeenCalledOnce();
    expect(i.showModal.mock.calls[0]![0].toJSON().custom_id).toBe(`${KP_TICKET_PREFIX}sales-modal:buyer`);
    expect(m.paidOrders).not.toHaveBeenCalled();
  });
  it("rejects invalid dates without querying or changing money", async () => {
    const i = salesFixture("2026-02-30"); await submit(i);
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("存在する日付") }));
    expect(m.paidOrders).not.toHaveBeenCalled();
    expect(m.settle).not.toHaveBeenCalled();
  });
  it("rechecks revoked staff permissions on submission", async () => {
    const i = salesFixture("2026-11-08", false); await submit(i);
    expect(m.paidOrders).not.toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("夜鴉・黒兵") }));
  });
  it("rejects another user's date dialog", async () => {
    const i = salesFixture(); i.user.id = "other"; await submit(i);
    expect(m.paidOrders).not.toHaveBeenCalled();
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
  });
  it("reports query failures without disclosing sales or retrying payments", async () => {
    const i = salesFixture(); m.paidOrders.mockRejectedValueOnce(new Error("database unavailable"));
    await submit(i);
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("売上集計に失敗") }));
    expect(m.settle).not.toHaveBeenCalled();
  });
});

describe("KP ticket cast access integration", () => {
  it("blocks payment with missing parent access without editing the parent", async () => {
    const i = fixture();
    i.channel.parent.permissionsFor.mockReturnValue({ has: () => false });
    session.phase = "confirm"; session.selection = { castId: "black-cast" };
    i.customId = ticketId("confirm", session); await run(i);
    expect(i.channel.parent.permissionOverwrites.edit).not.toHaveBeenCalled();
    expect(i.channel.members.add).not.toHaveBeenCalled();
    expect(m.settle).not.toHaveBeenCalled();
    expect(i.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("親チャンネルの権限を変更しません") }));
  });
  it("allows starting an order directly in a text ticket", async () => {
    const i = fixture(); i.channel.type = 0; i.channel.isThread = () => false;
    await run(i);
    expect(m.create).toHaveBeenCalledWith(i.id, "guild", "ticket", "buyer");
    expect(session.phase).toBe("cast");
    expect(i.channel.permissionOverwrites.edit).not.toHaveBeenCalled();
    expect(m.settle).not.toHaveBeenCalled();
  });
  function textTicketFixture() {
    const i = fixture();
    Object.assign(i.channel, {
      type: 0, isThread: () => false,
      permissionsFor: (member: { id: string }) => ({ has: () => member.id === "bot" }),
    });
    return i;
  }
  it("adds only the nominated cast to the text ticket and pays/logs drinks in that ticket", async () => {
    const i = textTicketFixture(); await run(i);
    await choose(i, "black-cast");
    expect(i.channel.permissionOverwrites.edit).toHaveBeenCalledWith("black-cast",
      { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }, expect.objectContaining({ type: 1 }));
    expect(i.channel.parent.permissionOverwrites.edit).not.toHaveBeenCalled();
    expect(i.channel.members.add).not.toHaveBeenCalled();
    expect(session.phase).toBe("vip");
    await choose(i, "none");
    await choose(i, "1"); await choose(i, "2");
    expect(session.selection.quote).toMatchObject({ total: 200, vipPrice: 0, extensionPrice: 0 });
    i.customId = ticketId("confirm", session); i.isButton = () => true; i.isStringSelectMenu = () => false;
    await run(i);
    expect(m.settle).toHaveBeenCalledOnce();
    expect(i.channel.send).toHaveBeenCalledOnce();
    expect(i.channel.parent.permissionOverwrites.edit).not.toHaveBeenCalled();
  });
  it("uses the fixed cast for additional orders in a text ticket", async () => {
    const i = textTicketFixture(); i.customId = `${KP_TICKET_PREFIX}additional`;
    await run(i);
    expect(i.channel.permissionOverwrites.edit).toHaveBeenCalledWith("black-cast", expect.any(Object), expect.objectContaining({ type: 1 }));
    expect(session.selection.fixedCastId).toBe("black-cast");
    expect(session.phase).toBe("vip");
    expect(m.settle).not.toHaveBeenCalled();
  });
  it("does not charge when text-ticket member access cannot be granted", async () => {
    const i = textTicketFixture();
    i.channel.permissionOverwrites.edit.mockRejectedValue(new Error("Missing Permissions"));
    await choose(i, "black-cast");
    expect(session.phase).toBe("cast");
    expect(m.advance).not.toHaveBeenCalled();
    session.phase = "confirm"; session.selection = { castId: "black-cast" };
    i.customId = ticketId("confirm", session); i.isButton = () => true;
    await run(i);
    expect(m.settle).not.toHaveBeenCalled();
    expect(m.deliver).not.toHaveBeenCalled();
  });
  it("adds the cast immediately to the thread only before offering VIP", async () => {
    const i = fixture(); await choose(i, "black-cast");
    expect(i.guild.members.fetch).toHaveBeenCalledWith({ user: "black-cast", force: true });
    expect(i.channel.members.add).toHaveBeenCalledWith("black-cast");
    expect(i.channel.permissionOverwrites.edit).not.toHaveBeenCalled();
    expect(i.channel.parent.permissionOverwrites.edit).not.toHaveBeenCalled();
    expect(session.phase).toBe("vip");
    expect(i.editReply.mock.calls.at(-1)![0].content).toContain("チケットに追加しました");
    expect(m.settle).not.toHaveBeenCalled();
  });
  it("does not advance or charge when granting cast access fails and allows retry", async () => {
    const i = fixture();
    i.channel.members.add.mockRejectedValueOnce(new Error("Missing Permissions"));
    await choose(i, "black-cast");
    expect(session.phase).toBe("cast"); expect(m.advance).not.toHaveBeenCalled(); expect(m.settle).not.toHaveBeenCalled();
    expect(i.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("引き落としは行っていません") }));
    await choose(i, "black-cast");
    expect(session.phase).toBe("vip");
  });
  it("never grants access to an ineligible cast", async () => {
    const i = fixture(); await choose(i, "outsider");
    expect(i.channel.permissionOverwrites.edit).not.toHaveBeenCalled();
    expect(m.advance).not.toHaveBeenCalled(); expect(m.settle).not.toHaveBeenCalled();
  });
  it.each(["userId", "channelId", "guildId"] as const)("never grants from a mismatched order %s", async field => {
    const i = fixture(); session[field] = "another";
    await choose(i, "black-cast");
    expect(i.channel.permissionOverwrites.edit).not.toHaveBeenCalled();
    expect(m.advance).not.toHaveBeenCalled();
  });
  it("rechecks access before payment and does not charge if access cannot be restored", async () => {
    const i = fixture(); session.phase = "confirm"; session.selection = { castId: "black-cast" };
    i.channel.members.add.mockRejectedValue(new Error("Missing Permissions"));
    i.customId = ticketId("confirm", session); await run(i);
    expect(m.settle).not.toHaveBeenCalled(); expect(m.deliver).not.toHaveBeenCalled();
  });
  it("ensures the inherited cast has access on additional orders without changing it", async () => {
    const i = fixture(); i.customId = `${KP_TICKET_PREFIX}additional`; await run(i);
    expect(i.channel.members.add).toHaveBeenCalledWith("black-cast");
    expect(i.channel.parent.permissionOverwrites.edit).not.toHaveBeenCalled();
    expect(session.selection.fixedCastId).toBe("black-cast");
    expect(m.settle).not.toHaveBeenCalled();
  });
});

describe("KP ticket price administration", () => {
  function panelAccessFixture(roleNames: string[], admin = false) {
    const roles = new Map(["黒真珠", "白真珠", "夜鴉", "黒兵", "夜鴉見習い"].map(name => [name, { id: name, name }]));
    const member = { permissions: { has: () => admin }, roles: { cache: new Map(roleNames.map(name => [name, roles.get(name)])) } };
    return {
      guildId: "guild", user: { id: "caller" },
      guild: { id: "guild", roles: { fetch: vi.fn().mockResolvedValue(roles) },
        members: { me: { id: "bot" }, fetch: vi.fn().mockResolvedValue(member) } },
      // Stale interaction permissions must not bypass the fresh member check.
      memberPermissions: { has: () => true },
      channel: { id: "ticket", type: 12, isThread: () => true,
        permissionsFor: () => ({ has: () => true }), send: vi.fn().mockResolvedValue({ id: "panel" }) },
      options: { getSubcommand: () => "ticket-panel", getRole: () => null },
      reply: vi.fn(), deferReply: vi.fn(), editReply: vi.fn(),
    };
  }
  it.each([
    { roles: ["夜鴉"], admin: false }, { roles: ["黒兵"], admin: false }, { roles: [], admin: true },
  ])("lets approved staff privately read customers without a ticket panel: %j", async ({ roles, admin }) => {
    const interaction = panelAccessFixture(roles, admin);
    interaction.options.getSubcommand = () => "customers";
    Object.assign(interaction.options, { getUser: () => ({ id: "buyer" }), getInteger: () => 1 });
    await executeKpTicketCommand(interaction as unknown as ChatInputCommandInteraction);
    expect(m.paidOrders).toHaveBeenCalledWith("guild", undefined, expect.objectContaining({
      start: expect.any(Date), end: expect.any(Date),
    }));
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.channel.send).not.toHaveBeenCalled();
    expect(m.settle).not.toHaveBeenCalled();
    expect(JSON.stringify(interaction.editReply.mock.calls)).toContain("顧客の利用履歴");
  });
  it("does not read customer data after staff role revocation despite stale permissions", async () => {
    const interaction = panelAccessFixture([]);
    interaction.options.getSubcommand = () => "customers";
    await executeKpTicketCommand(interaction as unknown as ChatInputCommandInteraction);
    expect(m.paidOrders).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("夜鴉・黒兵"));
  });
  it.each([
    { roles: ["夜鴉"], admin: false }, { roles: ["黒兵"], admin: false },
    { roles: ["夜鴉", "黒兵"], admin: false }, { roles: [], admin: true },
  ])("allows only approved panel installers: %j", async ({ roles, admin }) => {
    const interaction = panelAccessFixture(roles, admin);
    await executeKpTicketCommand(interaction as unknown as ChatInputCommandInteraction);
    expect(interaction.guild.members.fetch).toHaveBeenCalledWith({ user: "caller", force: true });
    expect(interaction.deferReply.mock.invocationCallOrder[0]).toBeLessThan(interaction.guild.members.fetch.mock.invocationCallOrder[0]!);
    expect(interaction.channel.send).toHaveBeenCalledOnce();
    expect(m.register).toHaveBeenCalledWith("panel", "guild", "ticket");
    expect(m.configure).toHaveBeenCalledWith("guild", { castRoleIds: ["黒真珠", "白真珠"] });
  });
  it("installs a panel directly in the Ticket Tool text channel", async () => {
    const interaction = panelAccessFixture(["夜鴉"]);
    interaction.channel.isThread = () => false;
    interaction.channel.type = 0;
    await executeKpTicketCommand(interaction as unknown as ChatInputCommandInteraction);
    expect(interaction.channel.send).toHaveBeenCalledOnce();
    expect(m.register).toHaveBeenCalledWith("panel", "guild", "ticket");
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("このチケットにのみ追加"));
  });
  it.each([{ roles: [] }, { roles: ["黒真珠"] }, { roles: ["白真珠"] }, { roles: ["夜鴉見習い"] }])("blocks unapproved or removed roles despite stale permissions: %j", async ({ roles }) => {
    const interaction = panelAccessFixture(roles);
    await executeKpTicketCommand(interaction as unknown as ChatInputCommandInteraction);
    expect(interaction.channel.send).not.toHaveBeenCalled();
    expect(m.configure).not.toHaveBeenCalled();
    expect(m.register).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("夜鴉・黒兵"));
  });
  it("fails closed when fresh membership cannot be verified", async () => {
    const interaction = panelAccessFixture(["夜鴉"]);
    interaction.guild.members.fetch.mockRejectedValue(new Error("Discord unavailable"));
    await executeKpTicketCommand(interaction as unknown as ChatInputCommandInteraction);
    expect(interaction.channel.send).not.toHaveBeenCalled();
    expect(m.configure).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("操作権限を確認できません"));
  });
  it("does not grant price administration to a ticket installer", async () => {
    const interaction = panelAccessFixture(["黒兵"]);
    interaction.memberPermissions.has = () => false;
    interaction.options.getSubcommand = () => "ticket-prices";
    await executeKpTicketCommand(interaction as unknown as ChatInputCommandInteraction);
    expect(m.configure).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("サーバー管理権限"));
  });
  it("installs a ticket panel without deciding prices and preserves unset fees", async () => {
    const roleMap = new Map([
      ["black", { id: "black", name: "黒真珠" }], ["white", { id: "white", name: "白真珠" }],
    ]);
    const channel = { id: "ticket", type: 12, isThread: () => true,
      permissionsFor: () => ({ has: () => true }), send: vi.fn().mockResolvedValue({ id: "panel" }) };
    const interaction = {
      guildId: "guild", user: { id: "admin" },
      guild: { id: "guild", roles: { fetch: vi.fn().mockResolvedValue(roleMap) },
        members: { me: { id: "bot" }, fetch: vi.fn().mockResolvedValue({ permissions: { has: () => true } }) } },
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
      expect.objectContaining({ label: "明細を集計", custom_id: `${KP_TICKET_PREFIX}statement` }),
      expect.objectContaining({ label: "全チケットを集計", custom_id: `${KP_TICKET_PREFIX}all-statement` }),
      expect.objectContaining({ label: "凪への送金履歴", custom_id: `${KP_TICKET_PREFIX}nagi-transfers` }),
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
    expect(m.configure).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("料金は固定"));
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
    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("100,000"));
  });
});
