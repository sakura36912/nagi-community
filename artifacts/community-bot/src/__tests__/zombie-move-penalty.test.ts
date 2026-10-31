import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType, Collection } from "discord.js";
const m = vi.hoisted(() => ({ get: vi.fn(), failure: vi.fn() }));
vi.mock("@workspace/db", async original => ({
  ...await original<typeof import("@workspace/db")>(), getZombieGame: m.get, recordZombieMoveFailure: m.failure,
}));
import { enforceZombieMovePenalties } from "../lib/zombieMovePenalty.js";
function fixture() {
  const game = { id: "event", phase: "running", movePenalties: {
    user: { channel: "origin", until: Date.now() + 60000, requestId: "request" },
  } };
  const voice = { channelId: "other", channel: { permissionsFor: () => ({ has: () => true }) },
    setChannel: vi.fn().mockResolvedValue(undefined) };
  const destination = { id: "origin", type: ChannelType.GuildVoice, permissionsFor: () => ({ has: () => true }) };
  const guild = { id: "guild", client: { isReady: () => true },
    voiceStates: { cache: new Collection([["user", voice]]) },
    channels: { fetch: vi.fn().mockResolvedValue(destination) },
    members: { me: { id: "bot" }, fetch: vi.fn().mockResolvedValue({ voice }) },
  };
  m.get.mockResolvedValue(game);
  return { game, guild, voice, destination };
}
beforeEach(() => vi.resetAllMocks());
describe("mishealing movement restriction", () => {
  it("returns an active user to the original VC without changing overwrites", async () => {
    const f = fixture();
    await enforceZombieMovePenalties(f.guild as never, f.game as never);
    expect(f.voice.setChannel).toHaveBeenCalledWith(f.destination, expect.any(String));
    expect(m.failure).not.toHaveBeenCalled();
  });
  it.each(["expired", "disconnected", "already-home", "ended"])("does not move a user when %s", async state => {
    const f = fixture();
    if (state === "expired") f.game.movePenalties.user.until = Date.now() - 1;
    if (state === "disconnected") f.voice.channelId = null as never;
    if (state === "already-home") f.voice.channelId = "origin";
    if (state === "ended") f.game.phase = "ended";
    await enforceZombieMovePenalties(f.guild as never, f.game as never);
    expect(f.voice.setChannel).not.toHaveBeenCalled();
  });
  it.each(["expiry", "new-event", "end", "new-penalty"])("rechecks state after Discord requests: %s", async state => {
    const f = fixture(), latest = structuredClone(f.game);
    if (state === "expiry") latest.movePenalties.user.until = Date.now() - 1;
    if (state === "new-event") latest.id = "new";
    if (state === "end") latest.phase = "ended";
    if (state === "new-penalty") latest.movePenalties.user.requestId = "new";
    m.get.mockResolvedValue(latest);
    await enforceZombieMovePenalties(f.guild as never, f.game as never);
    expect(f.voice.setChannel).not.toHaveBeenCalled();
  });
  it("logs a failure and safely retries when move permission is restored", async () => {
    const f = fixture();
    f.destination.permissionsFor = () => ({ has: () => false });
    await enforceZombieMovePenalties(f.guild as never, f.game as never);
    expect(m.failure).toHaveBeenCalledWith("guild", "event", "user");
    expect(f.voice.setChannel).not.toHaveBeenCalled();
    f.destination.permissionsFor = () => ({ has: () => true });
    await enforceZombieMovePenalties(f.guild as never, f.game as never);
    expect(f.voice.setChannel).toHaveBeenCalledTimes(1);
  });
  it("prevents duplicate simultaneous moves", async () => {
    const f = fixture();
    await Promise.all([1, 2].map(() => enforceZombieMovePenalties(f.guild as never, f.game as never)));
    expect(f.voice.setChannel).toHaveBeenCalledTimes(1);
  });
});
