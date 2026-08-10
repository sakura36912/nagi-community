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
 *  10. Deleted channel matches banLogChannelId → setBanLogChannelId(guildId, null) called once.
 *  11. Deleted channel does NOT match banLogChannelId → setBanLogChannelId NOT called.
 *  12. banLogChannelId is null → setBanLogChannelId NOT called.
 *  13. logger.warn fires (with channel id and guild id) when banLogChannelId is cleared.
 *  14. A DB error in getGuildSettings is caught; setBanLogChannelId is NOT called.
 *  15. A DB error in setBanLogChannelId is caught and logged.
 *  16. getGuildSettings receives the correct guildId.
 *  17. A setBanLogChannelId write failure does NOT prevent setLeaveLogChannelId from being called
 *      when both channels match the deleted channel (each setter has its own try-catch).
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

// ─────────────────────────────────────────────────────────────────────────────

describe("handleChannelDelete – banLogChannelId auto-clear", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setVcLogNotifyChannel.mockResolvedValue(undefined);
    mocks.setBanLogChannelId.mockResolvedValue(undefined);
    mocks.setLeaveLogChannelId.mockResolvedValue(undefined);
    // Default VC log settings: no notify channel configured.
    mocks.getVcLogSettings.mockResolvedValue({ notifyChannelId: null });
  });

  // ── Happy path: channel matches banLogChannelId ────────────────────────────

  it("calls setBanLogChannelId(guildId, null) exactly once when the deleted channel matches banLogChannelId", async () => {
    mocks.getGuildSettings.mockResolvedValue({
      banLogChannelId: "ch-banlog",
      leaveLogChannelId: null,
    });

    await handleChannelDelete(makeGuildChannel("ch-banlog", "guild-ban"));

    expect(mocks.setBanLogChannelId).toHaveBeenCalledOnce();
    expect(mocks.setBanLogChannelId).toHaveBeenCalledWith("guild-ban", null);
  });

  it("logs a warn containing the channel id and guild id when banLogChannelId is cleared", async () => {
    mocks.getGuildSettings.mockResolvedValue({
      banLogChannelId: "ch-banlog",
      leaveLogChannelId: null,
    });

    await handleChannelDelete(makeGuildChannel("ch-banlog", "guild-ban"));

    const warnCalls: unknown[][] = mocks.loggerWarn.mock.calls;
    const banWarnCall = warnCalls.find(
      (args) => typeof args[0] === "string" && args[0].includes("[bannotify]"),
    );
    expect(banWarnCall).toBeDefined();
    const warnMsg = banWarnCall![0] as string;
    expect(warnMsg).toContain("ch-banlog");
    expect(warnMsg).toContain("guild-ban");
  });

  // ── No-op path: channel does not match banLogChannelId ────────────────────

  it("does NOT call setBanLogChannelId when the deleted channel does not match banLogChannelId", async () => {
    mocks.getGuildSettings.mockResolvedValue({
      banLogChannelId: "ch-banlog",
      leaveLogChannelId: null,
    });

    await handleChannelDelete(makeGuildChannel("ch-other", "guild-ban"));

    expect(mocks.setBanLogChannelId).not.toHaveBeenCalled();
  });

  it("does NOT log a [bannotify] warn when the deleted channel does not match banLogChannelId", async () => {
    mocks.getGuildSettings.mockResolvedValue({
      banLogChannelId: "ch-banlog",
      leaveLogChannelId: null,
    });

    await handleChannelDelete(makeGuildChannel("ch-other", "guild-ban"));

    const banWarnCalled = mocks.loggerWarn.mock.calls.some(
      (args: unknown[]) => typeof args[0] === "string" && args[0].includes("[bannotify]"),
    );
    expect(banWarnCalled).toBe(false);
  });

  it("does NOT call setBanLogChannelId when banLogChannelId is null", async () => {
    mocks.getGuildSettings.mockResolvedValue({
      banLogChannelId: null,
      leaveLogChannelId: null,
    });

    await handleChannelDelete(makeGuildChannel("ch-any", "guild-ban"));

    expect(mocks.setBanLogChannelId).not.toHaveBeenCalled();
  });

  // ── Error handling ────────────────────────────────────────────────────────

  it("catches a getGuildSettings error without calling setBanLogChannelId", async () => {
    const dbError = new Error("DB read failed");
    mocks.getGuildSettings.mockRejectedValue(dbError);

    await handleChannelDelete(makeGuildChannel("ch-banlog", "guild-ban"));

    expect(mocks.setBanLogChannelId).not.toHaveBeenCalled();
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("[economy] ChannelDelete"),
      dbError,
    );
  });

  it("catches a setBanLogChannelId error and logs it", async () => {
    mocks.getGuildSettings.mockResolvedValue({
      banLogChannelId: "ch-banlog",
      leaveLogChannelId: null,
    });
    const writeError = new Error("write failed");
    mocks.setBanLogChannelId.mockRejectedValue(writeError);

    await handleChannelDelete(makeGuildChannel("ch-banlog", "guild-ban"));

    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("[economy] ChannelDelete"),
      writeError,
    );
  });

  // ── Correct guildId forwarding ────────────────────────────────────────────

  it("passes the correct guildId to getGuildSettings", async () => {
    mocks.getGuildSettings.mockResolvedValue({
      banLogChannelId: null,
      leaveLogChannelId: null,
    });

    await handleChannelDelete(makeGuildChannel("ch-xyz", "guild-99"));

    expect(mocks.getGuildSettings).toHaveBeenCalledOnce();
    expect(mocks.getGuildSettings).toHaveBeenCalledWith("guild-99");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("handleChannelDelete – leaveLogChannelId auto-clear", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setVcLogNotifyChannel.mockResolvedValue(undefined);
    mocks.setBanLogChannelId.mockResolvedValue(undefined);
    mocks.setLeaveLogChannelId.mockResolvedValue(undefined);
    // Default VC log settings: no notify channel configured.
    mocks.getVcLogSettings.mockResolvedValue({ notifyChannelId: null });
  });

  // ── Happy path: channel matches leaveLogChannelId ─────────────────────────

  it("calls setLeaveLogChannelId(guildId, null) exactly once when the deleted channel matches leaveLogChannelId", async () => {
    mocks.getGuildSettings.mockResolvedValue({
      banLogChannelId: null,
      leaveLogChannelId: "ch-leavelog",
    });

    await handleChannelDelete(makeGuildChannel("ch-leavelog", "guild-leave"));

    expect(mocks.setLeaveLogChannelId).toHaveBeenCalledOnce();
    expect(mocks.setLeaveLogChannelId).toHaveBeenCalledWith("guild-leave", null);
  });

  it("logs a warn containing the channel id and guild id when leaveLogChannelId is cleared", async () => {
    mocks.getGuildSettings.mockResolvedValue({
      banLogChannelId: null,
      leaveLogChannelId: "ch-leavelog",
    });

    await handleChannelDelete(makeGuildChannel("ch-leavelog", "guild-leave"));

    const warnCalls: unknown[][] = mocks.loggerWarn.mock.calls;
    const leaveWarnCall = warnCalls.find(
      (args) => typeof args[0] === "string" && args[0].includes("[leavelog]"),
    );
    expect(leaveWarnCall).toBeDefined();
    const warnMsg = leaveWarnCall![0] as string;
    expect(warnMsg).toContain("ch-leavelog");
    expect(warnMsg).toContain("guild-leave");
  });

  // ── No-op path: channel does not match leaveLogChannelId ─────────────────

  it("does NOT call setLeaveLogChannelId when the deleted channel does not match leaveLogChannelId", async () => {
    mocks.getGuildSettings.mockResolvedValue({
      banLogChannelId: null,
      leaveLogChannelId: "ch-leavelog",
    });

    await handleChannelDelete(makeGuildChannel("ch-other", "guild-leave"));

    expect(mocks.setLeaveLogChannelId).not.toHaveBeenCalled();
  });

  it("does NOT log a [leavelog] warn when the deleted channel does not match leaveLogChannelId", async () => {
    mocks.getGuildSettings.mockResolvedValue({
      banLogChannelId: null,
      leaveLogChannelId: "ch-leavelog",
    });

    await handleChannelDelete(makeGuildChannel("ch-other", "guild-leave"));

    const leaveWarnCalled = mocks.loggerWarn.mock.calls.some(
      (args: unknown[]) => typeof args[0] === "string" && args[0].includes("[leavelog]"),
    );
    expect(leaveWarnCalled).toBe(false);
  });

  it("does NOT call setLeaveLogChannelId when leaveLogChannelId is null", async () => {
    mocks.getGuildSettings.mockResolvedValue({
      banLogChannelId: null,
      leaveLogChannelId: null,
    });

    await handleChannelDelete(makeGuildChannel("ch-any", "guild-leave"));

    expect(mocks.setLeaveLogChannelId).not.toHaveBeenCalled();
  });

  // ── Error handling ────────────────────────────────────────────────────────

  it("catches a getGuildSettings error without calling setLeaveLogChannelId", async () => {
    const dbError = new Error("DB read failed");
    mocks.getGuildSettings.mockRejectedValue(dbError);

    await handleChannelDelete(makeGuildChannel("ch-leavelog", "guild-leave"));

    expect(mocks.setLeaveLogChannelId).not.toHaveBeenCalled();
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("[economy] ChannelDelete"),
      dbError,
    );
  });

  it("catches a setLeaveLogChannelId error and logs it", async () => {
    mocks.getGuildSettings.mockResolvedValue({
      banLogChannelId: null,
      leaveLogChannelId: "ch-leavelog",
    });
    const writeError = new Error("write failed");
    mocks.setLeaveLogChannelId.mockRejectedValue(writeError);

    await handleChannelDelete(makeGuildChannel("ch-leavelog", "guild-leave"));

    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("[economy] ChannelDelete"),
      writeError,
    );
  });

  // ── Isolation: a setBanLogChannelId failure must not skip setLeaveLogChannelId ──

  it("still calls setLeaveLogChannelId even when setBanLogChannelId rejects (each setter has its own try-catch)", async () => {
    mocks.getGuildSettings.mockResolvedValue({
      banLogChannelId: "ch-shared",
      leaveLogChannelId: "ch-shared",
    });
    const banWriteError = new Error("ban-log write failed");
    mocks.setBanLogChannelId.mockRejectedValue(banWriteError);

    await handleChannelDelete(makeGuildChannel("ch-shared", "guild-both"));

    // The ban-log write failed, so its error should be logged.
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("[economy] ChannelDelete"),
      banWriteError,
    );
    // Despite the ban-log failure, the leave-log clear must still proceed.
    expect(mocks.setLeaveLogChannelId).toHaveBeenCalledOnce();
    expect(mocks.setLeaveLogChannelId).toHaveBeenCalledWith("guild-both", null);
  });

  // ── banLog and leaveLog are independent ───────────────────────────────────

  it("clears both banLogChannelId and leaveLogChannelId when both match the deleted channel", async () => {
    mocks.getGuildSettings.mockResolvedValue({
      banLogChannelId: "ch-shared",
      leaveLogChannelId: "ch-shared",
    });

    await handleChannelDelete(makeGuildChannel("ch-shared", "guild-both"));

    expect(mocks.setBanLogChannelId).toHaveBeenCalledOnce();
    expect(mocks.setBanLogChannelId).toHaveBeenCalledWith("guild-both", null);
    expect(mocks.setLeaveLogChannelId).toHaveBeenCalledOnce();
    expect(mocks.setLeaveLogChannelId).toHaveBeenCalledWith("guild-both", null);
  });

  it("clears only leaveLogChannelId when only it matches and banLogChannelId differs", async () => {
    mocks.getGuildSettings.mockResolvedValue({
      banLogChannelId: "ch-banlog",
      leaveLogChannelId: "ch-leavelog",
    });

    await handleChannelDelete(makeGuildChannel("ch-leavelog", "guild-leave"));

    expect(mocks.setBanLogChannelId).not.toHaveBeenCalled();
    expect(mocks.setLeaveLogChannelId).toHaveBeenCalledOnce();
    expect(mocks.setLeaveLogChannelId).toHaveBeenCalledWith("guild-leave", null);
  });
});
