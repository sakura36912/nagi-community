/**
 * Confirms that the VoiceStateUpdate "leave" handler stays silent when
 * openSession previously returned null due to a DB error.
 *
 * Scenario:
 *   1. A user joins a VC.  openSession is called but the privacy-check DB
 *      query rejects, so openSession returns null — no session row is created.
 *   2. The user then leaves the VC.  handleVoiceStateUpdate calls
 *      closeSessionAndGetDuration, which finds no open session and returns null.
 *   3. The handler must NOT log an error and must NOT throw — the leave path
 *      must be as resilient as the join path.
 *
 * This tests the production handler (handleVoiceStateUpdate from
 * lib/vc-session-handler.ts) with its community-lib and logger dependencies
 * replaced by mocks, following the pattern from vc-join-handler-opt-out.test.ts.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock functions ─────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  closeSessionAndGetDuration: vi.fn(),
  openVcSessionIfTracked: vi.fn(),
  loggerError: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
}));

// ─── Mock community lib ───────────────────────────────────────────────────────
vi.mock("../lib/community.js", () => ({
  closeSessionAndGetDuration: mocks.closeSessionAndGetDuration,
  openVcSessionIfTracked: mocks.openVcSessionIfTracked,
}));

// ─── Mock logger ──────────────────────────────────────────────────────────────
vi.mock("../lib/logger.js", () => ({
  logger: {
    error: mocks.loggerError,
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
  },
}));

// ─── Mock vc-exile (resolveIsExile) ───────────────────────────────────────────
vi.mock("../lib/vc-exile.js", () => ({
  resolveIsExile: vi.fn().mockReturnValue(false),
}));

// ─── Import the production handler after all mocks are in place ───────────────
import { handleVoiceStateUpdate } from "../lib/vc-session-handler.js";

// ─── Constants ────────────────────────────────────────────────────────────────
const GUILD       = "guild-leave-db-err";
const USER        = "user-leave-db-err";
const OLD_CHANNEL = "channel-old-001";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("handleVoiceStateUpdate leave – openSession previously returned null (DB error)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does NOT log an error when closeSessionAndGetDuration returns null (no open session)", async () => {
    // openSession returned null earlier (DB error) → no session row exists.
    // closeSessionAndGetDuration therefore finds nothing and resolves to null.
    mocks.closeSessionAndGetDuration.mockResolvedValueOnce(null);

    await handleVoiceStateUpdate({
      guildId: GUILD,
      userId: USER,
      oldChannelId: OLD_CHANNEL,
      newChannelId: null,
      channelParentId: null,
      member: null,
    });

    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it("resolves without throwing when closeSessionAndGetDuration returns null", async () => {
    mocks.closeSessionAndGetDuration.mockResolvedValueOnce(null);

    await expect(
      handleVoiceStateUpdate({
        guildId: GUILD,
        userId: USER,
        oldChannelId: OLD_CHANNEL,
        newChannelId: null,
        channelParentId: null,
        member: null,
      }),
    ).resolves.toBeUndefined();
  });


  it("calls closeSessionAndGetDuration with the correct guildId and userId", async () => {
    mocks.closeSessionAndGetDuration.mockResolvedValueOnce(null);

    await handleVoiceStateUpdate({
      guildId: GUILD,
      userId: USER,
      oldChannelId: OLD_CHANNEL,
      newChannelId: null,
      channelParentId: null,
      member: null,
    });

    expect(mocks.closeSessionAndGetDuration).toHaveBeenCalledOnce();
    expect(mocks.closeSessionAndGetDuration).toHaveBeenCalledWith(GUILD, USER);
  });

  it("does NOT call openVcSessionIfTracked on a pure leave (newChannelId is null)", async () => {
    mocks.closeSessionAndGetDuration.mockResolvedValueOnce(null);

    await handleVoiceStateUpdate({
      guildId: GUILD,
      userId: USER,
      oldChannelId: OLD_CHANNEL,
      newChannelId: null,
      channelParentId: null,
      member: null,
    });

    expect(mocks.openVcSessionIfTracked).not.toHaveBeenCalled();
  });

  it("does NOT log a warning when closeSessionAndGetDuration returns null", async () => {
    // A null return from closeSessionAndGetDuration is an expected, silent no-op.
    // No warning should be emitted for this case.
    mocks.closeSessionAndGetDuration.mockResolvedValueOnce(null);

    await handleVoiceStateUpdate({
      guildId: GUILD,
      userId: USER,
      oldChannelId: OLD_CHANNEL,
      newChannelId: null,
      channelParentId: null,
      member: null,
    });

    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });
});
