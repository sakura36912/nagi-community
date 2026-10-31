export class ZombieError extends Error {}
export type ZombieRole = "human" | "zombie" | "healer";
export const ZOMBIE_REWARDS = ["humanSurvival", "humanVictory", "neverInfected", "zombieVictory", "mostInfections", "healerCoop", "perHeal"] as const;
export type ZombieRewards = Record<typeof ZOMBIE_REWARDS[number], number | null>;
export interface ZombieConfig {
  vcIds: string[]; excludedUsers: string[]; excludedRoles: string[];
  announceId: string; rulesId: string; resultId: string;
  adminId: string; infectionLogId: string; roleLogId: string;
  rewards: ZombieRewards;
}
export interface ZombiePlayer {
  id: string; name: string; role: ZombieRole; version: number; stateAt: number;
  joinedAt?: number;
  healCooldownUntil?: number;
  everInfected: boolean; infectedAt: number | null; infectedUsers: string[]; healedUsers: string[];
}
export interface ZombiePresence { channel: string; since: number }
export interface ZombieRequest {
  id: string; actor: string; target: string; type: "infect" | "heal";
  actorVersion: number; targetVersion: number; channel: string; seconds: number;
  createdAt: number; status: "pending" | "accepted" | "rejected" | "stale"; decidedBy?: string;
  misheal?: boolean;
}
export interface ZombieGame {
  id: string; guildId: string; phase: "preparing" | "running" | "ended" | "cancelled";
  config: ZombieConfig; players: Record<string, ZombiePlayer>; requests: Record<string, ZombieRequest>;
  epoch: string; observedAt: number; presence: Record<string, ZombiePresence>;
  createdAt: number; startedAt: number | null; endedAt: number | null;
  winner: "human" | "zombie" | null; payouts: { userId: string; amount: number }[];
  movePenalties?: Record<string, { channel: string; until: number; requestId: string }>;
  transferBlocked?: Record<string, boolean>;
}
export function checkZombieHealCooldown(player: ZombiePlayer, now: number) {
  if ((player.healCooldownUntil ?? 0) > now)
    throw new ZombieError(`治療クールタイム中です。残り${Math.ceil((player.healCooldownUntil! - now) / 1000)}秒です。`);
}
export function zombieAmount(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 2147483647) throw new ZombieError("報酬額は0〜2,147,483,647の整数で指定してください。");
  return value;
}
export function zombieWinner(game: ZombieGame): "human" | "zombie" {
  return Object.values(game.players).some(p => p.role === "human") ? "human" : "zombie";
}
export function zombiePayouts(game: ZombieGame) {
  const r = game.config.rewards;
  if (ZOMBIE_REWARDS.some(k => r[k] === null || r[k] === undefined)) throw new ZombieError("報酬7項目をすべて設定してください。無料の場合も明示的に0を指定します。");
  for (const key of ZOMBIE_REWARDS) zombieAmount(r[key]!);
  const winner = zombieWinner(game);
  const zombies = Object.values(game.players).filter(p => p.role === "zombie");
  const most = Math.max(0, ...zombies.map(p => p.infectedUsers.length));
  return Object.values(game.players).sort((a, b) => a.id.localeCompare(b.id)).map(p => {
    const amount = p.role === "healer" ? r.healerCoop! + r.perHeal! * p.healedUsers.length :
      p.role === "human" ? r.humanSurvival! + (winner === "human" ? r.humanVictory! : 0) + (!p.everInfected ? r.neverInfected! : 0) :
      (winner === "zombie" ? r.zombieVictory! : 0) + (most > 0 && p.infectedUsers.length === most ? r.mostInfections! : 0);
    return { userId: p.id, amount: zombieAmount(amount) };
  });
}
export function validateZombieRewardCapacity(game: ZombieGame) {
  zombiePayouts(game);
  const r = game.config.rewards;
  zombieAmount(r.humanSurvival! + r.humanVictory! + r.neverInfected!);
  zombieAmount(r.zombieVictory! + r.mostInfections!);
  zombieAmount(r.healerCoop! + r.perHeal! * Math.max(0, Object.keys(game.players).length - 1));
}
export function zombieProof(game: ZombieGame, actor: ZombiePlayer, target: ZombiePlayer, now: number) {
  const a = game.presence[actor.id], b = game.presence[target.id];
  if (!a || !b || a.channel !== b.channel || !game.config.vcIds.includes(a.channel))
    throw new ZombieError("対象者と設定済みの酒場VCで交流してください。");
  const seconds = Math.floor((now - Math.max(a.since, b.since, actor.stateAt, target.stateAt)) / 1000);
  if (seconds < 180) throw new ZombieError(`連続3分の同席が必要です（現在${Math.max(0, seconds)}秒）。役職変更・移動・ミュート・再接続後は数え直します。`);
  return { channel: a.channel, seconds };
}
