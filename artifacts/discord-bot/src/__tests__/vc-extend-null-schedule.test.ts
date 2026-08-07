/**
 * Tests confirming that extendOrRepairVcSchedule — the helper called by all
 * three VC extension paths (shop-buy button, shop-buy select-menu, and the VC
 * panel extend select-menu) — handles a null return from extendSchedule
 * gracefully.
 *
 * extendSchedule returns null when no schedule row exists for the channel
 * (e.g. deleteSchedule was already called by the expiry or delete scheduler,
 * or the bot restarted before saveSchedule ran). The helper must:
 *   1. Log a warning (never silently ignore the missing row).
 *   2. Kick off a fallback saveSchedule call so the pre-expiry warning DM
 *      will still fire at the right time.
 *   3. Return null so callers know no row was updated.
 *
 * We test the shared helper directly — it is the single source of truth
 * for the null-handling logic used by every extension handler.
 *
 * Scenarios covered:
 *   1. extendSchedule returns a valid row → row returned, no fallback.
 *   2. extendSchedule returns null → warn logged, fallback saveSchedule called.
 *   3. extendSchedule throws → error logged, then null path: warn + fallback.
 *   4. fallbackName absent (null resolved to channelId) → saveSchedule uses channelId.
 *   5. logPrefix distinguishes shop ("vc-extend") from panel ("vc-panel") log tags.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  extendSchedule: vi.fn(),
  saveSchedule: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("../lib/vc.js", () => ({
  extendSchedule: mocks.extendSchedule,
  saveSchedule: mocks.saveSchedule,
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

// ─── Import real helper (after mocks are registered) ─────────────────────────
import { extendOrRepairVcSchedule } from "../lib/vcScheduleRepair.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeScheduleRow(channelId: string, expiresAt: Date) {
  return {
    id: 1,
    channelId,
    guildId: "g1",
    channelName: "🔒 test",
    expiresAt,
    userId: "u1",
    notifiedAt: null,
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CHANNEL_ID   = "ch-111";
const GUILD_ID     = "g-222";
const USER_ID      = "u-333";
const CHANNEL_NAME = "🔒 my-vc";
const NEW_EXPIRES  = new Date("2099-01-01T12:00:00Z");

const BASE_OPTS = {
  channelId:    CHANNEL_ID,
  guildId:      GUILD_ID,
  newExpiresAt: NEW_EXPIRES,
  fallbackName: CHANNEL_NAME,
  userId:       USER_ID as string | undefined,
  logPrefix:    "vc-extend",
} as const;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("extendOrRepairVcSchedule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.saveSchedule.mockResolvedValue(makeScheduleRow(CHANNEL_ID, NEW_EXPIRES));
  });

  it("scenario 1: extendSchedule returns a valid row → row returned, no fallback, no warn", async () => {
    const row = makeScheduleRow(CHANNEL_ID, NEW_EXPIRES);
    mocks.extendSchedule.mockResolvedValue(row);

    const result = await extendOrRepairVcSchedule({ ...BASE_OPTS });

    expect(result).toBe(row);
    expect(mocks.saveSchedule).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it("scenario 2: extendSchedule returns null → warn logged, fallback saveSchedule called, null returned", async () => {
    mocks.extendSchedule.mockResolvedValue(null);

    const result = await extendOrRepairVcSchedule({ ...BASE_OPTS });

    expect(result).toBeNull();

    // A warning must be logged — null must not be swallowed silently
    expect(mocks.loggerWarn).toHaveBeenCalledOnce();
    expect(mocks.loggerWarn.mock.calls[0][0]).toContain("[vc-extend]");
    expect(mocks.loggerWarn.mock.calls[0][0]).toContain("No schedule row found");
    expect(mocks.loggerWarn.mock.calls[0][0]).toContain(CHANNEL_ID);

    // Fallback row must be created so the pre-expiry DM still fires
    expect(mocks.saveSchedule).toHaveBeenCalledOnce();
    expect(mocks.saveSchedule).toHaveBeenCalledWith(
      GUILD_ID,
      CHANNEL_ID,
      CHANNEL_NAME,
      NEW_EXPIRES,
      USER_ID,
    );

    // No spurious error log — extendSchedule returned null cleanly
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it("scenario 3: extendSchedule throws → error logged, then null path fires (warn + fallback saveSchedule)", async () => {
    const dbErr = new Error("DB connection lost");
    mocks.extendSchedule.mockRejectedValue(dbErr);

    const result = await extendOrRepairVcSchedule({ ...BASE_OPTS });

    expect(result).toBeNull();

    // Error from the throw must be logged
    expect(mocks.loggerError).toHaveBeenCalledOnce();
    expect(mocks.loggerError.mock.calls[0][0]).toContain("[vc-extend]");
    expect(mocks.loggerError.mock.calls[0][1]).toBe(dbErr);

    // Then the null path fires
    expect(mocks.loggerWarn).toHaveBeenCalledOnce();
    expect(mocks.loggerWarn.mock.calls[0][0]).toContain("No schedule row found");

    expect(mocks.saveSchedule).toHaveBeenCalledOnce();
    expect(mocks.saveSchedule).toHaveBeenCalledWith(
      GUILD_ID,
      CHANNEL_ID,
      CHANNEL_NAME,
      NEW_EXPIRES,
      USER_ID,
    );
  });

  it("scenario 4: fallbackName is the channelId (channel unavailable) → saveSchedule uses channelId as name", async () => {
    mocks.extendSchedule.mockResolvedValue(null);

    await extendOrRepairVcSchedule({
      ...BASE_OPTS,
      fallbackName: CHANNEL_ID, // caller resolved name to channelId because channel was not in cache
    });

    expect(mocks.saveSchedule).toHaveBeenCalledWith(
      GUILD_ID,
      CHANNEL_ID,
      CHANNEL_ID,  // channelId used as name
      NEW_EXPIRES,
      USER_ID,
    );
  });

  it("scenario 5: logPrefix 'vc-panel' appears in warn and error log tags", async () => {
    mocks.extendSchedule.mockResolvedValue(null);

    await extendOrRepairVcSchedule({ ...BASE_OPTS, logPrefix: "vc-panel" });

    expect(mocks.loggerWarn.mock.calls[0][0]).toContain("[vc-panel]");
  });

  it("userId undefined → saveSchedule called with undefined (no userId on session)", async () => {
    mocks.extendSchedule.mockResolvedValue(null);

    await extendOrRepairVcSchedule({ ...BASE_OPTS, userId: undefined });

    expect(mocks.saveSchedule).toHaveBeenCalledWith(
      GUILD_ID,
      CHANNEL_ID,
      CHANNEL_NAME,
      NEW_EXPIRES,
      undefined,
    );
  });

  it("fallback saveSchedule failure is logged without propagating", async () => {
    mocks.extendSchedule.mockResolvedValue(null);
    const saveErr = new Error("saveSchedule failed");
    mocks.saveSchedule.mockRejectedValue(saveErr);

    // Must not throw
    await expect(extendOrRepairVcSchedule({ ...BASE_OPTS })).resolves.toBeNull();

    // Give the fire-and-forget .catch a tick to run
    await new Promise((r) => setTimeout(r, 0));

    // The fallback error must be logged
    expect(mocks.loggerError).toHaveBeenCalledOnce();
    expect(mocks.loggerError.mock.calls[0][0]).toContain("[vc-extend]");
    expect(mocks.loggerError.mock.calls[0][0]).toContain("Fallback saveSchedule also failed");
    expect(mocks.loggerError.mock.calls[0][1]).toBe(saveErr);
  });
});
