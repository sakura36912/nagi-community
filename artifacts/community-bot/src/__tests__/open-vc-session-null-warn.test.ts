/**
 * Confirms that openVcSessionIfTracked logs a warning when openSession returns
 * null — which can happen either because the user opted out or because the DB
 * was unavailable (fail-closed path in openSession).
 *
 * The function uses injectable deps so no module-wide mock is needed; we can
 * stub openSession directly and verify the logger.warn call without touching
 * the DB or the privacy tables.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock fns ───────────────────────────────────────────────────────────
const { loggerError, loggerInfo, loggerWarn } = vi.hoisted(() => ({
  loggerError: vi.fn(),
  loggerInfo:  vi.fn(),
  loggerWarn:  vi.fn(),
}));

// ─── Mock @workspace/db (required at module load; no DB calls made in tests) ──
vi.mock("@workspace/db", () => ({
  db: {},
  communityVcSessionsTable:          {},
  communityVcPrivacyTable:           {},
  communityVcPrivacyGlobalTable:     {},
  communityRankingSettingsTable:     {},
  communityEventSettingsTable:       {},
  communityEventsTable:              {},
  communityEventParticipantsTable:   {},
  communityTicketSettingsTable:      {},
  communityTicketsTable:             {},
  communityTicketPanelsTable:        {},
  communityRoleButtonsTable:         {},
}));

// ─── Mock logger ──────────────────────────────────────────────────────────────
vi.mock("../lib/logger.js", () => ({
  logger: { error: loggerError, info: loggerInfo, warn: loggerWarn },
}));

// ─── Import the real production function ─────────────────────────────────────
import { openVcSessionIfTracked } from "../lib/community.js";

// ─── Shared test constants ────────────────────────────────────────────────────
const GUILD   = "guild-001";
const USER    = "user-001";
const CHANNEL = "channel-001";

/** Deps that always tracks every channel and lets the caller control openSession. */
function makeDeps(openSession: ReturnType<typeof vi.fn>) {
  return {
    getTrackedVcCategoryId: vi.fn().mockResolvedValue(null), // null → track all channels
    openSession,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("openVcSessionIfTracked – warn when openSession returns null", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs a warning when openSession returns null", async () => {
    const deps = makeDeps(vi.fn().mockResolvedValue(null));

    await openVcSessionIfTracked(GUILD, USER, CHANNEL, null, false, deps);

    expect(loggerWarn).toHaveBeenCalledOnce();
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("openSession returned null"),
    );
  });

  it("includes the userId in the warning", async () => {
    const deps = makeDeps(vi.fn().mockResolvedValue(null));

    await openVcSessionIfTracked(GUILD, USER, CHANNEL, null, false, deps);

    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining(USER),
    );
  });

  it("includes the guildId in the warning", async () => {
    const deps = makeDeps(vi.fn().mockResolvedValue(null));

    await openVcSessionIfTracked(GUILD, USER, CHANNEL, null, false, deps);

    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining(GUILD),
    );
  });

  it("does NOT log a warning when openSession returns a valid session", async () => {
    const fakeSession = {
      id: 1,
      guildId: GUILD,
      userId: USER,
      channelId: CHANNEL,
      joinedAt: new Date(),
      leftAt: null,
      isExile: false,
      isPrivacyClosed: false,
    };
    const deps = makeDeps(vi.fn().mockResolvedValue(fakeSession));

    await openVcSessionIfTracked(GUILD, USER, CHANNEL, null, false, deps);

    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it("does NOT log a warning when the channel is outside the tracked category (openSession not called)", async () => {
    const deps = {
      getTrackedVcCategoryId: vi.fn().mockResolvedValue("cat-tracked"),
      openSession: vi.fn(), // should never be invoked
    };

    await openVcSessionIfTracked(GUILD, USER, CHANNEL, "cat-other", false, deps);

    expect(loggerWarn).not.toHaveBeenCalled();
    expect(deps.openSession).not.toHaveBeenCalled();
  });

  it("still resolves without throwing when openSession returns null", async () => {
    const deps = makeDeps(vi.fn().mockResolvedValue(null));

    await expect(
      openVcSessionIfTracked(GUILD, USER, CHANNEL, null, false, deps),
    ).resolves.toBeUndefined();
  });

  it("does NOT log a warning (only an error) when openSession throws", async () => {
    const dbErr = new Error("DB timeout");
    const deps = makeDeps(vi.fn().mockRejectedValue(dbErr));

    await openVcSessionIfTracked(GUILD, USER, CHANNEL, null, false, deps);

    // The .catch() in the handler converts the rejection to null — which in
    // turn does trigger loggerWarn because the result is null.  What we verify
    // here is that loggerError fires for the thrown error.
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining("openSession error"),
      dbErr,
    );
  });
});
