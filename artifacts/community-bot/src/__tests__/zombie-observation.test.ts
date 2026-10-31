import { beforeEach, describe, expect, it, vi } from "vitest";
import { Collection } from "discord.js";
const m = vi.hoisted(() => ({ get: vi.fn(), sync: vi.fn(), privacy: vi.fn() }));
vi.mock("@workspace/db", async original => ({
  ...await original<typeof import("@workspace/db")>(), getZombieGame: m.get, syncZombiePresence: m.sync,
}));
vi.mock("../lib/community.js", () => ({ isVcTrackingOptedOut: m.privacy }));
import { observeZombieGuild, resetZombieConnection } from "../lib/zombieRuntime.js";
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
  vi.clearAllMocks();
  guild.client.isReady.mockReturnValue(true);
  resetZombieConnection(true);
  m.get.mockResolvedValue({ phase: "running", players: { normal: {}, muted: {}, deaf: {}, bot: {}, optout: {} } });
  m.privacy.mockImplementation(async (_guild, id) => id === "optout");
  m.sync.mockResolvedValue(undefined);
});
describe("zombie VC observation continuity", () => {
  it("excludes muted, deafened, bot and opted-out users from continuous observation", async () => {
    await observeZombieGuild(guild as never);
    expect(m.sync).toHaveBeenCalledWith("test-guild", expect.any(String), { normal: "vc" }, expect.any(Number));
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
