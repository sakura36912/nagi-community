import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ButtonInteraction, ChatInputCommandInteraction, StringSelectMenuInteraction } from "discord.js";
import type { KpTicketSession } from "@workspace/db";

const m = vi.hoisted(() => ({
  settings: vi.fn(), configure: vi.fn(), getSession: vi.fn(), create: vi.fn(), advance: vi.fn(),
  panel: vi.fn(), register: vi.fn(), settle: vi.fn(), deliver: vi.fn(), paidOrders: vi.fn(), createAdditional: vi.fn(),
  guildSettings: vi.fn(), getItem: vi.fn(), listItems: vi.fn(), error: vi.fn(),
}));
vi.mock("@workspace/db", async importOriginal => ({
  ...await importOriginal<typeof import("@workspace/db")>(),
  getKpTicketSettings: m.settings, configureKpTicket: m.configure,
  getKpTicketSession: m.getSession, createKpTicketSession: m.create, advanceKpTicketSession: m.advance,
  isKpTicketPanel: m.panel, registerKpTicketPanel: m.register, settleKpTicket: m.settle, deliverKpTicketLog: m.deliver,
  listPaidKpTicketOrders: m.paidOrders,
  createAdditionalKpTicketSession: m.createAdditional,
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
    channel: { id: "ticket", guildId: "guild", type: 0, isThread: () => false, permissionsFor: () => ({ has: () => true }),
      permissionOverwrites: { edit: vi.fn().mockResolvedValue(undefined) },
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
  m.createAdditional.mockImplementation(async () => {
    session = { ...session, phase: "vip", selection: { castId: "black-cast", fixedCastId: "black-cast" } };
    return session;
  });
  m.getSession.mockImplementation(async () => session);
  m.advance.mockImplementation(async (_previous, phase, selection) => {
    session = { ...session, phase, selection, version: session.version + 1 };
    return session;
  });
  m.panel.mockResolvedValue(true);
  m.paidOrders.mockResolvedValue([]);
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
    expect(m.paidOrders).toHaveBeenCalledWith("guild");
    expect(i.editReply.mock.calls[0]![0].embeds[0].toJSON().title).toContain("全チケット");
    expect(i.channel.send).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled(); expect(m.advance).not.toHaveBeenCalled();
    expect(m.settle).not.toHaveBeenCalled();
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
  it("publishes the ticket statement without creating, advancing or charging an order, including on repeat clicks", async () => {
    const i = fixture(); i.customId = `${KP_TICKET_PREFIX}statement`;
    for (let n = 0; n < 2; n++) await run(i);
    expect(m.paidOrders).toHaveBeenCalledWith("guild", "ticket");
    expect(i.deferReply).toHaveBeenCalledWith();
    expect(i.editReply.mock.calls[0]![0].embeds[0].toJSON().description).toContain("支払い済みの注文がありません");
    expect(m.create).not.toHaveBeenCalled();
    expect(m.advance).not.toHaveBeenCalled();
    expect(m.settle).not.toHaveBeenCalled();
  });
  it("does not disclose statements from unregistered panels", async () => {
    const i = fixture(); i.customId = `${KP_TICKET_PREFIX}statement`;
    m.panel.mockResolvedValue(false);
    await run(i);
    expect(m.paidOrders).not.toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("未登録") }));
  });
  it("reports a statement query failure without claiming an empty or successful total", async () => {
    const i = fixture(); i.customId = `${KP_TICKET_PREFIX}statement`;
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
    await choose(i, "no");
    await choose(i, "no");
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
    expect(m.createAdditional).not.toHaveBeenCalled();
    expect(m.settle).not.toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("未登録") }));
  });
  it("includes explicitly selected VIP and extension in an additional drink payment", async () => {
    const i = fixture(); i.customId = `${KP_TICKET_PREFIX}additional`; await run(i);
    await choose(i, "yes"); await choose(i, "yes");
    await choose(i, "1"); await choose(i, "2");
    expect(session.selection).toMatchObject({ castId: "black-cast", fixedCastId: "black-cast",
      vip: true, extension: true, quote: { total: 900 } });
    expect(m.settle).not.toHaveBeenCalled();
    i.customId = ticketId("confirm", session); i.isButton = () => true; i.isStringSelectMenu = () => false;
    await run(i);
    expect(m.settle).toHaveBeenCalledOnce();
  });
  it("adds VIP and extension without drinks, including when no drink catalogue exists", async () => {
    m.listItems.mockResolvedValue([]);
    const i = fixture(); i.customId = `${KP_TICKET_PREFIX}additional`; await run(i);
    await choose(i, "yes"); await choose(i, "yes");
    const reply = i.editReply.mock.calls.at(-1)![0];
    expect(reply.components.at(-1).toJSON().components[0].label).toContain("ドリンクなし");
    i.customId = ticketId("extras-only", session); i.isButton = () => true; i.isStringSelectMenu = () => false;
    await run(i);
    expect(session.phase).toBe("confirm");
    expect(session.selection.quote).toMatchObject({ itemId: null, quantity: 0, total: 700 });
    expect(m.settle).not.toHaveBeenCalled();
    i.customId = ticketId("confirm", session); await run(i);
    expect(m.settle).toHaveBeenCalledOnce();
  });
  it("keeps the inherited cast on reset and rejects forged cast selection", async () => {
    const i = fixture(); i.customId = `${KP_TICKET_PREFIX}additional`; await run(i);
    await choose(i, "no"); await choose(i, "no");
    i.customId = ticketId("reset", session); i.isButton = () => true; i.isStringSelectMenu = () => false;
    await run(i);
    expect(session.phase).toBe("vip");
    expect(session.selection).toEqual({ castId: "black-cast", fixedCastId: "black-cast" });
    i.customId = ticketId("cast", session); i.values = ["white-cast"];
    i.isButton = () => false; i.isStringSelectMenu = () => true;
    await run(i);
    expect(session.selection.castId).toBe("black-cast");
    expect(m.settle).not.toHaveBeenCalled();
  });
  it("blocks additional VIP with an unset fee without advancing or charging", async () => {
    settings.vipPrice = null;
    const i = fixture(); i.customId = `${KP_TICKET_PREFIX}additional`; await run(i);
    await choose(i, "yes");
    expect(session.phase).toBe("vip");
    expect(i.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("VIP料金が未設定") }));
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

