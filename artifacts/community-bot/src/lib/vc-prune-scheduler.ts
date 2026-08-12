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

/**
 * Runs the catch-all orphan VC session prune for guilds the bot has left.
 *
 * Extracted from `runVcSessionPrune` in index.ts so it can be unit-tested
 * without booting the Discord client.
 *
 * Skips the prune entirely when `activeGuildIds` is empty (guard against
 * accidental mass-deletion if the guild cache hasn't populated yet).
 * Any error thrown by `pruneOrphans` is caught and logged — it must never
 * propagate so the nightly scheduler stays alive.
 */
export async function runOrphanVcPrune(
  activeGuildIds: string[],
  pruneOrphans: (activeGuildIds: string[], retentionDays: number) => Promise<number>,
  retentionDays = 180,
): Promise<void> {
  try {
    if (activeGuildIds.length === 0) {
      logger.warn(
        "[vc/prune] Skipping orphaned VC session prune — active guild list is empty. " +
        "This may indicate the guild cache has not yet populated or a guild-fetch error was swallowed. " +
        "Pruning is deferred to the next scheduled run to prevent accidental mass data loss.",
      );
      return;
    }
    const deleted = await pruneOrphans(activeGuildIds, retentionDays);
    if (deleted > 0) {
      logger.info(`[vc/prune] Pruned ${deleted} orphaned VC session(s) (>${retentionDays} days, bot-left guilds only)`);
    }
  } catch (err) {
    logger.error("[vc/prune] Failed to run orphan VC session prune", err);
  }
}
