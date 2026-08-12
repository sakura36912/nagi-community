/**
 * Tests for runOrphanVcPrune — the catch-all orphaned VC session prune.
 *
 * Verifies:
 *   (a) A DB failure thrown by pruneOrphans is caught and logged via
 *       logger.error with a message containing "orphan" — it never propagates.
 *   (b) The exception does not propagate out of runOrphanVcPrune so the
 *       nightly scheduler stays alive after a DB blip.
 *   (c) When activeGuildIds is empty, a warning is logged and the prune is
 *       skipped entirely.
 *   (d) When pruneOrphans returns a positive count the result is logged.
 *   (e) When pruneOrphans returns 0 nothing is logged at info level.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Mock the logger so no output escapes to the test runner ─────────────────
vi.mock("../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// ─── Import under test (resolved after mocks) ────────────────────────────────
import { runOrphanVcPrune } from "../lib/vc-prune-scheduler.js";
import { logger } from "../lib/logger.js";

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("runOrphanVcPrune", () => {
  let pruneOrphans: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    pruneOrphans = vi.fn().mockResolvedValue(0);
  });

  it("catches a DB error thrown by pruneOrphans and does not propagate it", async () => {
    pruneOrphans.mockRejectedValue(new Error("DB connection refused"));

    // Must resolve — never throw — so the scheduler loop stays alive.
    await expect(
      runOrphanVcPrune(["guild-1"], pruneOrphans),
    ).resolves.toBeUndefined();
  });

  it("logs the error via logger.error with a message containing 'orphan'", async () => {
    pruneOrphans.mockRejectedValue(new Error("DB timeout"));

    await runOrphanVcPrune(["guild-1"], pruneOrphans);

    expect(logger.error).toHaveBeenCalledOnce();
    const [message] = (logger.error as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(message.toLowerCase()).toContain("orphan");
  });

  it("passes the thrown error object to logger.error as the second argument", async () => {
    const dbError = new Error("Primary key violation");
    pruneOrphans.mockRejectedValue(dbError);

    await runOrphanVcPrune(["guild-1"], pruneOrphans);

    expect(logger.error).toHaveBeenCalledWith(expect.any(String), dbError);
  });

  it("skips the prune and logs a warning when activeGuildIds is empty", async () => {
    await runOrphanVcPrune([], pruneOrphans);

    expect(pruneOrphans).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("calls pruneOrphans with the activeGuildIds and default 180-day retention", async () => {
    await runOrphanVcPrune(["guild-a", "guild-b"], pruneOrphans);

    expect(pruneOrphans).toHaveBeenCalledOnce();
    expect(pruneOrphans).toHaveBeenCalledWith(["guild-a", "guild-b"], 180);
  });

  it("logs an info message when pruneOrphans returns a positive deleted count", async () => {
    pruneOrphans.mockResolvedValue(7);

    await runOrphanVcPrune(["guild-1"], pruneOrphans);

    expect(logger.info).toHaveBeenCalledOnce();
    const [message] = (logger.info as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(message).toContain("7");
    expect(message.toLowerCase()).toContain("orphan");
  });

  it("does not log an info message when pruneOrphans returns 0", async () => {
    pruneOrphans.mockResolvedValue(0);

    await runOrphanVcPrune(["guild-1"], pruneOrphans);

    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("uses the provided retentionDays override instead of 180", async () => {
    await runOrphanVcPrune(["guild-1"], pruneOrphans, 90);

    expect(pruneOrphans).toHaveBeenCalledWith(["guild-1"], 90);
  });
});
