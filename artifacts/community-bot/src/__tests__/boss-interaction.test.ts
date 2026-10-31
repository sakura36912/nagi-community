import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType, Collection, PermissionFlagsBits, type ChatInputCommandInteraction, type ButtonInteraction } from "discord.js";

const m = vi.hoisted(() => ({
  fees: vi.fn(), configure: vi.fn(), host: vi.fn(), end: vi.fn(), info: vi.fn(), quote: vi.fn(),
  join: vi.fn(), cancel: vi.fn(), action: vi.fn(), recover: vi.fn(), error: vi.fn(), warn: vi.fn(),
}));
vi.mock("@workspace/db", async original => ({
  ...await original<typeof import("@workspace/db")>(),
  getBossFees: m.fees, configureBossFees: m.configure, createBossEvent: m.host, endBossEvent: m.end,
  getBossInfo: m.info, createBossJoinRequest: m.quote, confirmBossJoin: m.join,
  cancelBossJoinRequest: m.cancel, performBossAction: m.action,
}));
vi.mock("../lib/bossRecovery", () => ({ runBossRecovery: m.recover }));
vi.mock("../lib/logger", () => ({ logger: { error: m.error, warn: m.warn, info: vi.fn() } }));
import { BossError, type BossEvent, type BossNoticeBundle } from "@workspace/db";
import { bossCommands, executeBossCommand, handleBossButton } from "../commands/boss";
import { bossBattleNotice } from "../lib/bossUi";
import { syncBossCommandRegistration } from "../lib/bossCommandRegistration";

