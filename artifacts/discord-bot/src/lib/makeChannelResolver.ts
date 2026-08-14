/**
 * makeChannelResolver
 *
 * Builds the `resolveChannel` callback used by validateGuildConfiguredChannels
 * during startup.  Extracted from index.ts so it can be unit-tested in
 * isolation without importing the bot entry-point (which has side effects).
 *
 * Behaviour
 * ─────────
 * • Channel found in cache              → returns true (no network call)
 * • fetch() resolves to a non-null value → returns true (channel exists)
 * • fetch() resolves to null            → returns false (channel not found)
 * • fetch() rejects with DiscordAPIError 10003 (Unknown Channel)
 *                                       → returns false (channel confirmed gone)
 * • fetch() rejects with any other error → re-throws (transient / permission
 *   error) so the caller keeps the configured ID rather than clearing it
 *   on a network blip.
 */

import { DiscordAPIError } from "discord.js";

export function makeChannelResolver(
  guild: { channels: { cache: { has: (id: string) => boolean }; fetch: (id: string) => Promise<unknown> } },
): (channelId: string) => Promise<boolean> {
  return async function resolveChannel(channelId: string): Promise<boolean> {
    if (guild.channels.cache.has(channelId)) return true;
    try {
      const fetched = await guild.channels.fetch(channelId);
      return fetched !== null;
    } catch (err) {
      if (err instanceof DiscordAPIError && err.code === 10003) {
        // Unknown Channel — channel is definitely gone
        return false;
      }
      // Any other error is transient — re-throw so the caller keeps the setting
      throw err;
    }
  };
}
