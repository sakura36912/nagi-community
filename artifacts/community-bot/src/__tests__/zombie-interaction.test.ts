import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType, Collection, MessageFlags, type ChatInputCommandInteraction, type ButtonInteraction } from "discord.js";
const m = vi.hoisted(() => ({
  get: vi.fn(), config: vi.fn(), update: vi.fn(), start: vi.fn(), role: vi.fn(), begin: vi.fn(),
  end: vi.fn(), request: vi.fn(), decide: vi.fn(), failures: vi.fn(), observe: vi.fn(), flush: vi.fn(),
  privacy: vi.fn(), warn: vi.fn(), setReward: vi.fn(), voices: vi.fn(),
}));
vi.mock("@workspace/db", async original => ({
  ...await original<typeof import("@workspace/db")>(),
  getZombieGame: m.get, getZombieConfig: m.config, updateZombieConfig: m.update,
  startZombieGame: m.start, setZombieRole: m.role, beginZombieGame: m.begin, endZombieGame: m.end,
  requestZombieAction: m.request, decideZombieRequest: m.decide, zombieDeliveryFailures: m.failures,
  setZombieReward: m.setReward, getZombieVoiceIds: m.voices,
}));
vi.mock("../lib/community.js", () => ({ isVcTrackingOptedOut: m.privacy }));
vi.mock("../lib/logger.js", () => ({ logger: { warn: m.warn, info: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/zombieRuntime.js", async original => ({
  ...await original<typeof import("../lib/zombieRuntime.js")>(), observeZombieGuild: m.observe, flushZombieJobs: m.flush,
}));
import { zombieCommands, handleZombieButton } from "../commands/zombie.js";
import { zombiePublicResult, zombieTextChannel } from "../lib/zombieRuntime.js";
import { syncZombieCommands } from "../lib/zombieRegistration.js";
import { isCommunityCommandBlocked } from "../lib/restrictedCommandAccess.js";
import { ZombieError, type ZombieConfig, type ZombieGame } from "@workspace/db";
const config: ZombieConfig = { vcIds: ["vc"], excludedUsers: ["excluded"], excludedRoles: ["exclude-role"],
  announceId: "public", rulesId: "rules", resultId: "results", adminId: "private", infectionLogId: "infection", roleLogId: "roles",
  rewards: { humanSurvival: null, humanVictory: null, neverInfected: null, zombieVictory: null, mostInfections: null, healerCoop: null, perHeal: null } };
const game = { id: "event", phase: "running", config,
  players: { user: { id: "user", name: "ニックネーム", role: "healer", infectedUsers: [], healedUsers: [] } },
  requests: {}, winner: "human" } as unknown as ZombieGame;
function fixture(name = "zombie", sub = "status") {
  const flags = { admin: false, privateVisible: false, memberVisible: false };
  const values: Record<string, any> = { 対象: { id: "target" }, 申請: "request", 確認: true };
  const roles = new Collection([
    ["everyone", { id: "everyone", tags: undefined, permissions: { has: (): boolean => false } }],
    ["admin", { id: "admin", tags: undefined, permissions: { has: (): boolean => true } }],
    ["bot-role", { id: "bot-role", tags: { botId: "bot" }, permissions: { has: (): boolean => false } }],
  ]);
  const text = { type: ChannelType.GuildText, permissionOverwrites: { cache: new Collection<string, any>() },
    permissionsFor: (p: { id: string }) => ({ has: () => p.id === "bot" || p.id === "admin" || flags.privateVisible || p.id === "overridden" && flags.memberVisible }) };
  const guild = {
    id: "guild", roles: { fetch: vi.fn(async () => roles) },
    channels: { fetch: vi.fn(async (id: string) => id === "vc" ? { id, type: ChannelType.GuildVoice } : text) },
    voiceStates: { cache: new Collection<string, any>() },
    members: { me: { id: "bot" }, fetch: vi.fn(async ({ user }: { user: string }) => ({
      id: user, user: { bot: user === "bot" }, displayName: `nick-${user}`,
      permissions: { has: () => user === "admin" || user === "user" && flags.admin },
      roles: { cache: new Collection(user === "excluded-role-member" ? [["exclude-role", {}]] : []) },
    })) },
  };
  return { flags, values, guild, text, id: "operation", commandName: name, user: { id: "user" }, client: {},
    customId: "zmb:accept:event:request", message: { edit: vi.fn().mockResolvedValue(undefined) },
    options: { getSubcommand: () => sub, getUser: (k: string) => values[k] ?? null,
      getString: (k: string) => values[k] ?? null, getBoolean: (k: string) => values[k] ?? null,
      getChannel: (k: string) => values[k] ?? null, getRole: (k: string) => values[k] ?? null, getInteger: (k: string) => values[k] ?? null },
    deferReply: vi.fn().mockResolvedValue(undefined), editReply: vi.fn().mockResolvedValue(undefined) };
}
const run = (i: ReturnType<typeof fixture>) => zombieCommands.find(c => c.data.name === i.commandName)!.execute(i as unknown as ChatInputCommandInteraction);
beforeEach(() => {
  vi.clearAllMocks();
  m.get.mockResolvedValue(structuredClone(game)); m.config.mockResolvedValue(structuredClone(config));
  m.failures.mockResolvedValue([]); m.flush.mockResolvedValue(undefined); m.observe.mockResolvedValue(undefined);
  m.privacy.mockResolvedValue(false); m.start.mockResolvedValue(game);
  m.decide.mockResolvedValue({ game, request: { id: "request", status: "accepted" } });
  m.end.mockResolvedValue({ ...game, phase: "ended" });
  m.voices.mockImplementation(async (_guild, configured) => configured);
});
describe("zombie private commands and channel protection", () => {
  it("builds only three new commands, with compatible request and accept subcommands", () => {
    expect(zombieCommands.map(c => c.data.name)).toEqual(["zombie", "infect", "heal"]);
    for (const c of zombieCommands) expect(c.data.toJSON().dm_permission).toBe(false);
    expect(zombieCommands[1]!.data.toJSON().options?.map(o => o.name)).toEqual(["request", "accept", "reject"]);
  });
  it("offers optional random role counts and passes administrator-specified counts to the atomic start", async () => {
    const start = zombieCommands[0]!.data.toJSON().options?.find(o => o.name === "start");
    expect(start).toMatchObject({ options: [
      { name: "ゾンビ数", min_value: 1 }, { name: "治療班数", min_value: 1 },
    ] });
    const i = fixture("zombie", "start"); i.flags.admin = true;
    i.values["ゾンビ数"] = 2; i.values["治療班数"] = 3;
    await run(i);
    expect(m.start).toHaveBeenCalledWith("operation", "guild", [], expect.any(Number), { zombies: 2, healers: 3 });
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining("重複なしのランダム抽選"));
    expect(m.role).not.toHaveBeenCalled();
    expect(i.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  });
  it("makes every command reply private, and forbids status to non-admins", async () => {
    const i = fixture(); await run(i);
    expect(i.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(m.get).not.toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: "管理者のみ操作できます。" }));
  });
  it("includes users already inside generated Hub rooms in the initial random draw", async () => {
    const i = fixture("zombie", "start"); i.flags.admin = true;
    m.voices.mockResolvedValue(["vc", "generated"]);
    i.guild.voiceStates.cache.set("member", { id: "member", channelId: "generated" });
    i.guild.voiceStates.cache.set("unrelated", { id: "unrelated", channelId: "elsewhere" });
    await run(i);
    expect(m.voices).toHaveBeenCalledWith("guild", ["vc"]);
    expect(m.start).toHaveBeenCalledWith("operation", "guild", [{ id: "member", name: "nick-member" }], expect.any(Number), { zombies: 1, healers: 2 });
  });
  it("limits role settings, rewards, beginning and ending to live administrators", async () => {
    expect(isCommunityCommandBlocked("zombie", ["島民"])).toBe(false);
    for (const sub of ["config", "vc", "exclude", "set_zombie", "set_healer", "set_human", "rewards", "start", "begin", "status", "requests", "end", "cancel"]) {
      const i = fixture("zombie", sub); await run(i);
      expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: "管理者のみ操作できます。" }));
    }
    expect(m.role).not.toHaveBeenCalled(); expect(m.begin).not.toHaveBeenCalled();
    expect(m.end).not.toHaveBeenCalled(); expect(m.start).not.toHaveBeenCalled(); expect(m.setReward).not.toHaveBeenCalled();
    expect(m.get).not.toHaveBeenCalled(); expect(m.update).not.toHaveBeenCalled();
  });
  it("lets an island member with live Administrator permission reach the private status handler", async () => {
    expect(isCommunityCommandBlocked("zombie", ["島民"])).toBe(false);
    const i = fixture("zombie", "status"); i.flags.admin = true;
    await run(i);
    expect(m.get).toHaveBeenCalledWith("guild");
    expect(i.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(i.editReply).not.toHaveBeenCalledWith(expect.objectContaining({ content: "管理者のみ操作できます。" }));
  });
  it("shows only the caller's own role without administrator privileges", async () => {
    m.get.mockResolvedValueOnce({ ...game, players: {
      ...game.players, other: { ...game.players.user!, id: "other", name: "他人の秘密", role: "zombie" },
    } });
    const i = fixture("zombie", "me"); await run(i);
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining("治療班"));
    expect(i.editReply).not.toHaveBeenCalledWith(expect.stringContaining("他人の秘密"));
    expect(i.editReply).not.toHaveBeenCalledWith(expect.stringContaining("ゾンビ"));
    expect(i.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(i.guild.members.fetch).not.toHaveBeenCalled();
  });
  it("routes infection and healing through fresh VC observation before creating applications", async () => {
    for (const name of ["infect", "heal"]) {
      expect(isCommunityCommandBlocked(name, ["島民"])).toBe(false);
      const i = fixture(name, "request"); await run(i);
      expect(m.observe).toHaveBeenCalledWith(i.guild);
      expect(m.request).toHaveBeenCalledWith("operation", "guild", "user", "target", name);
      expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining("対象の役職は開示しません"));
      expect(i.guild.members.fetch).not.toHaveBeenCalled();
    }
  });
  it.each(["infect", "heal"])("preserves game-role rejection for island members using %s", async name => {
    expect(isCommunityCommandBlocked(name, ["島民"])).toBe(false);
    m.request.mockRejectedValueOnce(new ZombieError("この申請はできません。参加状態・自分の役職・対象者を確認してください。"));
    const i = fixture(name, "request"); await run(i);
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("この申請はできません") }));
    expect(m.decide).not.toHaveBeenCalled();
  });
  it("does not submit an application when observation cannot be verified", async () => {
    const i = fixture("infect", "request"); m.observe.mockRejectedValueOnce(new ZombieError("接続確認中"));
    await run(i); expect(m.request).not.toHaveBeenCalled();
  });
  it("protects both approval commands and old approval buttons from non-admin users", async () => {
    for (const name of ["infect", "heal"]) for (const sub of ["accept", "reject"]) {
      expect(isCommunityCommandBlocked(name, ["島民"])).toBe(false);
      const command = fixture(name, sub);
      await run(command);
      expect(command.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: "管理者のみ操作できます。" }));
    }
    const i = fixture(); await handleZombieButton(i as unknown as ButtonInteraction);
    expect(m.decide).not.toHaveBeenCalled();
    expect(i.message.edit).not.toHaveBeenCalled();
  });
  it("binds authorized approval buttons to guild, event, request and live administrator", async () => {
    const i = fixture(); i.flags.admin = true;
    await handleZombieButton(i as unknown as ButtonInteraction);
    expect(m.decide).toHaveBeenCalledWith("guild", "event", "request", "user", true);
    expect(i.message.edit).toHaveBeenCalledWith({ components: [] });
  });
  it("refreshes late participants before approval and manual reward settlement", async () => {
    const approval = fixture(); approval.flags.admin = true;
    await handleZombieButton(approval as unknown as ButtonInteraction);
    expect(m.observe.mock.invocationCallOrder[0]).toBeLessThan(m.decide.mock.invocationCallOrder[0]!);
    const end = fixture("zombie", "end"); end.flags.admin = true;
    await run(end);
    expect(m.observe.mock.invocationCallOrder.at(-1)).toBeLessThan(m.end.mock.invocationCallOrder[0]!);
  });
  it("does not approve or settle if fresh participant observation cannot be verified", async () => {
    m.observe.mockRejectedValue(new ZombieError("観測失敗"));
    const approval = fixture(); approval.flags.admin = true;
    await handleZombieButton(approval as unknown as ButtonInteraction);
    const end = fixture("zombie", "end"); end.flags.admin = true;
    await run(end);
    expect(m.decide).not.toHaveBeenCalled(); expect(m.end).not.toHaveBeenCalled();
  });
  it("filters bots, explicit exclusions, role exclusions and VC tracking opt-outs at initial registration", async () => {
    const i = fixture("zombie", "start"); i.flags.admin = true;
    for (const id of ["normal", "bot", "excluded", "excluded-role-member", "optout", "elsewhere"])
      i.guild.voiceStates.cache.set(id, { id, channelId: id === "elsewhere" ? "other" : "vc" });
    m.privacy.mockImplementation(async (_guild, user) => user === "optout");
    await run(i);
    expect(m.start).toHaveBeenCalledWith("operation", "guild", [{ id: "normal", name: "nick-normal" }], expect.any(Number), { zombies: 1, healers: 2 });
  });
  it("requires explicit confirmation and records the operation identity on ending", async () => {
    const i = fixture("zombie", "end"); i.flags.admin = true; i.values["確認"] = false;
    await run(i); expect(m.end).not.toHaveBeenCalled();
    i.values["確認"] = true; await run(i);
    expect(m.end).toHaveBeenCalledWith("guild", "event", false, expect.any(Number), { id: "operation", actor: "user" });
  });
  it("distinguishes unconfigured rewards from a deliberate zero amount", async () => {
    const i = fixture("zombie", "rewards"); i.flags.admin = true;
    await run(i); expect(JSON.stringify(i.editReply.mock.calls)).toContain("未設定");
    expect(m.setReward).not.toHaveBeenCalled();
    i.values["項目"] = "perHeal"; i.values["金額"] = 0; await run(i);
    expect(m.setReward).toHaveBeenCalledWith("guild", "perHeal", 0);
  });
  it("rejects management channels visible to a non-admin role", async () => {
    const i = fixture(); i.flags.privateVisible = true;
    await expect(zombieTextChannel(i.guild as never, "private", true)).rejects.toThrow("管理者とこのBotだけ");
  });
  it("rejects non-admin member-specific visibility overrides", async () => {
    const i = fixture(); i.flags.memberVisible = true;
    i.text.permissionOverwrites.cache.set("overridden", { id: "overridden", type: 1 });
    await expect(zombieTextChannel(i.guild as never, "private", true)).rejects.toThrow("一般メンバー");
  });
  it("accepts private admin-only channels including the Bot's managed role", async () => {
    const i = fixture();
    expect(await zombieTextChannel(i.guild as never, "private", true)).toBe(i.text);
  });
  it("never publishes secret role lists, nicknames, healers or infection logs in result messages", () => {
    const result = JSON.stringify(zombiePublicResult(game).toJSON());
    expect(result).toContain("人間陣営");
    expect(result).not.toContain("ニックネーム");
    expect(result).not.toContain("user");
    expect(result).not.toContain("healer");
  });
  it("does not expose raw SQL or API errors to participants", async () => {
    m.request.mockRejectedValueOnce(new Error("sensitive SQL row secret"));
    const i = fixture("infect", "request"); await run(i);
    expect(JSON.stringify(i.editReply.mock.calls)).not.toContain("sensitive");
  });
  it("individually upserts commands without replacing or deleting existing community commands", async () => {
    const data = new Map();
    const manager = { fetch: vi.fn(async (id: unknown) => typeof id === "string" ? data.get(id) :
      new Collection([["old", { id: "old", name: "zombie", type: 1 }]])),
      create: vi.fn(async def => { data.set(def.name, def); return { id: def.name }; }),
      edit: vi.fn(async (id, def) => { data.set(id, def); return { id }; }), set: vi.fn(), delete: vi.fn() };
    await syncZombieCommands({ application: { commands: manager } } as never);
    expect(manager.edit).toHaveBeenCalledTimes(1); expect(manager.create).toHaveBeenCalledTimes(2);
    expect(manager.fetch).toHaveBeenCalledWith("old", { force: true });
    expect(manager.set).not.toHaveBeenCalled(); expect(manager.delete).not.toHaveBeenCalled();
  });
});
