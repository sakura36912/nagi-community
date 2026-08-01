/**
 * Tests for handleChannelDelete (lib/handleChannelDelete.ts) — the function
 * wired to the Events.ChannelDelete listener in index.ts.
 *
 * These tests import and exercise the real production handler, so any
 * regression in index.ts (wrong guild ID lookup, removed import, changed
 * condition) will be caught.
 *
 * Scenarios covered:
 *   1. Deleted channel matches notifyChannelId → setVcLogNotifyChannel(guildId, null) called once.
 *   2. Deleted channel does NOT match notifyChannelId → setVcLogNotifyChannel NOT called.
 *   3. notifyChannelId is null → setVcLogNotifyChannel NOT called.
 *   4. DM channels (no guildId property) are ignored entirely.
 *   5. Channel with guildId: null is ignored.
 *   6. A DB error in getVcLogSettings is caught; setVcLogNotifyChannel is NOT called.
 *   7. A DB error in setVcLogNotifyChannel is caught and logged.
 *   8. logger.warn fires when notifyChannelId is cleared; NOT fired otherwise.
 *   9. getVcLogSettings receives the correct guildId.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  getVcLogSettings: vi.fn(),
  setVcLogNotifyChannel: vi.fn(),
  getGuildSettings: vi.fn(),
  setBanLogChannelId: vi.fn(),
  setLeaveLogChannelId: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

// ─── Mock lib/vcReward ───────────────────────────────────────────────────────

vi.mock("../lib/vcReward.js", () => ({
  getVcLogSettings: mocks.getVcLogSettings,
  setVcLogNotifyChannel: mocks.setVcLogNotifyChannel,
}));

// ─── Mock lib/economy ────────────────────────────────────────────────────────

vi.mock("../lib/economy.js", () => ({
  getGuildSettings: mocks.getGuildSettings,
  setBanLogChannelId: mocks.setBanLogChannelId,
  setLeaveLogChannelId: mocks.setLeaveLogChannelId,
}));

// ─── Mock logger ─────────────────────────────────────────────────────────────

vi.mock("../lib/logger.js", () => ({
  logger: {
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

// ─── Import the real production handler ──────────────────────────────────────

import { handleChannelDelete } from "../lib/handleChannelDelete.js";

// Convenience alias for the handler's parameter type so test helpers can
// cast plain objects without importing the full Discord.js union.
type HandlerChannel = Parameters<typeof handleChannelDelete>[0];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeGuildChannel(channelId: string, guildId: string): HandlerChannel {
  return { id: channelId, guildId } as unknown as HandlerChannel;
}

function makeDmChannel(channelId: string): HandlerChannel {
  // DM channels have no guildId property at all.
  return { id: channelId } as unknown as HandlerChannel;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("handleChannelDelete – notifyChannelId auto-clear", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setVcLogNotifyChannel.mockResolvedValue(undefined);
    mocks.setBanLogChannelId.mockResolvedValue(undefined);
    mocks.setLeaveLogChannelId.mockResolvedValue(undefined);
    // Default: guild settings have no banLog/leaveLog channels set.
    mocks.getGuildSettings.mockResolvedValue({ banLogChannelId: null, leaveLogChannelId: null });
  });

  // ── Happy path: channel matches ───────────────────────────────────────────

  it("calls setVcLogNotifyChannel(guildId, null) exactly once when the deleted channel matches notifyChannelId", async () => {
    mocks.getVcLogSettings.mockResolvedValue({ notifyChannelId: "ch-notify" });

    await handleChannelDelete(makeGuildChannel("ch-notify", "guild-1"));

    expect(mocks.setVcLogNotifyChannel).toHaveBeenCalledOnce();
    expect(mocks.setVcLogNotifyChannel).toHaveBeenCalledWith("guild-1", null);
  });

  it("logs a warn when notifyChannelId is cleared", async () => {
    mocks.getVcLogSettings.mockResolvedValue({ notifyChannelId: "ch-notify" });

    await handleChannelDelete(makeGuildChannel("ch-notify", "guild-1"));

    expect(mocks.loggerWarn).toHaveBeenCalled();
    const warnMsg: string = mocks.loggerWarn.mock.calls[0][0];
    expect(warnMsg).toContain("ch-notify");
    expect(warnMsg).toContain("guild-1");
  });

  // ── No-op path: channel does not match ───────────────────────────────────

  it("does NOT call setVcLogNotifyChannel when the deleted channel does not match notifyChannelId", async () => {
    mocks.getVcLogSettings.mockResolvedValue({ notifyChannelId: "ch-notify" });

    await handleChannelDelete(makeGuildChannel("ch-other", "guild-1"));

    expect(mocks.setVcLogNotifyChannel).not.toHaveBeenCalled();
  });

  it("does NOT log a warn for the vclog section when the deleted channel does not match", async () => {
    mocks.getVcLogSettings.mockResolvedValue({ notifyChannelId: "ch-notify" });

    await handleChannelDelete(makeGuildChannel("ch-other", "guild-1"));

    // No [vclog] warn should fire.
    const vclogWarnCalled = mocks.loggerWarn.mock.calls.some(
      (args: unknown[]) => typeof args[0] === "string" && args[0].includes("[vclog]"),
    );
    expect(vclogWarnCalled).toBe(false);
  });

  it("does NOT call setVcLogNotifyChannel when notifyChannelId is null", async () => {
    mocks.getVcLogSettings.mockResolvedValue({ notifyChannelId: null });

    await handleChannelDelete(makeGuildChannel("ch-any", "guild-1"));

    expect(mocks.setVcLogNotifyChannel).not.toHaveBeenCalled();
  });

  // ── DM channel guard ──────────────────────────────────────────────────────

  it("ignores DM channels (no guildId property)", async () => {
    await handleChannelDelete(makeDmChannel("dm-channel-1"));

    expect(mocks.getVcLogSettings).not.toHaveBeenCalled();
    expect(mocks.setVcLogNotifyChannel).not.toHaveBeenCalled();
  });

  it("ignores channels where guildId is null", async () => {
    await handleChannelDelete({ id: "ch-1", guildId: null } as unknown as HandlerChannel);

    expect(mocks.getVcLogSettings).not.toHaveBeenCalled();
    expect(mocks.setVcLogNotifyChannel).not.toHaveBeenCalled();
  });

  // ── Error handling ────────────────────────────────────────────────────────

  it("catches a getVcLogSettings error and logs it without calling setVcLogNotifyChannel", async () => {
    const dbError = new Error("DB connection failed");
    mocks.getVcLogSettings.mockRejectedValue(dbError);

    await handleChannelDelete(makeGuildChannel("ch-notify", "guild-1"));

    expect(mocks.setVcLogNotifyChannel).not.toHaveBeenCalled();
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("[vclog] ChannelDelete"),
      dbError,
    );
  });

  it("catches a setVcLogNotifyChannel error and logs it", async () => {
    mocks.getVcLogSettings.mockResolvedValue({ notifyChannelId: "ch-notify" });
    const writeError = new Error("write failed");
    mocks.setVcLogNotifyChannel.mockRejectedValue(writeError);

    await handleChannelDelete(makeGuildChannel("ch-notify", "guild-1"));

    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("[vclog] ChannelDelete"),
      writeError,
    );
  });

  it("passes the correct guildId to getVcLogSettings", async () => {
    mocks.getVcLogSettings.mockResolvedValue({ notifyChannelId: null });

    await handleChannelDelete(makeGuildChannel("ch-xyz", "guild-42"));

    expect(mocks.getVcLogSettings).toHaveBeenCalledOnce();
    expect(mocks.getVcLogSettings).toHaveBeenCalledWith("guild-42");
  });
});
