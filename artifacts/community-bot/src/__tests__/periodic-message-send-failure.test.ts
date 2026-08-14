/**
 * Confirms that a Discord send failure after the optimistic mark does not
 * prevent subsequent due periodic messages from being processed.
 *
 * Scenario:
 *   - Two messages are due.
 *   - Message 1: channel.send throws.
 *   - Message 2: channel.send succeeds.
 *
 * Expected:
 *   - Message 2 is sent regardless of message 1's failure.
 *   - The send error for message 1 is logged via logger.error.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock state ─────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  return {
    loggerError: vi.fn(),
    loggerWarn: vi.fn(),
    loggerInfo: vi.fn(),
  };
});

// ─── Mock logger ──────────────────────────────────────────────────────────────
vi.mock("../lib/logger.js", () => ({
  logger: {
    error: mocks.loggerError,
    warn: mocks.loggerWarn,
    info: mocks.loggerInfo,
  },
}));

// ─── Import after mocks ───────────────────────────────────────────────────────
import { runPeriodicMessages } from "../lib/periodic-message-scheduler.js";
import type { PeriodicMessage } from "@workspace/db";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMessage(id: number, channelId: string): PeriodicMessage {
  return {
    id,
    guildId: "guild-1",
    channelId,
    message: `Test message ${id}`,
    intervalHours: 1,
    enabled: true,
    lastPostedAt: null,
    createdAt: new Date(),
  } as unknown as PeriodicMessage;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("runPeriodicMessages – send failure loop isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("processes message 2 successfully even when message 1's channel.send throws", async () => {
    const msg1 = makeMessage(1, "channel-bad");
    const msg2 = makeMessage(2, "channel-good");

    const sendGood = vi.fn().mockResolvedValue(undefined);
    const sendError = new Error("Missing Access");

    const markPosted = vi.fn().mockResolvedValue(undefined);

    const deps = {
      getDuePeriodicMessages: vi.fn().mockResolvedValue([msg1, msg2]),
      markPeriodicMessagePosted: markPosted,
      resolveTextChannel: vi.fn(async (_guildId: string, channelId: string) => {
        if (channelId === "channel-bad") {
          return { send: vi.fn().mockRejectedValue(sendError) };
        }
        return { send: sendGood };
      }),
    };

    await runPeriodicMessages(deps);

    // Both messages were optimistically marked as posted
    expect(markPosted).toHaveBeenCalledTimes(2);
    expect(markPosted).toHaveBeenCalledWith(1);
    expect(markPosted).toHaveBeenCalledWith(2);

    // Message 2 was sent successfully
    expect(sendGood).toHaveBeenCalledOnce();
    expect(sendGood).toHaveBeenCalledWith(msg2.message);

    // The error for message 1 was logged
    expect(mocks.loggerError).toHaveBeenCalledOnce();
    const [logMsg, logErr] = mocks.loggerError.mock.calls[0]!;
    expect(logMsg).toContain("id=1");
    expect(logErr).toBe(sendError);
  });

  it("logs the send error with the correct message id", async () => {
    const msg = makeMessage(42, "channel-throws");

    const deps = {
      getDuePeriodicMessages: vi.fn().mockResolvedValue([msg]),
      markPeriodicMessagePosted: vi.fn().mockResolvedValue(undefined),
      resolveTextChannel: vi.fn().mockResolvedValue({
        send: vi.fn().mockRejectedValue(new Error("Unknown Channel")),
      }),
    };

    await runPeriodicMessages(deps);

    expect(mocks.loggerError).toHaveBeenCalledOnce();
    const [logMsg] = mocks.loggerError.mock.calls[0]!;
    expect(logMsg).toContain("id=42");
  });
});
