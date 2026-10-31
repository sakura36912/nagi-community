import { describe, expect, it } from "vitest";
import { checkZombieHealCooldown, type ZombieGame } from "@workspace/db";
import { transferSurroundedHealers } from "../../../../lib/db/src/zombieBalance";

function game(): ZombieGame {
  return {
    phase: "running", config: { vcIds: ["vc"] }, requests: {}, presence: {},
    players: Object.fromEntries(["doctor", "z1", "z2", "h1", "h2"].map(id => [id, {
      id, name: id, role: id === "doctor" ? "healer" : id.startsWith("z") ? "zombie" : "human",
      version: 0, stateAt: 0, everInfected: false, infectedAt: null, infectedUsers: [], healedUsers: [],
    }])),
  } as unknown as ZombieGame;
}
function present(g: ZombieGame, since = 0) {
  g.presence = Object.fromEntries(Object.keys(g.players).map(id => [id, { channel: "vc", since }]));
}
describe("zombie balancing rules", () => {
  it("enforces a cooldown through the last millisecond, including exact remaining seconds", () => {
    const p = game().players.doctor!;
    p.healCooldownUntil = 60000;
    expect(() => checkZombieHealCooldown(p, 59001)).toThrow("残り1秒");
    expect(() => checkZombieHealCooldown(p, 60000)).not.toThrow();
    delete p.healCooldownUntil;
    expect(() => checkZombieHealCooldown(p, 0)).not.toThrow();
  });
  it("transfers exactly once at 180 seconds to a human, preserving infection history and healer count", () => {
    const g = game(); present(g);
    g.players.h1!.everInfected = g.players.h2!.everInfected = true;
    expect(transferSurroundedHealers(g, 179999).transfers).toHaveLength(0);
    const result = transferSurroundedHealers(g, 180000);
    expect(result.transfers).toHaveLength(1);
    const next = g.players[result.transfers[0]!.to]!;
    expect(["h1", "h2"]).toContain(next.id);
    expect(next.role).toBe("healer"); expect(next.everInfected).toBe(true);
    expect(next.stateAt).toBe(180000); expect(next.version).toBe(1);
    expect(g.players.doctor!.role).toBe("human");
    expect(Object.values(g.players).filter(p => p.role === "healer")).toHaveLength(1);
    expect(transferSurroundedHealers(g, 180000).transfers).toHaveLength(0);
  });
  it.each(["absent", "other", "recent", "role-change"])("requires two continuously eligible zombies: %s", reason => {
    const g = game(); present(g);
    if (reason === "absent") delete g.presence.z2;
    if (reason === "other") g.presence.z2!.channel = "elsewhere";
    if (reason === "recent") g.presence.z2!.since = 1;
    if (reason === "role-change") g.players.z2!.stateAt = 1;
    expect(transferSurroundedHealers(g, 180000).transfers).toHaveLength(0);
  });
  it("does not transfer when continuity resets on reconnect or mute", () => {
    const g = game(); present(g, 180000);
    expect(transferSurroundedHealers(g, 180001).transfers).toHaveLength(0);
    g.presence = {};
    expect(transferSurroundedHealers(g, 360001).transfers).toHaveLength(0);
  });
  it("retains abilities without a replacement and reports the block once", () => {
    const g = game(); present(g);
    delete g.players.h1; delete g.players.h2;
    expect(transferSurroundedHealers(g, 180000).blocked).toEqual(["doctor"]);
    expect(g.players.doctor!.role).toBe("healer");
    expect(transferSurroundedHealers(g, 181000).blocked).toEqual([]);
  });
  it("never selects the just-demoted healer for another healer's transfer and stales old requests", () => {
    const g = game(); g.players.h1!.role = "healer"; present(g);
    g.requests.r = { id: "r", actor: "doctor", target: "z1", status: "pending" } as never;
    const result = transferSurroundedHealers(g, 180000);
    expect(result.transfers).toHaveLength(1);
    expect(result.transfers[0]!.to).toBe("h2");
    expect(g.requests.r!.status).toBe("stale");
    expect(Object.values(g.players).filter(p => p.role === "healer")).toHaveLength(2);
  });
});
