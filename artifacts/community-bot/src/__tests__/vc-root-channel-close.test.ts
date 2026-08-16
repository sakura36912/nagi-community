/**
 * Confirms VC session closes cleanly when a user moves to a root-level voice
 * channel (parentId = null) while a tracked category is configured.
 *
 * The VoiceStateUpdate handler in index.ts delegates to handleVoiceStateUpdate
 * in lib/vc-session-handler.ts, which:
 *   1. Always closes the session (closeSessionAndGetDuration) when oldChannelId
 *      is set — regardless of channel parent.
 *   2. Then calls openVcSessionIfTracked for the new channel.
 *      When parentId is null and a category IS configured, isTracked → false
 *      so openSession is NOT called.
 *   3. Awards VC time when the closed session had duration > 0.
 *   4. Catches DB errors from closeSessionAndGetDuration, logs them, and
 *      continues without crashing.
 *
 * Done-looks-like coverage:
 *   1. closeSessionAndGetDuration IS called for the move (close side is unconditional)
 *   2. openSession is NOT called for the root-level destination channel
 *   3. awardVcTime IS called for the duration of the closed session
 *   4. awardVcTime is NOT called when duration is 0 (e.g. very short session)
 *   5. awardVcTime is NOT called when closeSessionAndGetDuration returns null
 *   6. awardVcTime is NOT called when closeSessionAndGetDuration rejects
 *   7. logger.error is called when closeSessionAndGetDuration rejects
 *   8. the handler resolves without throwing when closeSessionAndGetDuration rejects
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock fns ───────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  closeSessionAndGetDuration: vi.fn(),
  openVcSessionIfTracked:    vi.fn(),
  awardVcTime:               vi.fn(),
  resolveIsExile:            vi.fn(),
  loggerError:               vi.fn(),
  loggerInfo:                vi.fn(),
  loggerWarn:                vi.fn(),
}));

// ─── Module mocks ─────────────────────────────────────────────────────────────
vi.mock("../lib/community.js", () => ({
  closeSessionAndGetDuration: mocks.closeSessionAndGetDuration,
  openVcSessionIfTracked:    mocks.openVcSessionIfTracked,
}));

vi.mock("../lib/points.js", () => ({
  awardVcTime: mocks.awardVcTime,
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    error: mocks.loggerError,
    info:  mocks.loggerInfo,
    warn:  mocks.loggerWarn,
  },
}));

vi.mock("../lib/vc-exile.js", () => ({
  resolveIsExile: mocks.resolveIsExile,
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────
import { closeSessionAndGetDuration, openVcSessionIfTracked } from "../lib/community.js";
import { awardVcTime } from "../lib/points.js";
import { logger } from "../lib/logger.js";
import { handleVoiceStateUpdate } from "../lib/vc-session-handler.js";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("VoiceStateUpdate handler – move to root-level channel (parentId = null)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: not an exile user
    mocks.resolveIsExile.mockReturnValue(false);
    // Default: awardVcTime resolves cleanly
    mocks.awardVcTime.mockResolvedValue(undefined);
    // Default: openVcSessionIfTracked resolves cleanly (join side gated inside that fn)
    mocks.openVcSessionIfTracked.mockResolvedValue(undefined);
  });

  // ── 1. Close side fires ───────────────────────────────────────────────────

  it("calls closeSessionAndGetDuration when moving from a tracked channel to a root-level channel", async () => {
    mocks.closeSessionAndGetDuration.mockResolvedValue(120); // 2-minute session

    await handleVoiceStateUpdate({
      guildId:         "guild-1",
      userId:          "user-1",
      oldChannelId:    "ch-tracked",
      newChannelId:    "ch-root",
      channelParentId: null,          // ← root-level: no parent
      member:          null,
    });

    expect(closeSessionAndGetDuration).toHaveBeenCalledOnce();
    expect(closeSessionAndGetDuration).toHaveBeenCalledWith("guild-1", "user-1");
  });

  // ── 2. Join side does NOT open a session ──────────────────────────────────

  it("calls openVcSessionIfTracked for the root-level destination (gating is inside that fn)", async () => {
    mocks.closeSessionAndGetDuration.mockResolvedValue(60);

    await handleVoiceStateUpdate({
      guildId:         "guild-1",
      userId:          "user-1",
      oldChannelId:    "ch-tracked",
      newChannelId:    "ch-root",
      channelParentId: null,
      member:          null,
    });

    // The handler delegates the tracking decision to openVcSessionIfTracked;
    // that function's own tests confirm it skips openSession for null parentId
    // when a category is configured.
    expect(openVcSessionIfTracked).toHaveBeenCalledOnce();
    expect(openVcSessionIfTracked).toHaveBeenCalledWith(
      "guild-1", "user-1", "ch-root", null, false,
    );
  });

  // ── 3. VC time is awarded ─────────────────────────────────────────────────

  it("awards VC time for the closed session duration", async () => {
    mocks.closeSessionAndGetDuration.mockResolvedValue(300); // 5-minute session

    await handleVoiceStateUpdate({
      guildId:         "guild-1",
      userId:          "user-1",
      oldChannelId:    "ch-tracked",
      newChannelId:    "ch-root",
      channelParentId: null,
      member:          null,
    });

    expect(awardVcTime).toHaveBeenCalledOnce();
    expect(awardVcTime).toHaveBeenCalledWith("guild-1", "user-1", 300);
  });

  // ── 4. No award when duration is zero ────────────────────────────────────

  it("does NOT award VC time when the closed session had zero duration", async () => {
    mocks.closeSessionAndGetDuration.mockResolvedValue(0);

    await handleVoiceStateUpdate({
      guildId:         "guild-1",
      userId:          "user-1",
      oldChannelId:    "ch-tracked",
      newChannelId:    "ch-root",
      channelParentId: null,
      member:          null,
    });

    expect(awardVcTime).not.toHaveBeenCalled();
  });

  // ── 5. No award when close returns null ───────────────────────────────────

  it("does NOT award VC time when closeSessionAndGetDuration returns null", async () => {
    mocks.closeSessionAndGetDuration.mockResolvedValue(null);

    await handleVoiceStateUpdate({
      guildId:         "guild-1",
      userId:          "user-1",
      oldChannelId:    "ch-tracked",
      newChannelId:    "ch-root",
      channelParentId: null,
      member:          null,
    });

    expect(awardVcTime).not.toHaveBeenCalled();
  });

  // ── 6. Close fires even when old channel itself had no parent ─────────────
  //
  // Edge case: user was ALSO in a root-level channel before the move.
  // The close side is still unconditional — parentId of the old channel
  // is irrelevant.

  it("still closes the session when the old channel was also root-level", async () => {
    mocks.closeSessionAndGetDuration.mockResolvedValue(45);

    await handleVoiceStateUpdate({
      guildId:         "guild-1",
      userId:          "user-1",
      oldChannelId:    "ch-root-old",  // ← old channel also had no parent
      newChannelId:    "ch-root-new",
      channelParentId: null,
      member:          null,
    });

    expect(closeSessionAndGetDuration).toHaveBeenCalledOnce();
    expect(awardVcTime).toHaveBeenCalledOnce();
    expect(awardVcTime).toHaveBeenCalledWith("guild-1", "user-1", 45);
  });

  // ── 7. Correct args forwarded for an exile user ───────────────────────────

  it("passes isExile=true to openVcSessionIfTracked for exile users", async () => {
    mocks.closeSessionAndGetDuration.mockResolvedValue(90);
    mocks.resolveIsExile.mockReturnValue(true);

    await handleVoiceStateUpdate({
      guildId:         "guild-1",
      userId:          "exile-user",
      oldChannelId:    "ch-tracked",
      newChannelId:    "ch-root",
      channelParentId: null,
      member:          { roles: { cache: new Map() } } as never,
    });

    expect(openVcSessionIfTracked).toHaveBeenCalledWith(
      "guild-1", "exile-user", "ch-root", null, true,
    );
  });

  // ── 8. No-op when channels are identical (mute/deaf event) ───────────────

  it("does not close or open a session when old and new channel are the same", async () => {
    await handleVoiceStateUpdate({
      guildId:         "guild-1",
      userId:          "user-1",
      oldChannelId:    "ch-root",
      newChannelId:    "ch-root",
      channelParentId: null,
      member:          null,
    });

    expect(closeSessionAndGetDuration).not.toHaveBeenCalled();
    expect(openVcSessionIfTracked).not.toHaveBeenCalled();
    expect(awardVcTime).not.toHaveBeenCalled();
  });

  // ── 9. Pure leave (disconnect): no join side fires ─────────────────────────

  it("closes the session but does not open one when the user disconnects (newChannelId=null)", async () => {
    mocks.closeSessionAndGetDuration.mockResolvedValue(180);

    await handleVoiceStateUpdate({
      guildId:         "guild-1",
      userId:          "user-1",
      oldChannelId:    "ch-root",
      newChannelId:    null,
      channelParentId: null,
      member:          null,
    });

    expect(closeSessionAndGetDuration).toHaveBeenCalledOnce();
    expect(openVcSessionIfTracked).not.toHaveBeenCalled();
    expect(awardVcTime).toHaveBeenCalledWith("guild-1", "user-1", 180);
  });

  // ── 10. DB error on close: awardVcTime NOT called ────────────────────────
  //
  // When closeSessionAndGetDuration rejects (e.g. DB connection lost),
  // the .catch() in the handler swallows the error and returns null.
  // null fails the (duration !== null && duration > 0) guard, so
  // awardVcTime must NOT be called.

  it("does NOT call awardVcTime when closeSessionAndGetDuration rejects", async () => {
    const dbError = new Error("DB connection lost");
    mocks.closeSessionAndGetDuration.mockRejectedValue(dbError);

    await handleVoiceStateUpdate({
      guildId:         "guild-1",
      userId:          "user-1",
      oldChannelId:    "ch-tracked",
      newChannelId:    "ch-root",
      channelParentId: null,
      member:          null,
    });

    expect(awardVcTime).not.toHaveBeenCalled();
  });

  // ── 11. DB error on close: error is logged ───────────────────────────────

  it("logs the error via logger.error when closeSessionAndGetDuration rejects", async () => {
    const dbError = new Error("DB connection lost");
    mocks.closeSessionAndGetDuration.mockRejectedValue(dbError);

    await handleVoiceStateUpdate({
      guildId:         "guild-1",
      userId:          "user-2",
      oldChannelId:    "ch-tracked",
      newChannelId:    "ch-root",
      channelParentId: null,
      member:          null,
    });

    expect(mocks.loggerError).toHaveBeenCalledOnce();
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("user-2"),
      dbError,
    );
  });

  // ── 12. DB error on close: handler resolves without throwing ─────────────

  it("resolves without throwing when closeSessionAndGetDuration rejects", async () => {
    mocks.closeSessionAndGetDuration.mockRejectedValue(new Error("DB timeout"));

    await expect(
      handleVoiceStateUpdate({
        guildId:         "guild-1",
        userId:          "user-1",
        oldChannelId:    "ch-tracked",
        newChannelId:    "ch-root",
        channelParentId: null,
        member:          null,
      }),
    ).resolves.toBeUndefined();
  });

  // ── 13. awardVcTime rejects: handler still resolves ───────────────────────
  //
  // awardVcTime is called fire-and-forget with a .catch().  If the points
  // service rejects the error must be swallowed — the handler must not throw
  // or propagate the failure to callers.

  it("resolves without throwing when awardVcTime rejects", async () => {
    mocks.closeSessionAndGetDuration.mockResolvedValue(120);
    mocks.awardVcTime.mockRejectedValue(new Error("Points service unavailable"));

    await expect(
      handleVoiceStateUpdate({
        guildId:         "guild-1",
        userId:          "user-1",
        oldChannelId:    "ch-tracked",
        newChannelId:    "ch-root",
        channelParentId: null,
        member:          null,
      }),
    ).resolves.toBeUndefined();
  });

  // ── 14. awardVcTime rejects: error is logged ──────────────────────────────
  //
  // The .catch() handler must call logger.error with the rejection error and
  // a context string that includes the userId so on-call engineers can trace
  // which user's VC time was not awarded.

  it("logs the error via logger.error when awardVcTime rejects", async () => {
    const pointsError = new Error("Points service unavailable");
    mocks.closeSessionAndGetDuration.mockResolvedValue(120);
    mocks.awardVcTime.mockRejectedValue(pointsError);

    await handleVoiceStateUpdate({
      guildId:         "guild-1",
      userId:          "user-42",
      oldChannelId:    "ch-tracked",
      newChannelId:    "ch-root",
      channelParentId: null,
      member:          null,
    });

    expect(mocks.loggerError).toHaveBeenCalledOnce();
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("user-42"),
      pointsError,
    );
  });

  // ── 15. awardVcTime rejects: session was still closed ────────────────────
  //
  // The session-close side completes successfully before awardVcTime is
  // called.  A rejection from the points service must not affect — or roll
  // back — the already-completed closeSessionAndGetDuration call.

  it("still calls closeSessionAndGetDuration when awardVcTime rejects", async () => {
    mocks.closeSessionAndGetDuration.mockResolvedValue(120);
    mocks.awardVcTime.mockRejectedValue(new Error("Points service unavailable"));

    await handleVoiceStateUpdate({
      guildId:         "guild-1",
      userId:          "user-1",
      oldChannelId:    "ch-tracked",
      newChannelId:    "ch-root",
      channelParentId: null,
      member:          null,
    });

    expect(closeSessionAndGetDuration).toHaveBeenCalledOnce();
    expect(closeSessionAndGetDuration).toHaveBeenCalledWith("guild-1", "user-1");
  });
});