const event: BossEvent = {
  id: "event", guildId: "guild", channelId: "channel", bossType: "kraken", status: "active",
  createdAt: new Date(), endsAt: new Date(Date.now() + 600000),
  config: { soloHp: 100, partyHp: 400, attack: 10, defense: 5, reward: 101,
    durationSeconds: 600, lobbySeconds: 10, playerHp: 100, healAmount: 25, counterEvery: 2,
    cooldownSeconds: 1, criticalPercent: 10, criticalMultiplier: 2, levelBonusPercent: 5,
    special: "none", bonusRoleId: null, roleMultiplier: 1 },
};
function fixture(name = "参加") {
  const flags = { admin: false, crew: true, channel: true };
  const values: Record<string, unknown> = { モード: "party" };
  const roles = new Collection([["crew", { id: "crew", name: "本船員" }]]);
  return {
    flags, values, roles, id: "1234567890123456789", commandName: name, customId: "boss:join:quote",
    user: { id: "user" }, memberPermissions: { has: () => flags.admin },
    guild: { id: "guild", roles: { fetch: vi.fn(async (id?: string) => id ? roles.get(id) : roles) },
      members: { me: { id: "bot" }, fetch: vi.fn(async () => ({
        displayName: "サーバーニックネーム", permissions: { has: () => flags.admin },
        roles: { cache: new Collection(flags.crew ? [["crew", { id: "crew" }]] : []) },
      })) } },
    channel: { id: "channel", type: ChannelType.GuildText, isThread: () => false,
      permissionsFor: () => ({ has: () => flags.channel }), send: vi.fn().mockResolvedValue({ id: "announcement" }) },
    options: {
      getString: (key: string) => values[key] ?? null, getInteger: (key: string) => values[key] ?? null,
      getBoolean: (key: string) => values[key] ?? null, getNumber: (key: string) => values[key] ?? null,
      getRole: (key: string) => values[key] ?? null,
    },
    client: {}, message: { edit: vi.fn().mockResolvedValue(undefined) },
    deferReply: vi.fn().mockResolvedValue(undefined), editReply: vi.fn().mockResolvedValue(undefined),
  };
}
const run = (i: ReturnType<typeof fixture>) => executeBossCommand(i as unknown as ChatInputCommandInteraction);
const click = (i: ReturnType<typeof fixture>) => handleBossButton(i as unknown as ButtonInteraction);
beforeEach(() => {
  vi.clearAllMocks();
  m.fees.mockResolvedValue({ attackCost: null, healCost: null });
  m.host.mockResolvedValue(event);
  m.quote.mockResolvedValue({ event, request: { id: "quote", mode: "party", attackCost: 100, healCost: 250 } });
  m.join.mockResolvedValue({ battleId: "battle", mode: "party", state: "waiting", bossHp: 400, messages: ["パーティ受付中"] });
  m.action.mockResolvedValue({ battleId: "battle", mode: "solo", state: "active", bossHp: 50, damage: 25,
    paid: 100, balance: 900, userHp: 90, messages: [] });
  m.recover.mockResolvedValue(undefined);
});
describe("boss commands and displays", () => {
  it("builds eight valid commands with all host parameters and no bulk command replacement", () => {
    expect(bossCommands).toHaveLength(8);
    const host = bossCommands.find(c => c.data.name === "ボス開催")!.data.toJSON();
    expect(host.options!.length).toBeLessThanOrEqual(25);
    expect(host.default_member_permissions).toBe(PermissionFlagsBits.Administrator.toString());
    for (const name of ["ソロhp", "パーティhp", "攻撃力", "防御力", "プレイヤーhp", "回復量", "反撃間隔", "会心倍率"]) {
      expect(host.options!.find(o => o.name === name)?.required).toBe(true);
    }
    expect(bossCommands.map(c => c.data.name)).toEqual(expect.arrayContaining(["参加", "攻撃", "回復", "ボス情報"]));
    for (const name of ["攻撃間隔秒", "回復間隔秒"]) {
      expect(host.options!.find(o => o.name === name)?.required).not.toBe(true);
    }
    expect(host.options!.some(o => o.name === "行動間隔秒")).toBe(false);
    const fees = bossCommands.find(c => c.data.name === "ボス料金設定")!.data.toJSON();
    expect(fees.options!.map(o => o.name)).toEqual(["回復料金"]);
  });
  it.each([{}, { 攻撃間隔秒: 10, 回復間隔秒: 60 }])("passes individual cooldown settings to the hosted event: %j", async overrides => {
    const i = fixture("ボス開催"); i.flags.admin = true;
    Object.assign(i.values, {
      ボス: "kraken", ソロhp: 100, パーティhp: 400, 制限秒: 600, 受付秒: 10, 報酬: 100,
      攻撃力: 10, 防御力: 0, プレイヤーhp: 100, 回復量: 25, 反撃間隔: 2,
      会心率: 10, 会心倍率: 2, レベル補正率: 5, ...overrides,
    });
    await run(i);
    expect(m.host).toHaveBeenCalledWith(i.id, "guild", "channel", "kraken", expect.objectContaining({
      attackCooldownSeconds: overrides.攻撃間隔秒 ?? 5,
      healCooldownSeconds: overrides.回復間隔秒 ?? 30,
    }));
  });
  it("rejects non-crew before preparing a participation or charge", async () => {
    const i = fixture(); i.flags.crew = false;
    await run(i);
    expect(m.quote).not.toHaveBeenCalled();
    expect(m.action).not.toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("本船員") }));
  });
  it("requires administrator permission to host, end and configure costs", async () => {
    for (const name of ["ボス開催", "ボス終了", "ボス料金設定"]) await run(fixture(name));
    expect(m.host).not.toHaveBeenCalled();
    expect(m.end).not.toHaveBeenCalled();
    expect(m.configure).not.toHaveBeenCalled();
  });
  it("shows free attacks and configures only paid healing", async () => {
    const i = fixture("ボス料金設定"); i.flags.admin = true;
    await run(i);
    expect(m.configure).not.toHaveBeenCalled();
    expect(JSON.stringify(i.editReply.mock.calls)).toContain("未設定");
    i.values["回復料金"] = 50;
    m.configure.mockResolvedValue({ attackCost: 0, healCost: 50 });
    await run(i);
    expect(m.configure).toHaveBeenCalledWith("guild", { healCost: 50 });
  });
  it("shows both fees and requires participation confirmation, with no charge on preparing", async () => {
    const i = fixture();
    await run(i);
    expect(m.quote).toHaveBeenCalledWith(i.id, "guild", "user", "party");
    expect(m.join).not.toHaveBeenCalled();
    expect(m.action).not.toHaveBeenCalled();
    const output = JSON.stringify(i.editReply.mock.calls);
    expect(output).toContain("無料（$0）"); expect(output).toContain("$250");
    expect(output).not.toContain("$100");
    expect(output).toContain("条件を確認して参加");
  });
  it("uses fresh role eligibility and server nickname at participation confirmation", async () => {
    const i = fixture();
    await click(i);
    expect(m.join).toHaveBeenCalledWith("quote", "guild", "user", "サーバーニックネーム", ["crew"]);
    expect(i.guild.members.fetch).toHaveBeenCalledWith({ user: "user", force: true });
    expect(i.message.edit).toHaveBeenCalledWith({ components: [] });
  });
  it("does not join or charge after crew role revocation", async () => {
    const i = fixture(); i.flags.crew = false;
    await click(i);
    expect(m.join).not.toHaveBeenCalled();
    expect(i.message.edit).not.toHaveBeenCalled();
  });
  it("supports safe cancellation without combat actions", async () => {
    const i = fixture(); i.customId = "boss:cancel:quote";
    await click(i);
    expect(m.cancel).toHaveBeenCalledWith("quote", "guild", "user");
    expect(m.join).not.toHaveBeenCalled(); expect(m.action).not.toHaveBeenCalled();
  });
  it("routes free attacks and paid heals to existing-bank transactional actions", async () => {
    const i = fixture("攻撃");
    m.action.mockResolvedValueOnce({ battleId: "battle", mode: "solo", state: "active", bossHp: 50,
      damage: 25, paid: 0, balance: 1000, userHp: 90, messages: [] });
    await run(i);
    expect(m.action).toHaveBeenCalledWith(i.id, "guild", "user", "attack");
    expect(JSON.stringify(i.editReply.mock.calls)).toContain("消費：$0");
    i.commandName = "回復"; await run(i);
    expect(m.action).toHaveBeenCalledWith(i.id, "guild", "user", "heal");
    expect(JSON.stringify(i.editReply.mock.calls)).toContain("消費：$100");
  });
  it("reports insufficient balance and stale/cross-user confirmation errors", async () => {
    const i = fixture("攻撃"); m.action.mockRejectedValue(new BossError("残高が不足しています。"));
    await run(i);
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: "残高が不足しています。" }));
    m.join.mockRejectedValue(new BossError("この参加確認は操作できません。"));
    await click(i);
    expect(i.message.edit).not.toHaveBeenCalled();
  });
  it("requires explicit consent for forced end and passes the operation identity for deduplication", async () => {
    const i = fixture("ボス終了"); i.flags.admin = true; i.values["確認"] = false;
    await run(i); expect(m.end).not.toHaveBeenCalled();
    i.values["確認"] = true; await run(i);
    expect(m.end).toHaveBeenCalledWith("guild", expect.any(Date), { id: i.id, actorId: "user" });
  });
  it("rejects hosting without announcement permissions before storing an event", async () => {
    const i = fixture("ボス開催"); i.flags.admin = true; i.flags.channel = false;
    await run(i);
    expect(m.host).not.toHaveBeenCalled();
  });
  it("never shows internal weapon stats or damage rankings during ongoing battle", () => {
    const bundle = {
      event, battle: { id: "battle", status: "active", mode: "party", currentHp: 90, maxHp: 100, attackCost: 100, healCost: 250,
        endsAt: event.endsAt, startedAt: new Date(), finishedAt: new Date(), rewards: [{ userId: "user", amount: 101 }] },
      members: [{ userId: "user", displayName: "サーバー名", hp: 90, maxHp: 100, damage: 57,
        weapon: { attack: 9999, defense: 8888 } }],
    } as unknown as BossNoticeBundle;
    const ongoing = JSON.stringify(bossBattleNotice(bundle).toJSON());
    expect(ongoing).not.toMatch(/ランキング|総ダメージ|9999|8888|攻撃力|防御力/);
    bundle.battle.status = "won"; bundle.battle.currentHp = 0;
    const finished = JSON.stringify(bossBattleNotice(bundle).toJSON());
    expect(finished).toContain("終了時ダメージランキング");
    expect(finished).toContain("MVP"); expect(finished).toContain("サーバー名");
    expect(finished).toContain("加算済み");
    expect(finished).not.toMatch(/9999|8888/);
  });
  it("individually registers and force-verifies eight boss commands without deleting anything", async () => {
    const saved = new Map();
    const manager = {
      fetch: vi.fn(async (key: unknown) => typeof key === "string" ? saved.get(key)
        : new Collection([["existing", { id: "existing", name: "攻撃", type: 1 }]])),
      edit: vi.fn(async (id, def) => { saved.set(id, def); return { id }; }),
      create: vi.fn(async def => { saved.set(def.name, def); return { id: def.name }; }),
      set: vi.fn(), delete: vi.fn(),
    };
    await syncBossCommandRegistration({ application: { commands: manager } } as never);
    expect(manager.edit).toHaveBeenCalledTimes(1); expect(manager.create).toHaveBeenCalledTimes(7);
    expect(manager.fetch).toHaveBeenCalledWith("existing", { force: true });
    expect(manager.set).not.toHaveBeenCalled(); expect(manager.delete).not.toHaveBeenCalled();
  });
});
