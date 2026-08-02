/**
 * Per-guild VC session pruning scheduler helper.
 *
 * Extracted as a standalone function so it can be unit-tested independently
 * of the Discord client and the full index.ts initialisation.
 */

import { logger } from "./logger.js";

/**
 * For every guild in `guildIds`, fetches that guild's configured retention
 * window via `getRetentionDays` and then prunes its VC sessions via
 * `pruneGuild`.
 *
 * This is the per-guild half of `runVcSessionPrune` in index.ts, separated
 * so tests can stub the two community functions without booting the Discord
 * client.
 */
export async function runPerGuildVcPrune(
  guildIds: string[],
  getRetentionDays: (guildId: string) => Promise<number>,
  pruneGuild: (guildId: string, retentionDays: number) => Promise<number>,
): Promise<void> {
  for (const guildId of guildIds) {
    try {
      const retentionDays = await getRetentionDays(guildId);
      const deleted = await pruneGuild(guildId, retentionDays);
      if (deleted > 0) {
        logger.info(
          `[vc/prune] Pruned ${deleted} old VC session(s) for guild ${guildId} (>${retentionDays} days)`,
        );
      }
    } catch (err) {
      logger.error(`[vc/prune] Failed to prune VC sessions for guild ${guildId}`, err);
    }
  }
}
