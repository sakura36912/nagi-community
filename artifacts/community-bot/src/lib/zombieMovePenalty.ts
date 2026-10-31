import { ChannelType, PermissionFlagsBits, type Guild } from "discord.js";
import { getZombieGame, recordZombieMoveFailure, type ZombieGame } from "@workspace/db";

const moving = new Set<string>();
/** No permission overwrites: expiry, cancellation and bot shutdown leave no persistent Discord restriction. */
export async function enforceZombieMovePenalties(guild: Guild, game: ZombieGame) {
  if (game.phase !== "running") return;
  for (const [userId, penalty] of Object.entries(game.movePenalties ?? {})) {
    if (penalty.until <= Date.now()) continue;
    const voice = guild.voiceStates.cache.get(userId);
    if (!voice?.channelId || voice.channelId === penalty.channel) continue; // Never reconnect a disconnected user.
    const key = `${guild.id}:${userId}`;
    if (moving.has(key)) continue;
    moving.add(key);
    try {
      const destination = await guild.channels.fetch(penalty.channel, { force: true });
      const me = guild.members.me ?? await guild.members.fetchMe();
      const member = await guild.members.fetch({ user: userId, force: true });
      const latest = await getZombieGame(guild.id), active = latest?.movePenalties?.[userId];
      if (!guild.client.isReady() || latest?.id !== game.id || latest.phase !== "running" ||
        active?.requestId !== penalty.requestId || active.until <= Date.now()) continue;
      if (!member.voice.channelId || member.voice.channelId === penalty.channel) continue;
      if (!destination || destination.type !== ChannelType.GuildVoice ||
        !destination.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers]) ||
        !member.voice.channel?.permissionsFor(me)?.has(PermissionFlagsBits.MoveMembers))
        throw new Error("VC move permission unavailable");
      await member.voice.setChannel(destination, "ゾンビイベント：誤治療による60秒のVC移動制限");
    } catch {
      await recordZombieMoveFailure(guild.id, game.id, userId);
    } finally { moving.delete(key); }
  }
}
