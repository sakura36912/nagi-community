import { ChannelType, OverwriteType, PermissionFlagsBits, type Guild, type GuildChannel, type VoiceChannel } from "discord.js";

/** ON means the channel explicitly enables streaming for all permitted entrants. */
export function isVcStreamingEnabled(channel: GuildChannel, everyoneId: string): boolean {
  if (!("permissionOverwrites" in channel)) return false;
  const overwrites = channel.permissionOverwrites.cache;
  return Boolean(overwrites.get(everyoneId)?.allow.has(PermissionFlagsBits.Stream))
    && !overwrites.some(overwrite => overwrite.deny.has(PermissionFlagsBits.Stream));
}

const changingChannels = new Set<string>();

/**
 * Change only Stream. Everyone grants the baseline; role/member overwrites must
 * agree, otherwise their higher-priority deny/allow defeats the switch.
 * Never sync with the category or replace access/command permission settings.
 */
export async function toggleVcStreaming(guild: Guild, channelId: string): Promise<{ channel: VoiceChannel; enabled: boolean }> {
  const key = `${guild.id}:${channelId}`;
  if (changingChannels.has(key)) throw new Error("画面共有の設定変更中です。少し待って再度操作してください。");
  changingChannels.add(key);
  try {
    const channel = await guild.channels.fetch(channelId, { force: true });
    if (!channel || channel.type !== ChannelType.GuildVoice) throw new Error("対象のVCが見つかりません。");
    const everyoneId = guild.roles.everyone.id;
    const enabled = !isVcStreamingEnabled(channel, everyoneId);
    const targets = new Map(channel.permissionOverwrites.cache.map(overwrite => [overwrite.id, overwrite.type]));
    targets.set(everyoneId, OverwriteType.Role);
    let failed = 0;
    for (const [id, type] of targets) {
      try {
        await channel.permissionOverwrites.edit(id, { Stream: enabled }, { type });
      } catch {
        failed++;
      }
    }
    if (failed) throw new Error(`${failed}件の画面共有権限を変更できませんでした。一部のみ反映されている可能性があります。Botの権限を確認して再操作してください。`);
    const refreshed = await guild.channels.fetch(channelId, { force: true });
    if (!refreshed || refreshed.type !== ChannelType.GuildVoice
      || (enabled
        ? !isVcStreamingEnabled(refreshed, everyoneId)
        : !refreshed.permissionOverwrites.cache.get(everyoneId)?.deny.has(PermissionFlagsBits.Stream)
          || refreshed.permissionOverwrites.cache.some(overwrite => overwrite.allow.has(PermissionFlagsBits.Stream)))) {
      throw new Error("画面共有権限の反映を確認できませんでした。再操作する前にVCの権限を確認してください。");
    }
    return { channel: refreshed, enabled };
  } finally {
    changingChannels.delete(key);
  }
}
