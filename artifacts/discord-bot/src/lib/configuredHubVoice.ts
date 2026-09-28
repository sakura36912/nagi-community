import { getHubChannelById, getHubSession } from "@workspace/db";

/** A configured VC Hub also authorizes the rooms it transferred members into. */
export async function isConfiguredHubVoice(
  guildId: string,
  channelId: string | null,
  configuredVoiceId: string | null,
): Promise<boolean> {
  if (!channelId || !configuredVoiceId) return false;
  if (channelId === configuredVoiceId) return true;

  const session = await getHubSession(channelId).catch(() => null);
  if (!session || session.guildId !== guildId) return false;
  const hub = await getHubChannelById(session.hubId).catch(() => null);
  return hub?.guildId === guildId && hub.hubChannelId === configuredVoiceId;
}