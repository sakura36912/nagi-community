/**
 * Tests that the VoiceStateUpdate "join" handler behaves correctly when
 * openSession returns null (user has opted out of VC tracking).
 *
 * The handler in index.ts for a join event is:
 *
 *   if (newChannelId) {
 *     await openSession(guildId, userId, newChannelId).catch((err) =>
 *       logger.error(`[vc] openSession error user=${userId}`, err),
 *     );
 *   }
 *
 * When openSession returns null (opted-out path) the Promise resolves
 * successfully, so .catch() is never invoked — no error is logged and no
 * follow-up DB calls are made.
 *
 * Covers:
 *   - Handler does NOT log an error when openSession returns null
 *   - Handler does NOT throw when openSession returns null
 *   - closeSessionAndGetDuration is NOT called for the null session
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock functions ─────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  openSession: vi.fn(),
  closeSessionAndGetDuration: vi.fn(),
  loggerError: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
}));

// ─── Mock community lib ───────────────────────────────────────────────────────
vi.mock("../lib/community.js", () => ({
  openSession: mocks.openSession,
  closeSessionAndGetDuration: mocks.closeSessionAndGetDuration,
}));

// ─── Mock logger ──────────────────────────────────────────────────────────────
vi.mock("../lib/logger.js", () => ({
  logger: {
    error: mocks.loggerError,
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
  },
}));

// ─── Import mocked modules ────────────────────────────────────────────────────
import { openSession, closeSessionAndGetDuration } from "../lib/community.js";
import { logger } from "../lib/logger.js";

// ─── Inline handler – mirrors index.ts VoiceStateUpdate join branch exactly ───
//
// We cannot import index.ts because it immediately creates a Discord client,
// logs in, and starts cron jobs. We replicate the exact join branch so the
// tests exercise the same logic the handler executes.

async function simulateVcJoin(
  guildId: string,
  userId: string,
  newChannelId: string | null,
): Promise<void> {
  if (newChannelId) {
    await openSession(guildId, userId, newChannelId).catch((err) =>
      logger.error(`[vc] openSession error user=${userId}`, err),
    );
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("VoiceStateUpdate join handler – opted-out user", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does NOT log an error when openSession returns null (user opted out)", async () => {
    mocks.openSession.mockResolvedValueOnce(null);

    await simulateVcJoin("guild-1", "user-opted-out", "channel-1");

    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it("resolves without throwing when openSession returns null", async () => {
    mocks.openSession.mockResolvedValueOnce(null);

    await expect(
      simulateVcJoin("guild-1", "user-opted-out", "channel-1"),
    ).resolves.toBeUndefined();
  });

  it("does NOT call closeSessionAndGetDuration after a null openSession", async () => {
    mocks.openSession.mockResolvedValueOnce(null);

    await simulateVcJoin("guild-1", "user-opted-out", "channel-1");

    expect(closeSessionAndGetDuration).not.toHaveBeenCalled();
  });

  it("calls openSession with the correct guildId, userId, and channelId", async () => {
    mocks.openSession.mockResolvedValueOnce(null);

    await simulateVcJoin("guild-42", "user-99", "channel-77");

    expect(openSession).toHaveBeenCalledOnce();
    expect(openSession).toHaveBeenCalledWith("guild-42", "user-99", "channel-77");
  });

  // Baseline: verify the non-opted-out path also produces no error
  it("does NOT log an error when openSession returns a valid session (baseline)", async () => {
    const fakeSession = {
      id: 1,
      guildId: "guild-1",
      userId: "user-active",
      channelId: "channel-1",
      joinedAt: new Date(),
      leftAt: null,
    };
    mocks.openSession.mockResolvedValueOnce(fakeSession);

    await simulateVcJoin("guild-1", "user-active", "channel-1");

    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it("does NOT call openSession when newChannelId is null (leave-only event)", async () => {
    await simulateVcJoin("guild-1", "user-1", null);

    expect(openSession).not.toHaveBeenCalled();
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });
});
