import { beforeEach, describe, expect, it, vi } from "vitest";
import { Collection } from "discord.js";
const m = vi.hoisted(() => ({ get: vi.fn(), sync: vi.fn(), privacy: vi.fn(), enroll: vi.fn(), pending: vi.fn(), voices: vi.fn() }));
vi.mock("@workspace/db", async original => ({
  ...await original<typeof import("@workspace/db")>(), getZombieGame: m.get, syncZombiePresence: m.sync,
  enrollZombieParticipants: m.enroll, pendingZombieJobs: m.pending, getZombieVoiceIds: m.voices,
}));
vi.mock("../lib/community.js", () => ({ isVcTrackingOptedOut: m.privacy }));
import { observeZombieGuild, resetZombieConnection, startZombieRuntime } from "../lib/zombieRuntime.js";
function game(phase = "running") {
  return { id: "event", phase, players: { normal: {}, muted: {}, deaf: {}, bot: {}, optout: {} },
    config: { vcIds: ["vc", "second"], excludedUsers: ["excluded"], excludedRoles: ["excluded-role"] } };
}
const guild = {
  id: "test-guild", available: true, client: { isReady: vi.fn(() => true) }, voiceStates: { cache: new Collection([
    ["normal", { id: "normal", channelId: "vc", mute: false, deaf: false, member: { user: { bot: false } } }],
    ["muted", { id: "muted", channelId: "vc", mute: true, deaf: false, member: { user: { bot: false } } }],
    ["deaf", { id: "deaf", channelId: "vc", mute: false, deaf: true, member: { user: { bot: false } } }],
    ["bot", { id: "bot", channelId: "vc", mute: false, deaf: false, member: { user: { bot: true } } }],
    ["optout", { id: "optout", channelId: "vc", mute: false, deaf: false, member: { user: { bot: false } } }],
  ]) },
};
beforeEach(() => {
  vi.resetAllMocks();
  guild.client.isReady.mockReturnValue(true);
  resetZombieConnection(true);
  m.get.mockResolvedValue(game());
  m.privacy.mockImplementation(async (_guild, id) => ["optout", "new-optout"].includes(id));
  m.sync.mockResolvedValue(undefined);
  m.enroll.mockResolvedValue([]);
  m.pending.mockResolvedValue([]);
  m.voices.mockImplementation(async (_guild, configured) => configured);
});
describe("zombie VC observation continuity", () => {
  it("excludes muted, deafened, bot and opted-out users from continuous observation", async () => {
    await observeZombieGuild(guild as never);
    expect(m.sync).toHaveBeenCalledWith("test-guild", expect.any(String), { normal: "vc" }, expect.any(Number), "event");
  });
  it("invalidates previous continuity after a DB/privacy lookup failure", async () => {
    await observeZombieGuild(guild as never);
    const epoch = m.sync.mock.calls[0]![1];
    m.privacy.mockRejectedValueOnce(new Error("lookup failed"));
    await expect(observeZombieGuild(guild as never)).rejects.toThrow("数え直す");
    await observeZombieGuild(guild as never);
    expect(m.sync.mock.calls[1]![1]).not.toBe(epoch);
  });
  it("refuses requests while disconnected", async () => {
    resetZombieConnection(false);
    await expect(observeZombieGuild(guild as never)).rejects.toThrow("接続を確認中");
    expect(m.sync).not.toHaveBeenCalled();
  });
  it("does not save a stale snapshot when gateway loss occurs during a lookup", async () => {
    m.get.mockImplementationOnce(async () => {
      resetZombieConnection(false);
      return { phase: "running", players: { normal: {} } };
    });
    await expect(observeZombieGuild(guild as never)).rejects.toThrow("数え直す");
    expect(m.sync).not.toHaveBeenCalled();
  });
  it("also checks the actual client readiness, not just the event flag", async () => {
    guild.client.isReady.mockReturnValue(false);
    await expect(observeZombieGuild(guild as never)).rejects.toThrow("接続を確認中");
    expect(m.sync).not.toHaveBeenCalled();
  });
});
function arriving(people: { id: string; channel?: string; muted?: boolean }[]) {
  return { ...guild, voiceStates: { cache: new Collection([
    ...guild.voiceStates.cache,
    ...people.map(p => [p.id, { id: p.id, channelId: p.channel ?? "vc", mute: p.muted ?? false, deaf: false, member: { user: { bot: false } } }] as const),
  ]) }, members: { fetch: vi.fn(async ({ user }: { user: string }) => ({
    id: user, displayName: `名前-${user}`, user: { bot: user === "new-bot" },
    roles: { cache: new Collection(user === "role-out" ? [["excluded-role", {}]] : []) },
  })) } };
}
describe("zombie automatic late admission", () => {
  it("observes registered Hub children by actual VC ID and admits new arrivals there", async () => {
    m.voices.mockResolvedValue(["vc", "second", "generated"]);
    const g = arriving([{ id: "late", channel: "generated" }]);
    await observeZombieGuild(g as never);
    expect(m.voices).toHaveBeenCalledWith("test-guild", ["vc", "second"]);
    expect(m.enroll).toHaveBeenCalledWith("test-guild", "event", [{ id: "late", name: "名前-late", channel: "generated" }], expect.any(Number));
    expect(m.sync).toHaveBeenCalledWith("test-guild", expect.any(String), { normal: "vc", late: "generated" }, expect.any(Number), "event");
  });
  it("fails closed and resets continuity if the Hub relationship lookup fails", async () => {
    m.voices.mockRejectedValueOnce(new Error("lookup unavailable"));
    await expect(observeZombieGuild(guild as never)).rejects.toThrow("数え直す");
    expect(m.sync).not.toHaveBeenCalled(); expect(m.enroll).not.toHaveBeenCalled();
  });
  it("registers newcomers in both configured VCs, but does not count muted time", async () => {
    const g = arriving([{ id: "late" }, { id: "quiet", channel: "second", muted: true }]);
    await observeZombieGuild(g as never);
    expect(m.enroll).toHaveBeenCalledWith("test-guild", "event", [
      { id: "late", name: "名前-late", channel: "vc" },
      { id: "quiet", name: "名前-quiet", channel: "second" },
    ], expect.any(Number));
    expect(m.sync).toHaveBeenCalledWith("test-guild", expect.any(String), { normal: "vc", late: "vc" }, expect.any(Number), "event");
    expect(g.members.fetch).toHaveBeenCalledWith({ user: "late", force: true });
  });
  it("does not enroll bots, excluded users or roles, opted-out users, or people outside target VCs", async () => {
    const g = arriving(["late", "new-bot", "excluded", "role-out", "new-optout"].map(id => ({ id })));
    g.voiceStates.cache.set("outside", { id: "outside", channelId: "elsewhere", mute: false, deaf: false, member: { user: { bot: false } } });
    await observeZombieGuild(g as never);
    expect(m.enroll).toHaveBeenCalledWith("test-guild", "event", [{ id: "late", name: "名前-late", channel: "vc" }], expect.any(Number));
  });
  it("also admits people during role preparation", async () => {
    m.get.mockResolvedValue(game("preparing"));
    await observeZombieGuild(arriving([{ id: "late" }]) as never);
    expect(m.enroll).toHaveBeenCalledTimes(1);
  });
  it.each(["ended", "cancelled"])("does not reopen a %s event", async phase => {
    m.get.mockResolvedValue(game(phase));
    await observeZombieGuild(arriving([{ id: "late" }]) as never);
    expect(m.enroll).not.toHaveBeenCalled(); expect(m.sync).not.toHaveBeenCalled();
  });
  it("fails closed when fresh role lookup fails, but skips a member who left the guild", async () => {
    const g = arriving([{ id: "late" }]);
    g.members.fetch.mockRejectedValueOnce(new Error("Discord unavailable"));
    await expect(observeZombieGuild(g as never)).rejects.toThrow("数え直す");
    expect(m.enroll).not.toHaveBeenCalled();
    g.members.fetch.mockRejectedValueOnce({ code: 10007 });
    await observeZombieGuild(g as never);
    expect(m.enroll).not.toHaveBeenCalled();
  });
  it("scans at startup and every 15 seconds to recover missed joins without a new voice event", async () => {
    vi.useFakeTimers();
    const g = arriving([{ id: "late" }]);
    const stop = startZombieRuntime({ guilds: { cache: new Collection([["test-guild", g]]) } } as never);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(m.enroll).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(15000);
      expect(m.enroll).toHaveBeenCalledTimes(2);
    } finally { stop(); vi.useRealTimers(); }
  });
});
