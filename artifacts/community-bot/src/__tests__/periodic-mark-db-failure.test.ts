/**
 * Tests that runPeriodicMessages skips the Discord send and logs the error
 * when markPeriodicMessagePosted throws (optimistic DB write failure).
 *
 * The relevant branch in lib/periodic-message-scheduler.ts:
 *
 *   try {
 *     await markPeriodicMessagePosted(msg.id);
 *   } catch (err) {
 *     logger.error(`[periodic] Failed to mark message id=${msg.id} as posted — skipping send`, err);
 *     continue;
 *   }
 *   // ... channel.send(msg.message)
 *
 * These tests import and invoke the REAL runPeriodicMessages production
 * function and inject stubbed dependencies, so a regression in the actual
 * implementation will be caught.
 *
 * Covers:
 *   - markPeriodicMessagePosted throws → channel.send is NOT called
 *   - markPeriodicMessagePosted throws → logger.error IS called with [periodic] prefix
 *   - markPeriodicMessagePosted throws → error message references the failing message id
 *   - markPeriodicMessagePosted throws for one message → subsequent messages still processed
 *   - markPeriodicMessagePosted succeeds → channel.send IS called normally
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Mock logger ──────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  loggerError: vi.fn(),
  loggerInfo:  vi.fn(),
  loggerWarn:  vi.fn(),
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    error: mocks.loggerError,
    info:  mocks.loggerInfo,
    warn:  mocks.loggerWarn,
  },
}));

// ─── Import the REAL production function ─────────────────────────────────────
import { runPeriodicMessages } from "../lib/periodic-message-scheduler.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const GUILD_ID   = "guild-1";
const CHANNEL_ID = "ch-1";

function makeMsg(id: number, overrides?: Partial<{ guildId: string; channelId: string; message: string }>) {
  return {
    id,
    guildId:       overrides?.guildId   ?? GUILD_ID,
    channelId:     overrides?.channelId ?? CHANNEL_ID,
    message:       overrides?.message   ?? `message-${id}`,
    // DB-level fields not used by the scheduler logic:
    intervalHours: 24,
    lastPostedAt:  null,
    enabled:       true,
    createdAt:     new Date(),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("runPeriodicMessages — optimistic DB mark failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does NOT call channel.send when markPeriodicMessagePosted throws", async () => {
    const channelSend = vi.fn().mockResolvedValue(undefined);

    await runPeriodicMessages({
      getDuePeriodicMessages:    vi.fn().mockResolvedValue([makeMsg(1)]),
      markPeriodicMessagePosted: vi.fn().mockRejectedValue(new Error("DB timeout")),
      resolveTextChannel:        vi.fn().mockResolvedValue({ send: channelSend }),
    });

    expect(channelSend).not.toHaveBeenCalled();
  });

  it("logs the error via the [periodic] logger when markPeriodicMessagePosted throws", async () => {
    const dbError = new Error("connection lost");

    await runPeriodicMessages({
      getDuePeriodicMessages:    vi.fn().mockResolvedValue([makeMsg(42)]),
      markPeriodicMessagePosted: vi.fn().mockRejectedValue(dbError),
      resolveTextChannel:        vi.fn().mockResolvedValue({ send: vi.fn() }),
    });

    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("[periodic]"),
      dbError,
    );
  });

  it("error log message references the failing message id", async () => {
    const dbError = new Error("write failed");

    await runPeriodicMessages({
      getDuePeriodicMessages:    vi.fn().mockResolvedValue([makeMsg(7)]),
      markPeriodicMessagePosted: vi.fn().mockRejectedValue(dbError),
      resolveTextChannel:        vi.fn().mockResolvedValue({ send: vi.fn() }),
    });

    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("id=7"),
      dbError,
    );
  });

  it("continues processing subsequent messages after a DB failure on one", async () => {
    const channelSend = vi.fn().mockResolvedValue(undefined);

    await runPeriodicMessages({
      getDuePeriodicMessages: vi.fn().mockResolvedValue([
        makeMsg(1, { message: "first" }),
        makeMsg(2, { message: "second" }),
      ]),
      markPeriodicMessagePosted: vi.fn()
        .mockRejectedValueOnce(new Error("DB error"))  // msg 1 fails
        .mockResolvedValueOnce(undefined),              // msg 2 succeeds
      resolveTextChannel: vi.fn().mockResolvedValue({ send: channelSend }),
    });

    // Only the second message's send should have been called.
    expect(channelSend).toHaveBeenCalledTimes(1);
    expect(channelSend).toHaveBeenCalledWith("second");
  });

  it("calls channel.send when markPeriodicMessagePosted succeeds", async () => {
    const channelSend = vi.fn().mockResolvedValue(undefined);

    await runPeriodicMessages({
      getDuePeriodicMessages:    vi.fn().mockResolvedValue([makeMsg(5, { message: "world" })]),
      markPeriodicMessagePosted: vi.fn().mockResolvedValue(undefined),
      resolveTextChannel:        vi.fn().mockResolvedValue({ send: channelSend }),
    });

    expect(channelSend).toHaveBeenCalledWith("world");
  });
});
