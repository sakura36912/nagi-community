import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType, OverwriteType, PermissionFlagsBits as P, type ButtonInteraction, type ModalSubmitInteraction, type VoiceState } from "discord.js";
import type { KpTicketSession } from "@workspace/db";

const m = vi.hoisted(() => ({ list: vi.fn(), deliver: vi.fn(), settings: vi.fn(), error: vi.fn() }));
vi.mock("@workspace/db", async original => ({
  ...await original<typeof import("@workspace/db")>(),
  listKpVipOrders: m.list, deliverKpVipRoom: m.deliver, getKpTicketSettings: m.settings,
}));
vi.mock("../lib/logger", () => ({ logger: { error: m.error } }));
import {
  handleKpVipHubJoin, handleKpVipHubLeave, handleKpVipControl,
  kpVipOverwrites, kpVipPanel, KP_VIP_PREFIX, validateKpVipSource,
} from "../lib/kpVipVc";
import { KP_VIP_HUB_ID } from "@workspace/db";

let order: KpTicketSession;
beforeEach(() => {
  vi.resetAllMocks();
  order = { id: "order", guildId: "guild", channelId: "ticket", userId: "buyer", phase: "paid", version: 2,
    selection: { serviceVersion: 2, vip: true, vipTier: "shared", castId: "cast", guestId: "guest" },
    expiresAt: new Date(0), createdAt: new Date(), paidAt: new Date(), logMessageId: "receipt" };
  m.list.mockImplementation(async (guild, member, room) => guild === "guild"
    && (!member || ["buyer", "cast"].includes(member))
    && (!room || room === order.selection.vipRoomId) ? [order] : []);
  m.deliver.mockImplementation(async (_id, _guild, use) => {
    const room = await use(order);
    order.selection.vipRoomId = room;
    return room;
  });
  m.settings.mockResolvedValue({ castRoleIds: ["cast-role"] });
});

function fixture(user = "buyer") {
  const sourceRows = [{ id: "guild", type: OverwriteType.Role, allow: { bitfield: P.ViewChannel | P.Connect }, deny: { bitfield: 0n } }];
  const room = {
    id: "room", type: ChannelType.GuildVoice, members: new Map(),
    send: vi.fn().mockResolvedValue({ id: "panel" }), delete: vi.fn().mockResolvedValue(undefined),
    setName: vi.fn().mockResolvedValue(undefined),
    permissionOverwrites: { cache: new Map(sourceRows.map(r => [r.id, r])), set: vi.fn().mockResolvedValue(undefined) },
  };
  const hub = {
    id: KP_VIP_HUB_ID, type: ChannelType.GuildVoice, parentId: "category",
    parent: { permissionsFor: () => ({ has: () => true }) },
    permissionOverwrites: { cache: new Map(sourceRows.map(r => [r.id, r])) },
    permissionsFor: vi.fn(() => ({ has: (): boolean => true })),
  };
  const channels = new Map<string, unknown>([[KP_VIP_HUB_ID, hub], ["ticket", { id: "ticket" }]]);
  const member = {
    id: user, displayName: user, user: { bot: false },
    permissions: { has: () => false },
    roles: { cache: new Map([["cast-role", {}]]) }, send: vi.fn().mockResolvedValue(undefined),
    voice: { channelId: KP_VIP_HUB_ID, setChannel: vi.fn().mockResolvedValue(undefined) },
  };
  const guild = {
    id: "guild",
    channels: {
      fetch: vi.fn(async id => channels.get(id) ?? null),
      create: vi.fn(async (_options: unknown) => { channels.set("room", room); return room; }),
    },
    members: {
      fetchMe: vi.fn().mockResolvedValue({ id: "bot" }),
      fetch: vi.fn(async (arg: { user: string }) => ({ ...member, id: arg.user })),
    },
  };
  const state = { channelId: KP_VIP_HUB_ID, guild, member };
  return { state, guild, channels, hub, room, member };
}
function control(f: ReturnType<typeof fixture>, action: string, user = "buyer") {
  return {
    customId: `${KP_VIP_PREFIX}${action}:room`, guildId: "guild", guild: f.guild, user: { id: user },
    isButton: () => true, isModalSubmit: () => false,
    reply: vi.fn(), deferReply: vi.fn(), editReply: vi.fn(), showModal: vi.fn(),
    fields: { getTextInputValue: () => "新しいVIP部屋" },
  };
}

