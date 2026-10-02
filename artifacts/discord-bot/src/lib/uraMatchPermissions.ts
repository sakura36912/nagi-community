import { ChannelType, OverwriteType, PermissionFlagsBits, type Guild, type OverwriteResolvable } from "discord.js";
import { listUraMatchesForGuildBefore } from "@workspace/db";
import { logger } from "./logger";

const mediaPermissions = [
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.Stream,
];

export function uraMatchPermissionOverwrites(guild: Guild, hostId: string, guestId: string): OverwriteResolvable[] {
  const participantPermissions = [
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak,
    ...mediaPermissions,
  ];
  return [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
    },
    { id: hostId, type: OverwriteType.Member, allow: participantPermissions },
    { id: guestId, type: OverwriteType.Member, allow: participantPermissions },
    ...(guild.client.user ? [{
      id: guild.client.user.id, type: OverwriteType.Member,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers],
    }] : []),
  ];
}

/** Patch active rooms only; retain all privacy and unrelated permission settings. */
export async function syncExistingUraMatchPermissions(guild: Guild): Promise<boolean> {
  const matches = await listUraMatchesForGuildBefore(guild.id, new Date());
  let complete = true;
  for (const match of matches) {
    if (match.status !== "active" || !match.channelId) continue;
    try {
      const channel = await guild.channels.fetch(match.channelId);
      if (!channel) continue;
      if (channel.type !== ChannelType.GuildVoice || channel.guild.id !== guild.id) {
        throw new Error("裏航海の専用VCの種類またはサーバーが一致しません。");
      }
      for (const userId of new Set([match.hostId, match.guestId])) {
        const overwrite = channel.permissionOverwrites.cache.get(userId);
        if (overwrite?.type === OverwriteType.Member
          && mediaPermissions.every((permission) => overwrite.allow.has(permission) && !overwrite.deny.has(permission))) {
          continue;
        }
        await channel.permissionOverwrites.edit(userId, {
          SendMessages: true, ReadMessageHistory: true, Stream: true,
        }, { type: OverwriteType.Member, reason: "裏航海の参加者にインチャット・画面共有を許可" });
      }
    } catch (error) {
      if ((error as { code?: number }).code === 10003) continue;
      complete = false;
      logger.warn(`[ura] failed to update VC permissions guild=${guild.id} match=${match.id}`, error);
    }
  }
  return complete;
}