import { extendSchedule, saveSchedule } from "./vc";
import type { VcSchedule } from "@workspace/db";
import { logger } from "./logger";

/**
 * Extend the VC schedule row for a channel, recovering gracefully when no row
 * exists.
 *
 * `extendSchedule` returns null when the row has already been removed (e.g.
 * the expiry or delete scheduler ran before the user's extension command was
 * processed). In that case a fresh row is created via `saveSchedule` so the
 * pre-expiry warning DM will still fire at the correct time.
 *
 * @param channelId    Discord voice-channel ID.
 * @param guildId      Discord guild ID.
 * @param newExpiresAt Updated expiry deadline.
 * @param fallbackName Channel name to record in the new row.  Callers should
 *                     resolve this from the Discord guild cache before calling;
 *                     passing `channelId` is a safe fallback when the channel
 *                     object is unavailable.
 * @param userId       Owner's Discord user ID (may be undefined).
 * @param logPrefix    Log tag, e.g. "vc-extend" or "vc-panel", written in
 *                     square brackets so log lines are easily searchable.
 * @returns The updated schedule row, or null if no row existed (fallback
 *          row creation is attempted asynchronously in that case).
 */
export async function extendOrRepairVcSchedule(opts: {
  channelId: string;
  guildId: string;
  newExpiresAt: Date;
  fallbackName: string;
  userId: string | undefined;
  logPrefix: string;
}): Promise<VcSchedule | null> {
  const { channelId, guildId, newExpiresAt, fallbackName, userId, logPrefix } = opts;

  const scheduleRow = await extendSchedule(channelId, newExpiresAt).catch((err: unknown) => {
    logger.error(`[${logPrefix}] Failed to update schedule for channel ${channelId}`, err);
    return null;
  });

  if (!scheduleRow) {
    // extendSchedule returned null — no row existed (e.g. bot restarted
    // before saveSchedule ran, or the expiry scheduler already removed it).
    // Create one now so the pre-expiry warning DM will still fire.
    logger.warn(`[${logPrefix}] No schedule row found for channel ${channelId}; creating fallback row`);
    saveSchedule(guildId, channelId, fallbackName, newExpiresAt, userId).catch((err: unknown) =>
      logger.error(`[${logPrefix}] Fallback saveSchedule also failed for channel ${channelId}`, err),
    );
  }

  return scheduleRow ?? null;
}