describe("VIP privacy overwrites", () => {
  const viewConnect = P.ViewChannel | P.Connect;
  it("removes role AND member visibility bypasses in private mode without changing unrelated bits", () => {
    const rows = kpVipOverwrites([
      { id: "guild", type: OverwriteType.Role, allow: { bitfield: viewConnect }, deny: { bitfield: 0n } },
      { id: "cast-role", type: OverwriteType.Role, allow: { bitfield: viewConnect | P.UseApplicationCommands }, deny: { bitfield: 0n } },
      { id: "outsider", type: OverwriteType.Member, allow: { bitfield: viewConnect }, deny: { bitfield: 0n } },
    ], "guild", ["buyer", "cast", "guest", "bot"], false);
    for (const row of rows.filter(r => typeof r.id === "string" && ["guild", "cast-role", "outsider"].includes(r.id))) {
      expect(BigInt(row.allow as bigint) & viewConnect).toBe(0n);
      expect(BigInt(row.deny as bigint) & viewConnect).toBe(viewConnect);
    }
    expect(BigInt(rows.find(r => r.id === "cast-role")!.allow as bigint) & P.UseApplicationCommands).toBe(P.UseApplicationCommands);
    for (const id of ["buyer", "cast", "guest", "bot"]) {
      expect(BigInt(rows.find(r => r.id === id)!.allow as bigint) & viewConnect).toBe(viewConnect);
      expect(BigInt(rows.find(r => r.id === id)!.deny as bigint) & viewConnect).toBe(0n);
    }
  });
  it("switches back to public without leaving role-level connect denies", () => {
    const rows = kpVipOverwrites([
      { id: "guild", type: OverwriteType.Role, allow: { bitfield: 0n }, deny: { bitfield: viewConnect } },
      { id: "normal", type: OverwriteType.Role, allow: { bitfield: 0n }, deny: { bitfield: viewConnect | P.Stream } },
      { id: "member", type: OverwriteType.Member, allow: { bitfield: 0n }, deny: { bitfield: viewConnect } },
    ], "guild", ["buyer"], true);
    expect(BigInt(rows[0]!.allow as bigint) & viewConnect).toBe(viewConnect);
    expect(BigInt(rows[1]!.deny as bigint) & viewConnect).toBe(0n);
    expect(BigInt(rows[1]!.deny as bigint) & P.Stream).toBe(P.Stream);
    expect(BigInt(rows[2]!.deny as bigint) & viewConnect).toBe(0n);
  });
});

describe("VIP transfer and persisted room recovery", () => {
  it.each(["buyer", "cast"])("creates a private shared room when the paid %s enters", async user => {
    const f = fixture(user);
    expect(await handleKpVipHubJoin(f.state as unknown as VoiceState)).toBe(true);
    expect(f.guild.channels.create).toHaveBeenCalledWith(expect.objectContaining({
      type: ChannelType.GuildVoice, parent: "category", userLimit: 3,
    }));
    expect(f.member.voice.setChannel).toHaveBeenCalledWith("room");
    expect(order.selection.vipRoomId).toBe("room");
    expect(f.room.send).toHaveBeenCalledOnce();
    const overwrites = f.guild.channels.create.mock.calls[0]![0] as unknown as { permissionOverwrites: { id: string }[] };
    expect(overwrites.permissionOverwrites.some(row => row.id === "guest")).toBe(false);
    expect(f.hub.permissionOverwrites.cache).toHaveLength(1);
  });
  it("does not transfer a legacy companion or grant access based on the old ID", async () => {
    const f = fixture("guest");
    await handleKpVipHubJoin(f.state as unknown as VoiceState);
    expect(f.member.voice.setChannel).not.toHaveBeenCalled();
    expect(f.guild.channels.create).not.toHaveBeenCalled();
  });
  it("uses two slots for solo VIP and reuses an existing room after restart", async () => {
    const f = fixture(); order.selection.vipTier = "solo"; delete order.selection.guestId;
    await handleKpVipHubJoin(f.state as unknown as VoiceState);
    expect(f.guild.channels.create).toHaveBeenCalledWith(expect.objectContaining({ userLimit: 2 }));
    await handleKpVipHubJoin(f.state as unknown as VoiceState);
    expect(f.guild.channels.create).toHaveBeenCalledOnce();
    expect(f.member.voice.setChannel).toHaveBeenCalledTimes(2);
  });
  it("does not affect unrelated Hub rooms", async () => {
    const f = fixture(); f.state.channelId = "ordinary-hub";
    expect(await handleKpVipHubJoin(f.state as unknown as VoiceState)).toBe(false);
    expect(m.list).not.toHaveBeenCalled(); expect(f.guild.channels.create).not.toHaveBeenCalled();
  });
  it.each(["unpaid", "deleted-ticket", "lost-cast-role", "missing-permission"])("does not create a room for %s", async reason => {
    const f = fixture();
    if (reason === "unpaid") m.list.mockResolvedValue([]);
    if (reason === "deleted-ticket") f.channels.delete("ticket");
    if (reason === "lost-cast-role") m.settings.mockResolvedValue({ castRoleIds: ["other"] });
    if (reason === "missing-permission") f.hub.permissionsFor.mockReturnValue({ has: () => false });
    await handleKpVipHubJoin(f.state as unknown as VoiceState);
    expect(f.guild.channels.create).not.toHaveBeenCalled();
    expect(f.member.voice.setChannel).not.toHaveBeenCalled();
    expect(f.member.send).toHaveBeenCalledOnce();
  });
  it("cleans an incomplete room when panel delivery or persistence fails", async () => {
    const f = fixture();
    m.deliver.mockImplementation(async (_id, _guild, use) => { await use(order); throw new Error("DB commit failed"); });
    await handleKpVipHubJoin(f.state as unknown as VoiceState);
    expect(f.room.delete).toHaveBeenCalledOnce();
    expect(f.member.voice.setChannel).not.toHaveBeenCalled();
  });
  it("keeps a committed room on a move failure so retry needs no new purchase", async () => {
    const f = fixture(); f.member.voice.setChannel.mockRejectedValueOnce(new Error("move failed"));
    await handleKpVipHubJoin(f.state as unknown as VoiceState);
    expect(f.room.delete).not.toHaveBeenCalled(); expect(order.selection.vipRoomId).toBe("room");
    await handleKpVipHubJoin(f.state as unknown as VoiceState);
    expect(f.guild.channels.create).toHaveBeenCalledOnce();
  });
  it("fails preflight before payment if the source VC is missing", async () => {
    const f = fixture(); f.channels.delete(KP_VIP_HUB_ID);
    await expect(validateKpVipSource(f.guild as never)).rejects.toThrow("転送元VC");
  });
});

