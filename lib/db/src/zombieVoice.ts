import { and, eq, inArray } from "drizzle-orm";
import { db } from "./index";
import { vcHubChannelsTable as hubs, vcHubSessionsTable as sessions } from "./schema/vcHub";

/** Only stored, same-guild Hub relationships authorize generated rooms; never infer from names/categories. */
export async function getZombieVoiceIds(guildId: string, configured: string[], reader: Pick<typeof db, "select"> = db) {
  if (!configured.length) return [];
  const rooms = await reader.select({ id: sessions.channelId }).from(sessions)
    .innerJoin(hubs, eq(sessions.hubId, hubs.id))
    .where(and(eq(sessions.guildId, guildId), eq(hubs.guildId, guildId), inArray(hubs.hubChannelId, configured)));
  return [...new Set([...configured, ...rooms.map(r => r.id)])];
}
