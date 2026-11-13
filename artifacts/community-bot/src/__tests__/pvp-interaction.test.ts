import { beforeEach, describe, expect, it, vi } from "vitest";
import { Collection, PermissionFlagsBits, type ChatInputCommandInteraction, type ButtonInteraction } from "discord.js";
const m = vi.hoisted(() => ({
  access: vi.fn(), create: vi.fn(), get: vi.fn(), action: vi.fn(), advance: vi.fn(), run: vi.fn(), setBounty: vi.fn(),
}));
vi.mock("@workspace/db", async original => ({
  ...await original<typeof import("@workspace/db")>(),
  createPvpDuel: m.create, getPvpDuel: m.get, performPvpAction: m.action, advancePvpGuild: m.advance,
  setPvpBounty: m.setBounty,
}));
vi.mock("../commands/forge", () => ({ requireForgeAccess: m.access }));
vi.mock("../lib/logger", () => ({ logger: { info: vi.fn() } }));
vi.mock("../lib/rpgCards", async original => ({
  ...await original<typeof import("../lib/rpgCards")>(), runRpgCards: m.run,
}));
vi.mock("../lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));
import { executePvpCommand, handlePvpButton, pvpCommands } from "../commands/pvp";
import { rpgCardMessage } from "../lib/rpgCards";
import { syncPvpCommandRegistration } from "../lib/pvpCommandRegistration";
it("adds an owner-bound repeat-upgrade control to public forge cards", () => {
  const message = rpgCardMessage({ title: "強化成功", description: "Lv2", color: 0x2ecc71, forgeOwnerId: "owner" });
  expect(message.components[0]!.toJSON().components[0]).toMatchObject({
    custom_id: "forge:upgrade:owner", label: "次の強化（本人専用）",
  });
});
import { pvpPublicCard, type PvpDuel } from "@workspace/db";
function fixture(sub = "募集") {
  const flags = { crew: true, bot: false, send: true, admin: false };
  const i = {
    flags, id: "interaction", guildId: "guild", user: { id: "host" }, client: {},
    memberPermissions: { has: () => flags.admin },
    customId: "pvp:attack:duel",
    guild: { id: "guild", roles: { fetch: vi.fn(async () => new Collection([["crew", { id: "crew", name: "本船員" }]])) },
      members: { me: {}, fetch: vi.fn(async () => ({ user: { bot: flags.bot }, roles: { cache: { has: () => flags.crew } } })) } },
    channel: { id: "channel", isDMBased: () => false, isTextBased: () => true, isThread: () => false,
      send: vi.fn(), permissionsFor: () => ({ has: (_permission: unknown) => flags.send }) },
    options: { getSubcommand: () => sub, getUser: () => ({ id: "opponent" }), getInteger: (key: string) => key === "懸賞額" ? 1000 : key === "制限分" ? 30 : null,
      getBoolean: () => true },
    deferReply: vi.fn().mockResolvedValue(undefined), editReply: vi.fn().mockResolvedValue(undefined),
  };
  return i;
}
const duel: PvpDuel = {
  id: "duel", guildId: "guild", channelId: "channel", hostId: "host", opponentId: "opponent",
  prize: 0, createdAt: new Date(), expiresAt: new Date(Date.now() + 60000), status: "active",
  state: { bounties: { challenger: 300, target: 1000 }, healCost: 100, durationMinutes: 30, players: [], lines: ["対戦開始"] },
};
beforeEach(() => {
  vi.clearAllMocks();
  m.create.mockResolvedValue(structuredClone(duel));
  m.access.mockResolvedValue("guild"); m.get.mockResolvedValue(structuredClone(duel));
  m.action.mockResolvedValue({ duel, repeated: false }); m.run.mockResolvedValue(undefined);
});
describe("PvP commands, public cards and participant controls", () => {
  it("serializes the commands without granting administrator defaults", () => {
    const data = pvpCommands[0]!.data.toJSON();
    expect(data.name).toBe("pvp");
    expect(data.options?.map(o => o.name)).toEqual(["募集", "懸賞金設定", "情報", "攻撃", "回復", "取消", "降参"]);
    expect(data.default_member_permissions).toBeUndefined();
    expect(data.dm_permission).toBe(false);
  });
  it("edits the existing PvP command instead of creating a duplicate", async () => {
    const saved = new Map();
    const manager = {
      fetch: vi.fn(async (key: unknown) => typeof key === "string" ? saved.get(key)
        : new Collection([["existing", { id: "existing", name: "pvp", type: 1 }]])),
      edit: vi.fn(async (id, definition) => { saved.set(id, definition); return { id }; }),
      create: vi.fn(async definition => { saved.set(definition.name, definition); return { id: definition.name }; }),
    };
    await syncPvpCommandRegistration({ application: { commands: manager } } as never);
    expect(manager.edit).toHaveBeenCalledTimes(1);
    expect(manager.create).not.toHaveBeenCalled();
    expect(manager.fetch).toHaveBeenCalledWith("existing", { force: true });
  });
  it("starts a named-opponent invitation without a wager option or balance deduction", async () => {
    const i = fixture();
    await executePvpCommand(i as unknown as ChatInputCommandInteraction);
    expect(m.create).toHaveBeenCalledWith({ id: i.id, guildId: "guild", channelId: "channel", hostId: "host",
      opponentId: "opponent", durationMinutes: 30 });
    expect(m.access).toHaveBeenCalled();
    expect(i.guild.members.fetch).toHaveBeenCalledWith({ user: "opponent", force: true });
    const data = pvpCommands[0]!.data.toJSON();
    const invite = data.options!.find(o => o.name === "募集")!;
    expect((invite as { options?: { name: string }[] }).options?.map(o => o.name)).toEqual(["相手", "制限分"]);
    expect(JSON.stringify(i.editReply.mock.calls)).toContain("差し引きはありません");
  });
  it("allows only administrators to set a main crew member's fixed bounty", async () => {
    const ordinary = fixture("懸賞金設定");
    await executePvpCommand(ordinary as unknown as ChatInputCommandInteraction);
    expect(m.setBounty).not.toHaveBeenCalled();
    const admin = fixture("懸賞金設定"); admin.flags.admin = true;
    await executePvpCommand(admin as unknown as ChatInputCommandInteraction);
    expect(m.setBounty).toHaveBeenCalledWith("guild", "opponent", 1000, "host");
    expect(JSON.stringify(admin.editReply.mock.calls)).toContain("$1,000");
  });
  it("rejects non-crew opponents, bots, and missing public embed permissions before money changes", async () => {
    for (const flag of ["crew", "bot", "send"] as const) {
      const i = fixture(); i.flags[flag] = flag === "bot";
      await executePvpCommand(i as unknown as ChatInputCommandInteraction);
      expect(m.create).not.toHaveBeenCalled();
    }
  });
  it("rechecks the host role when accepting and does not start if it was removed", async () => {
    const i = fixture(); i.user.id = "opponent"; i.customId = "pvp:accept:duel"; i.flags.crew = false;
    await handlePvpButton(i as unknown as ButtonInteraction);
    expect(m.action).not.toHaveBeenCalled();
    expect(JSON.stringify(i.editReply.mock.calls)).toContain("本船員");
  });
  it("lets a former crew member cancel rather than trapping the escrow", async () => {
    const i = fixture("取消");
    await executePvpCommand(i as unknown as ChatInputCommandInteraction);
    expect(m.access).not.toHaveBeenCalled();
    expect(m.action).toHaveBeenCalledWith(i.id, "guild", "host", "duel", "cancel");
  });
  it("requires confirmation before surrendering via public buttons", async () => {
    const i = fixture(); i.customId = "pvp:surrender-confirm:duel";
    await handlePvpButton(i as unknown as ButtonInteraction);
    expect(m.action).not.toHaveBeenCalled();
    expect(JSON.stringify(i.editReply.mock.calls)).toContain("降参を確定");
    i.customId = "pvp:surrender:duel";
    await handlePvpButton(i as unknown as ButtonInteraction);
    expect(m.action).toHaveBeenCalledWith(i.id, "guild", "host", "duel", "surrender");
  });
  it("renders public pending/active controls and removes them on terminal cards without internal stats", () => {
    for (const status of ["pending", "active", "finished"]) {
      const card = pvpPublicCard({ ...duel, status });
      const message = rpgCardMessage(card);
      expect(message.allowedMentions.parse).toEqual([]);
      expect(message.components).toHaveLength(status === "finished" ? 0 : 1);
      const json = message.embeds[0]!.toJSON();
      expect(JSON.stringify(json)).not.toMatch(/内部攻撃力|内部防御力|criticalPercent|roleMultiplier/);
      expect(json.description).toContain("$300");
      expect(json.description).toContain("$1,000");
      expect(json.description).toContain("新規付与");
    }
  });
  it("keeps old escrow duel cards legible while new invitations use fixed bounties", () => {
    const legacy = { ...duel, prize: 1000, state: { ...duel.state, bounties: undefined } } as PvpDuel;
    const description = pvpPublicCard(legacy).description;
    expect(description).toContain("旧方式");
    expect(description).toContain("預け入れ済み");
  });
  it("checks public card permissions using EmbedLinks and the correct send permission", async () => {
    const i = fixture(); const has = vi.fn(() => true); i.channel.permissionsFor = () => ({ has });
    await executePvpCommand(i as unknown as ChatInputCommandInteraction);
    expect(has).toHaveBeenCalledWith([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.SendMessages]);
  });
});
