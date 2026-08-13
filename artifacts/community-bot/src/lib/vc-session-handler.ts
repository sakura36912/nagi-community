/**
 * Production VoiceStateUpdate handler logic, extracted so it can be imported
 * and tested independently without starting the Discord client.
 *
 * The handler in index.ts delegates entirely to handleVoiceStateUpdate after
 * extracting the primitive values it needs from the Discord.js state objects.
 */

import { closeSessionAndGetDuration, openVcSessionIfTracked } from "./community.js";
import { logger } from "./logger.js";
import { resolveIsExile, type ExileCheckMember } from "./vc-exile.js";
import { awardVcTime } from "./points.js";

export interface VoiceStateUpdateParams {
  guildId: string;
  userId: string;
  oldChannelId: string | null;
  newChannelId: string | null;
  /** parentId of the destination channel (null if absent or no parent). */
  channelParentId: string | null;
  /** GuildMember-like object used to resolve the exile flag (null/undefined = safe fallback). */
  member: ExileCheckMember | null | undefined;
}

/**
 * Core logic of the VoiceStateUpdate event handler.
 *
 * Closes the session on the source channel (when present), then opens a new
 * session on the destination channel (when present) with the correct isExile
 * flag derived from the member's current roles.
 *
 * Covers join (oldChannelId=null), leave (newChannelId=null), and move
 * (both set) events.  When oldChannelId === newChannelId the call is a
 * no-op (mute/deaf change — nothing VC-session-related changed).
 */
export async function handleVoiceStateUpdate(
  params: VoiceStateUpdateParams,
): Promise<void> {
  const { guildId, userId, oldChannelId, newChannelId, channelParentId, member } = params;

  // Nothing VC-related changed (mute/deaf/streaming state update).
  if (oldChannelId === newChannelId) return;

  // ── Close old session ──────────────────────────────────────────────────────
  if (oldChannelId) {
    const duration = await closeSessionAndGetDuration(guildId, userId).catch((err: unknown) => {
      logger.error(`[vc] closeSession error user=${userId}`, err);
      return null;
    });
    if (duration !== null && duration > 0) {
      awardVcTime(guildId, userId, duration).catch((err: unknown) =>
        logger.error(`[point] awardVcTime error user=${userId}`, err),
      );
    }
  }

  // ── Open new session with exile flag ────────────────────────────────────────
  if (newChannelId) {
    const isExile = resolveIsExile(member);
    await openVcSessionIfTracked(guildId, userId, newChannelId, channelParentId, isExile);
  }
}
