/**
 * Tests that the VoiceStateUpdate join handler fails CLOSED when
 * getTrackedVcCategoryId throws.
 *
 * The updated handler (index.ts VoiceStateUpdate join branch):
 *
 *   let trackedCategoryId: string | null;
 *   try {
 *     trackedCategoryId = await getTrackedVcCategoryId(guildId);
 *   } catch (err) {
 *     logger.error(`[vc] getTrackedVcCategoryId error …`, err);
 *     return; // fail closed
 *   }
 *   const isTracked = !trackedCategoryId || channelParentId === trackedCategoryId;
 *   if (isTracked) { await openSession(…); }
 *
 * When getTrackedVcCategoryId fails the handler must NOT call openSession —
 * it must not silently fall back to "track every channel" (null = no restriction).
 *
 * Covers:
 *   - getTrackedVcCategoryId error → openSession is NOT called (fail closed)
 *   - getTrackedVcCategoryId error → logger.error IS called
 *   - null result (no restriction configured) → openSession IS called
 *   - non-null result matching parentId → openSession IS called
 *   - non-null result NOT matching parentId → openSession is NOT called
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock functions ─────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  openSession:              vi.fn().mockResolvedValue(null),
  getTrackedVcCategoryId:   vi.fn<() => Promise<string | null>>(),
  loggerError:              vi.fn(),
  loggerInfo:               vi.fn(),
  loggerWarn:               vi.fn(),
}));

// ─── Mock community lib ───────────────────────────────────────────────────────
vi.mock("../lib/community.js", () => ({
  openSession:              mocks.openSession,
  getTrackedVcCategoryId:   mocks.getTrackedVcCategoryId,
  // Stubs for other exports referenced by index.ts
  closeSessionAndGetDuration: vi.fn().mockResolvedValue(null),
}));

// ─── Mock logger ──────────────────────────────────────────────────────────────
vi.mock("../lib/logger.js", () => ({
  logger: {
    error: mocks.loggerError,
    info:  mocks.loggerInfo,
    warn:  mocks.loggerWarn,
  },
}));

// ─── Inline handler – mirrors index.ts VoiceStateUpdate join branch exactly ───
//
// We cannot import index.ts because it creates a Discord client, logs in,
// and starts cron jobs on module load.  We replicate the exact join branch so
// the tests exercise the same logic the handler executes.

import { openSession, getTrackedVcCategoryId } from "../lib/community.js";
import { logger } from "../lib/logger.js";

async function simulateVcJoin(opts: {
  guildId: string;
  userId: string;
  newChannelId: string | null;
  channelParentId?: string | null;
}): Promise<void> {
  const { guildId, userId, newChannelId, channelParentId = null } = opts;

  if (newChannelId) {
    // Fail closed: if the tracked-category setting cannot be read we must not
    // assume "track everything" (null = no restriction).
    let trackedCategoryId: string | null;
    try {
      trackedCategoryId = await getTrackedVcCategoryId(guildId);
    } catch (err) {
      logger.error(`[vc] getTrackedVcCategoryId error guildId=${guildId} user=${userId}`, err);
      return;
    }
    const isTracked = !trackedCategoryId || channelParentId === trackedCategoryId;
    if (isTracked) {
      await openSession(guildId, userId, newChannelId).catch((err: unknown) =>
        logger.error(`[vc] openSession error user=${userId}`, err),
      );
    }
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("VoiceStateUpdate join handler – tracked-category fail-closed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does NOT call openSession when getTrackedVcCategoryId throws (fail closed)", async () => {
    mocks.getTrackedVcCategoryId.mockRejectedValueOnce(new Error("DB timeout"));

    await simulateVcJoin({ guildId: "guild-1", userId: "user-1", newChannelId: "ch-1" });

    expect(mocks.openSession).not.toHaveBeenCalled();
  });

  it("logs the error when getTrackedVcCategoryId throws", async () => {
    const dbError = new Error("connection lost");
    mocks.getTrackedVcCategoryId.mockRejectedValueOnce(dbError);

    await simulateVcJoin({ guildId: "guild-1", userId: "user-1", newChannelId: "ch-1" });

    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("getTrackedVcCategoryId"),
      dbError,
    );
  });

  it("does NOT throw when getTrackedVcCategoryId rejects", async () => {
    mocks.getTrackedVcCategoryId.mockRejectedValueOnce(new Error("oops"));

    await expect(
      simulateVcJoin({ guildId: "guild-1", userId: "user-1", newChannelId: "ch-1" }),
    ).resolves.toBeUndefined();
  });

  it("calls openSession when no category is configured (null → track all)", async () => {
    mocks.getTrackedVcCategoryId.mockResolvedValueOnce(null);

    await simulateVcJoin({
      guildId: "guild-1", userId: "user-1", newChannelId: "ch-1", channelParentId: "cat-A",
    });

    expect(mocks.openSession).toHaveBeenCalledWith("guild-1", "user-1", "ch-1");
  });

  it("calls openSession when the channel is inside the configured category", async () => {
    mocks.getTrackedVcCategoryId.mockResolvedValueOnce("cat-A");

    await simulateVcJoin({
      guildId: "guild-1", userId: "user-1", newChannelId: "ch-1", channelParentId: "cat-A",
    });

    expect(mocks.openSession).toHaveBeenCalledWith("guild-1", "user-1", "ch-1");
  });

  it("does NOT call openSession when the channel is outside the configured category", async () => {
    mocks.getTrackedVcCategoryId.mockResolvedValueOnce("cat-A");

    await simulateVcJoin({
      guildId: "guild-1", userId: "user-1", newChannelId: "ch-1", channelParentId: "cat-B",
    });

    expect(mocks.openSession).not.toHaveBeenCalled();
  });

  it("does NOT call openSession when newChannelId is null (leave-only event)", async () => {
    await simulateVcJoin({ guildId: "guild-1", userId: "user-1", newChannelId: null });

    expect(mocks.getTrackedVcCategoryId).not.toHaveBeenCalled();
    expect(mocks.openSession).not.toHaveBeenCalled();
  });
});
