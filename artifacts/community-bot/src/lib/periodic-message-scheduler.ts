/**
 * Periodic message scheduler helper.
 *
 * Extracted as a standalone function so it can be unit-tested independently
 * of the Discord client and the full index.ts initialisation.
 */

import { logger } from "./logger.js";
import type { PeriodicMessage } from "@workspace/db";

/** Minimal interface for a text channel that can send messages. */
export interface SendableChannel {
  send(message: string): Promise<unknown>;
}

export interface PeriodicMessageSchedulerDeps {
  /** Fetch all enabled periodic messages that are currently due. */
  getDuePeriodicMessages: () => Promise<PeriodicMessage[]>;
  /** Optimistically stamp last_posted_at BEFORE the Discord send. */
  markPeriodicMessagePosted: (id: number) => Promise<void>;
  /**
   * Resolve a sendable text channel by guild and channel id.
   * Returns null when the guild or channel cannot be found, or the channel
   * is not text-based.
   */
  resolveTextChannel: (guildId: string, channelId: string) => Promise<SendableChannel | null>;
}

/**
 * Process all due periodic messages for one scheduler tick.
 *
 * Strategy:
 *  1. Fetch all due messages.  A DB error here is caught and logged; the tick
 *     exits cleanly (no messages to process).
 *  2. For each message, optimistically mark it as posted BEFORE sending.
 *     If the DB write fails the message is skipped and the error is logged.
 *     This prevents double-posts on restart at the cost of a rare missed post.
 *  3. Send the message to Discord.  A send failure is caught and logged; it
 *     does NOT prevent subsequent messages from being processed.
 */
export async function runPeriodicMessages(deps: PeriodicMessageSchedulerDeps): Promise<void> {
  const { getDuePeriodicMessages, markPeriodicMessagePosted, resolveTextChannel } = deps;

  const due = await getDuePeriodicMessages().catch((err) => {
    logger.error("[periodic] Failed to fetch due messages", err);
    return [] as PeriodicMessage[];
  });

  for (const msg of due) {
    // Optimistic update: mark posted BEFORE sending so a bot crash between
    // send and DB write cannot cause a duplicate post on the next startup.
    // If the DB write itself fails we skip the send entirely rather than
    // risk the message being seen as due again on the next tick.
    try {
      await markPeriodicMessagePosted(msg.id);
    } catch (err) {
      logger.error(`[periodic] Failed to mark message id=${msg.id} as posted — skipping send`, err);
      continue;
    }

    try {
      const channel = await resolveTextChannel(msg.guildId, msg.channelId);
      if (!channel) {
        logger.warn(`[periodic] Channel ${msg.channelId} not found or not text-based — skipping message id=${msg.id}`);
        continue;
      }
      await channel.send(msg.message);
      logger.info(`[periodic] Posted message id=${msg.id} to channel ${msg.channelId} in guild ${msg.guildId}`);
    } catch (err) {
      logger.error(`[periodic] Failed to post message id=${msg.id}`, err);
    }
  }
}