describe("VIP controls and cleanup", () => {
  it("renders all three requested controls", () => {
    const panel = kpVipPanel(order, "room");
    expect(panel.components[0]!.toJSON().components.map(c => "label" in c ? c.label : "")).toEqual(["非公開VC", "公開VC", "VC名変更"]);
  });
  it.each(["public", "private"])("lets only the purchaser set %s and never edits the source/category", async action => {
    const f = fixture(); f.channels.set("room", f.room); order.selection.vipRoomId = "room";
    await handleKpVipControl(control(f, action, "guest") as unknown as ButtonInteraction);
    expect(f.room.permissionOverwrites.set).not.toHaveBeenCalled();
    const i = control(f, action);
    await handleKpVipControl(i as unknown as ButtonInteraction);
    expect(f.room.permissionOverwrites.set).toHaveBeenCalledOnce();
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining(action === "public" ? "公開しました" : "非公開にしました"));
    expect(f.hub.permissionOverwrites.cache).toHaveLength(1);
  });
  it("checks the owner again when a rename modal is submitted", async () => {
    const f = fixture(); f.channels.set("room", f.room); order.selection.vipRoomId = "room";
    const i = control(f, "name"); i.isButton = () => false; i.isModalSubmit = () => true;
    await handleKpVipControl(i as unknown as ModalSubmitInteraction);
    expect(f.room.setName).toHaveBeenCalledWith("新しいVIP部屋");
    i.user.id = "cast";
    await handleKpVipControl(i as unknown as ModalSubmitInteraction);
    expect(f.room.setName).toHaveBeenCalledOnce();
  });
  it("rejects controls after the ticket is deleted", async () => {
    const f = fixture(); f.channels.set("room", f.room); f.channels.delete("ticket"); order.selection.vipRoomId = "room";
    await handleKpVipControl(control(f, "public") as unknown as ButtonInteraction);
    expect(f.room.permissionOverwrites.set).not.toHaveBeenCalled();
  });
  it("removes outsiders when going private but keeps the purchased participants and administrators", async () => {
    const f = fixture(); f.channels.set("room", f.room); order.selection.vipRoomId = "room";
    const outsider = { id: "outsider", permissions: { has: () => false }, voice: { disconnect: vi.fn() } };
    const admin = { id: "admin", permissions: { has: () => true }, voice: { disconnect: vi.fn() } };
    f.room.members.set("outsider", outsider); f.room.members.set("admin", admin);
    f.room.members.set("buyer", { id: "buyer" });
    await handleKpVipControl(control(f, "private") as unknown as ButtonInteraction);
    expect(outsider.voice.disconnect).toHaveBeenCalledOnce();
    expect(admin.voice.disconnect).not.toHaveBeenCalled();
  });
  it("deletes only an empty purchased VIP room, not ordinary VC", async () => {
    const f = fixture(); f.channels.set("room", f.room); order.selection.vipRoomId = "room";
    f.state.channelId = "room";
    f.room.members.set("buyer", {});
    expect(await handleKpVipHubLeave(f.state as unknown as VoiceState)).toBe(true);
    expect(f.room.delete).not.toHaveBeenCalled();
    f.room.members.clear();
    await handleKpVipHubLeave(f.state as unknown as VoiceState);
    expect(f.room.delete).toHaveBeenCalledOnce();
    f.state.channelId = "normal-room";
    expect(await handleKpVipHubLeave(f.state as unknown as VoiceState)).toBe(false);
  });
});