describe("KP ticket cast access integration", () => {
  it("adds the cast immediately on selection, before VIP choices or payment", async () => {
    const i = fixture(); await choose(i, "black-cast");
    expect(i.guild.members.fetch).toHaveBeenCalledWith({ user: "black-cast", force: true });
    expect(i.channel.permissionOverwrites.edit).toHaveBeenCalledWith("black-cast",
      { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }, expect.any(Object));
    expect(session.phase).toBe("vip");
    expect(i.editReply.mock.calls.at(-1)![0].content).toContain("チケットに追加しました");
    expect(m.settle).not.toHaveBeenCalled();
  });
  it("does not advance or charge when granting cast access fails and allows retry", async () => {
    const i = fixture();
    i.channel.permissionOverwrites.edit.mockRejectedValueOnce(new Error("Missing Permissions"));
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
    i.channel.permissionOverwrites.edit.mockRejectedValue(new Error("Missing Permissions"));
    i.customId = ticketId("confirm", session); await run(i);
    expect(m.settle).not.toHaveBeenCalled(); expect(m.deliver).not.toHaveBeenCalled();
  });
  it("ensures the inherited cast has access on additional orders without changing it", async () => {
    const i = fixture(); i.customId = `${KP_TICKET_PREFIX}additional`; await run(i);
    expect(i.channel.permissionOverwrites.edit).toHaveBeenCalledWith("black-cast", expect.any(Object), expect.any(Object));
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
      channel: { id: "ticket", type: 0, isThread: () => false,
        permissionsFor: () => ({ has: () => true }), send: vi.fn().mockResolvedValue({ id: "panel" }) },
      options: { getSubcommand: () => "ticket-panel", getRole: () => null },
      reply: vi.fn(), deferReply: vi.fn(), editReply: vi.fn(),
    };
  }
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
    const channel = { id: "ticket", type: 0, isThread: () => false,
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
