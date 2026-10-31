import { randomInt } from "node:crypto";
import { isZombieVoice, type ZombieGame } from "./zombieRules";

/** Uses observed continuous presence only; never infer conversation or outage time. */
export function transferSurroundedHealers(game: ZombieGame, now: number) {
  const transfers: { from: string; to: string; zombies: string[]; channel: string }[] = [];
  const blocked: string[] = [];
  const originalHealers = Object.values(game.players).filter(p => p.role === "healer");
  for (const healer of originalHealers) {
    const presence = game.presence[healer.id];
    const zombies = Object.values(game.players).filter(p => p.role === "zombie" && presence &&
      game.presence[p.id]?.channel === presence.channel &&
      now - Math.max(p.stateAt, healer.stateAt, presence.since, game.presence[p.id]!.since) >= 180000);
    if (!presence || !isZombieVoice(game, presence.channel) || zombies.length < 2) {
      if (game.transferBlocked) delete game.transferBlocked[healer.id];
      continue;
    }
    // A demoted healer must not immediately regain the ability via another transfer in this batch.
    const humans = Object.values(game.players).filter(p => p.role === "human" &&
      !originalHealers.some(h => h.id === p.id));
    if (!humans.length) {
      game.transferBlocked ??= {};
      if (!game.transferBlocked[healer.id]) blocked.push(healer.id);
      game.transferBlocked[healer.id] = true;
      continue;
    }
    const next = humans[randomInt(humans.length)]!;
    healer.role = "human"; healer.version++; healer.stateAt = now;
    next.role = "healer"; next.version++; next.stateAt = now; next.infectedAt = null;
    delete next.healCooldownUntil;
    if (game.transferBlocked) delete game.transferBlocked[healer.id];
    for (const request of Object.values(game.requests))
      if (request.status === "pending" && [healer.id, next.id].some(id => id === request.actor || id === request.target))
        request.status = "stale";
    transfers.push({ from: healer.id, to: next.id, zombies: zombies.map(p => p.id), channel: presence.channel });
  }
  return { transfers, blocked };
}
