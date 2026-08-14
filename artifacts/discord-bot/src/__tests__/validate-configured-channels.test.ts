/**
 * Tests for validateGuildConfiguredChannels and runStartupChannelValidation
 * (lib/validateConfiguredChannels.ts)
 *
 * Scenarios covered:
 *
 * notifyChannelId (vclog)
 *   1.  Channel is gone → setVcLogNotifyChannel(guildId, null) called once.
 *   2.  Channel still exists → setVcLogNotifyChannel NOT called.
 *   3.  notifyChannelId is null → resolveChannel NOT called; setter NOT called.
 *   4.  resolveChannel throws (transient) → treat as exists; setter NOT called.
 *   5.  getVcLogSettings throws → setter NOT called; error logged.
 *   6.  setVcLogNotifyChannel throws → error logged.
 *   7.  logger.warn fires (with channelId and guildId) when notifyChannelId is cleared.
 *   8.  logger.warn does NOT fire when the channel still exists.
 *
 * banLogChannelId
 *   9.  Channel is gone → setBanLogChannelId(guildId, null) called once.
 *  10.  Channel still exists → setBanLogChannelId NOT called.
 *  11.  banLogChannelId is null → resolveChannel NOT called; setter NOT called.
 *  12.  resolveChannel throws (transient) → treat as exists; setter NOT called.
 *  13.  getGuildSettings throws → setBanLogChannelId NOT called; error logged.
 *  14.  setBanLogChannelId throws → error logged.
 *  15.  logger.warn fires (with channelId and guildId) when banLogChannelId is cleared.
 *
 * leaveLogChannelId
 *  16.  Channel is gone → setLeaveLogChannelId(guildId, null) called once.
 *  17.  Channel still exists → setLeaveLogChannelId NOT called.
 *  18.  leaveLogChannelId is null → resolveChannel NOT called; setter NOT called.
 *  19.  resolveChannel throws (transient) → treat as exists; setter NOT called.
 *  20.  getGuildSettings throws → setLeaveLogChannelId NOT called; error logged.
 *  21.  setLeaveLogChannelId throws → error logged.
 *  22.  logger.warn fires (with channelId and guildId) when leaveLogChannelId is cleared.
 *
 * isolation
 *  23.  setBanLogChannelId failure does NOT prevent setLeaveLogChannelId from running.
 *  24.  Both banLogChannelId and leaveLogChannelId cleared when both are gone.
 *  25.  Correct guildId passed to getVcLogSettings and getGuildSettings.
 *
 * runStartupChannelValidation (startup iteration)
 *  26.  Calls validateGuildConfiguredChannels for every guild in the iterable.
 *  27.  An error in one guild does not prevent subsequent guilds from being validated.
 *  28.  resolverFactory is called with each guild object.
 *  29.  Empty iterable completes without error and makes no DB calls.
 *
 * makeChannelResolver integration (end-to-end with real resolver from index.ts)
 *  30.  fetch() throws DiscordAPIError 50013 (Missing Access) → resolver re-throws
 *       → validateGuildConfiguredChannels treats channel as existing → ID NOT cleared.
 *  31.  fetch() throws DiscordAPIError 10003 (Unknown Channel) → resolver returns false
 *       → validateGuildConfiguredChannels clears the ID.
 *  32.  Channel found in cache (has() returns true) → fetch is never called → ID NOT cleared.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import { DiscordAPIError } from "discord.js";

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

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("../lib/vcReward.js", () => ({
  getVcLogSettings: mocks.getVcLogSettings,
  setVcLogNotifyChannel: mocks.setVcLogNotifyChannel,
}));

vi.mock("../lib/economy.js", () => ({
  getGuildSettings: mocks.getGuildSettings,
  setBanLogChannelId: mocks.setBanLogChannelId,
  setLeaveLogChannelId: mocks.setLeaveLogChannelId,
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

// ─── Import the real functions ────────────────────────────────────────────────

import { validateGuildConfiguredChannels, runStartupChannelValidation } from "../lib/validateConfiguredChannels.js";
import { makeChannelResolver } from "../lib/makeChannelResolver.js";

// ─── Default resolver helpers ─────────────────────────────────────────────────

/** A resolver that always reports the channel as existing. */
const channelExists = vi.fn().mockResolvedValue(true);

/** A resolver that always reports the channel as gone. */
const channelGone = vi.fn().mockResolvedValue(false);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("validateGuildConfiguredChannels – notifyChannelId (vclog)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setVcLogNotifyChannel.mockResolvedValue(undefined);
    mocks.setBanLogChannelId.mockResolvedValue(undefined);
    mocks.setLeaveLogChannelId.mockResolvedValue(undefined);
    // Default: no guild-settings channels configured.
    mocks.getGuildSettings.mockResolvedValue({ banLogChannelId: null, leaveLogChannelId: null });
  });

  // 1
  it("calls setVcLogNotifyChannel(guildId, null) when the channel no longer exists", async () => {
    mocks.getVcLogSettings.mockResolvedValue({ notifyChannelId: "ch-notify" });

    await validateGuildConfiguredChannels("guild-1", channelGone);

    expect(mocks.setVcLogNotifyChannel).toHaveBeenCalledOnce();
    expect(mocks.setVcLogNotifyChannel).toHaveBeenCalledWith("guild-1", null);
  });

  // 2
  it("does NOT call setVcLogNotifyChannel when the channel still exists", async () => {
    mocks.getVcLogSettings.mockResolvedValue({ notifyChannelId: "ch-notify" });

    await validateGuildConfiguredChannels("guild-1", channelExists);

    expect(mocks.setVcLogNotifyChannel).not.toHaveBeenCalled();
  });

  // 3
  it("does NOT call resolveChannel or setVcLogNotifyChannel when notifyChannelId is null", async () => {
    mocks.getVcLogSettings.mockResolvedValue({ notifyChannelId: null });
    const resolver = vi.fn();

    await validateGuildConfiguredChannels("guild-1", resolver);

    expect(resolver).not.toHaveBeenCalled();
    expect(mocks.setVcLogNotifyChannel).not.toHaveBeenCalled();
  });

  // 4
  it("treats a transient resolveChannel rejection as 'exists' — does NOT clear notifyChannelId", async () => {
    mocks.getVcLogSettings.mockResolvedValue({ notifyChannelId: "ch-notify" });
    const transientResolver = vi.fn().mockRejectedValue(new Error("network error"));

    await validateGuildConfiguredChannels("guild-1", transientResolver);

    expect(mocks.setVcLogNotifyChannel).not.toHaveBeenCalled();
  });

  // 5
  it("catches a getVcLogSettings error and does NOT call setVcLogNotifyChannel", async () => {
    const dbError = new Error("DB read failed");
    mocks.getVcLogSettings.mockRejectedValue(dbError);

    await validateGuildConfiguredChannels("guild-1", channelGone);

    expect(mocks.setVcLogNotifyChannel).not.toHaveBeenCalled();
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("[vclog] startup validation"),
      dbError,
    );
  });

  // 6
  it("catches a setVcLogNotifyChannel write error and logs it", async () => {
    mocks.getVcLogSettings.mockResolvedValue({ notifyChannelId: "ch-notify" });
    const writeError = new Error("write failed");
    mocks.setVcLogNotifyChannel.mockRejectedValue(writeError);

    await validateGuildConfiguredChannels("guild-1", channelGone);

    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("[vclog] startup validation"),
      writeError,
    );
  });

  // 7
  it("logs a warn containing channelId and guildId when notifyChannelId is cleared", async () => {
    mocks.getVcLogSettings.mockResolvedValue({ notifyChannelId: "ch-notify" });

    await validateGuildConfiguredChannels("guild-1", channelGone);

    const warnMsg: string = mocks.loggerWarn.mock.calls[0]?.[0] ?? "";
    expect(warnMsg).toContain("ch-notify");
    expect(warnMsg).toContain("guild-1");
  });

  // 8
  it("does NOT log a [vclog] warn when the channel still exists", async () => {
    mocks.getVcLogSettings.mockResolvedValue({ notifyChannelId: "ch-notify" });

    await validateGuildConfiguredChannels("guild-1", channelExists);

    const vclogWarnFired = mocks.loggerWarn.mock.calls.some(
      (args: unknown[]) => typeof args[0] === "string" && args[0].includes("[vclog]"),
    );
    expect(vclogWarnFired).toBe(false);
  });

  // 25 (guildId forwarding for vclog)
  it("passes the correct guildId to getVcLogSettings", async () => {
    mocks.getVcLogSettings.mockResolvedValue({ notifyChannelId: null });

    await validateGuildConfiguredChannels("guild-42", channelExists);

    expect(mocks.getVcLogSettings).toHaveBeenCalledOnce();
    expect(mocks.getVcLogSettings).toHaveBeenCalledWith("guild-42");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("validateGuildConfiguredChannels – banLogChannelId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setVcLogNotifyChannel.mockResolvedValue(undefined);
    mocks.setBanLogChannelId.mockResolvedValue(undefined);
    mocks.setLeaveLogChannelId.mockResolvedValue(undefined);
    mocks.getVcLogSettings.mockResolvedValue({ notifyChannelId: null });
  });

  // 9
  it("calls setBanLogChannelId(guildId, null) when the channel no longer exists", async () => {
    mocks.getGuildSettings.mockResolvedValue({ banLogChannelId: "ch-banlog", leaveLogChannelId: null });

    await validateGuildConfiguredChannels("guild-ban", channelGone);

    expect(mocks.setBanLogChannelId).toHaveBeenCalledOnce();
    expect(mocks.setBanLogChannelId).toHaveBeenCalledWith("guild-ban", null);
  });

  // 10
  it("does NOT call setBanLogChannelId when the channel still exists", async () => {
    mocks.getGuildSettings.mockResolvedValue({ banLogChannelId: "ch-banlog", leaveLogChannelId: null });

    await validateGuildConfiguredChannels("guild-ban", channelExists);

    expect(mocks.setBanLogChannelId).not.toHaveBeenCalled();
  });

  // 11
  it("does NOT call setBanLogChannelId when banLogChannelId is null", async () => {
    mocks.getGuildSettings.mockResolvedValue({ banLogChannelId: null, leaveLogChannelId: null });

    await validateGuildConfiguredChannels("guild-ban", channelGone);

    expect(mocks.setBanLogChannelId).not.toHaveBeenCalled();
  });

  // 12
  it("treats a transient resolveChannel rejection as 'exists' — does NOT clear banLogChannelId", async () => {
    mocks.getGuildSettings.mockResolvedValue({ banLogChannelId: "ch-banlog", leaveLogChannelId: null });
    const transientResolver = vi.fn().mockRejectedValue(new Error("network error"));

    await validateGuildConfiguredChannels("guild-ban", transientResolver);

    expect(mocks.setBanLogChannelId).not.toHaveBeenCalled();
  });

  // 13
  it("catches a getGuildSettings error and does NOT call setBanLogChannelId", async () => {
    const dbError = new Error("DB read failed");
    mocks.getGuildSettings.mockRejectedValue(dbError);

    await validateGuildConfiguredChannels("guild-ban", channelGone);

    expect(mocks.setBanLogChannelId).not.toHaveBeenCalled();
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("[economy] startup validation"),
      dbError,
    );
  });

  // 14
  it("catches a setBanLogChannelId write error and logs it", async () => {
    mocks.getGuildSettings.mockResolvedValue({ banLogChannelId: "ch-banlog", leaveLogChannelId: null });
    const writeError = new Error("write failed");
    mocks.setBanLogChannelId.mockRejectedValue(writeError);

    await validateGuildConfiguredChannels("guild-ban", channelGone);

    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("[economy] startup validation"),
      writeError,
    );
  });

  // 15
  it("logs a [bannotify] warn containing channelId and guildId when banLogChannelId is cleared", async () => {
    mocks.getGuildSettings.mockResolvedValue({ banLogChannelId: "ch-banlog", leaveLogChannelId: null });

    await validateGuildConfiguredChannels("guild-ban", channelGone);

    const warnCalls: unknown[][] = mocks.loggerWarn.mock.calls;
    const banWarn = warnCalls.find(
      (args) => typeof args[0] === "string" && args[0].includes("[bannotify]"),
    );
    expect(banWarn).toBeDefined();
    const msg = banWarn![0] as string;
    expect(msg).toContain("ch-banlog");
    expect(msg).toContain("guild-ban");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("validateGuildConfiguredChannels – leaveLogChannelId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setVcLogNotifyChannel.mockResolvedValue(undefined);
    mocks.setBanLogChannelId.mockResolvedValue(undefined);
    mocks.setLeaveLogChannelId.mockResolvedValue(undefined);
    mocks.getVcLogSettings.mockResolvedValue({ notifyChannelId: null });
  });

  // 16
  it("calls setLeaveLogChannelId(guildId, null) when the channel no longer exists", async () => {
    mocks.getGuildSettings.mockResolvedValue({ banLogChannelId: null, leaveLogChannelId: "ch-leave" });

    await validateGuildConfiguredChannels("guild-leave", channelGone);

    expect(mocks.setLeaveLogChannelId).toHaveBeenCalledOnce();
    expect(mocks.setLeaveLogChannelId).toHaveBeenCalledWith("guild-leave", null);
  });

  // 17
  it("does NOT call setLeaveLogChannelId when the channel still exists", async () => {
    mocks.getGuildSettings.mockResolvedValue({ banLogChannelId: null, leaveLogChannelId: "ch-leave" });

    await validateGuildConfiguredChannels("guild-leave", channelExists);

    expect(mocks.setLeaveLogChannelId).not.toHaveBeenCalled();
  });

  // 18
  it("does NOT call setLeaveLogChannelId when leaveLogChannelId is null", async () => {
    mocks.getGuildSettings.mockResolvedValue({ banLogChannelId: null, leaveLogChannelId: null });

    await validateGuildConfiguredChannels("guild-leave", channelGone);

    expect(mocks.setLeaveLogChannelId).not.toHaveBeenCalled();
  });

  // 19
  it("treats a transient resolveChannel rejection as 'exists' — does NOT clear leaveLogChannelId", async () => {
    mocks.getGuildSettings.mockResolvedValue({ banLogChannelId: null, leaveLogChannelId: "ch-leave" });
    const transientResolver = vi.fn().mockRejectedValue(new Error("network error"));

    await validateGuildConfiguredChannels("guild-leave", transientResolver);

    expect(mocks.setLeaveLogChannelId).not.toHaveBeenCalled();
  });

  // 20
  it("catches a getGuildSettings error and does NOT call setLeaveLogChannelId", async () => {
    const dbError = new Error("DB read failed");
    mocks.getGuildSettings.mockRejectedValue(dbError);

    await validateGuildConfiguredChannels("guild-leave", channelGone);

    expect(mocks.setLeaveLogChannelId).not.toHaveBeenCalled();
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("[economy] startup validation"),
      dbError,
    );
  });

  // 21
  it("catches a setLeaveLogChannelId write error and logs it", async () => {
    mocks.getGuildSettings.mockResolvedValue({ banLogChannelId: null, leaveLogChannelId: "ch-leave" });
    const writeError = new Error("write failed");
    mocks.setLeaveLogChannelId.mockRejectedValue(writeError);

    await validateGuildConfiguredChannels("guild-leave", channelGone);

    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("[economy] startup validation"),
      writeError,
    );
  });

  // 22
  it("logs a [leavelog] warn containing channelId and guildId when leaveLogChannelId is cleared", async () => {
    mocks.getGuildSettings.mockResolvedValue({ banLogChannelId: null, leaveLogChannelId: "ch-leave" });

    await validateGuildConfiguredChannels("guild-leave", channelGone);

    const warnCalls: unknown[][] = mocks.loggerWarn.mock.calls;
    const leaveWarn = warnCalls.find(
      (args) => typeof args[0] === "string" && args[0].includes("[leavelog]"),
    );
    expect(leaveWarn).toBeDefined();
    const msg = leaveWarn![0] as string;
    expect(msg).toContain("ch-leave");
    expect(msg).toContain("guild-leave");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("validateGuildConfiguredChannels – isolation and combined cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setVcLogNotifyChannel.mockResolvedValue(undefined);
    mocks.setBanLogChannelId.mockResolvedValue(undefined);
    mocks.setLeaveLogChannelId.mockResolvedValue(undefined);
    mocks.getVcLogSettings.mockResolvedValue({ notifyChannelId: null });
  });

  // 23
  it("still clears leaveLogChannelId even when setBanLogChannelId rejects (each setter has its own try-catch)", async () => {
    mocks.getGuildSettings.mockResolvedValue({
      banLogChannelId: "ch-shared",
      leaveLogChannelId: "ch-shared",
    });
    const banWriteError = new Error("ban-log write failed");
    mocks.setBanLogChannelId.mockRejectedValue(banWriteError);

    await validateGuildConfiguredChannels("guild-both", channelGone);

    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("[economy] startup validation"),
      banWriteError,
    );
    expect(mocks.setLeaveLogChannelId).toHaveBeenCalledOnce();
    expect(mocks.setLeaveLogChannelId).toHaveBeenCalledWith("guild-both", null);
  });

  // 24
  it("clears both banLogChannelId and leaveLogChannelId when both channels are gone", async () => {
    mocks.getGuildSettings.mockResolvedValue({
      banLogChannelId: "ch-ban",
      leaveLogChannelId: "ch-leave",
    });

    await validateGuildConfiguredChannels("guild-both", channelGone);

    expect(mocks.setBanLogChannelId).toHaveBeenCalledOnce();
    expect(mocks.setBanLogChannelId).toHaveBeenCalledWith("guild-both", null);
    expect(mocks.setLeaveLogChannelId).toHaveBeenCalledOnce();
    expect(mocks.setLeaveLogChannelId).toHaveBeenCalledWith("guild-both", null);
  });

  // 33 — all three IDs cleared in a single pass
  it("clears all three stale channel IDs (notifyChannelId, banLogChannelId, leaveLogChannelId) in one pass when all are gone", async () => {
    mocks.getVcLogSettings.mockResolvedValue({ notifyChannelId: "ch-notify-stale" });
    mocks.getGuildSettings.mockResolvedValue({
      banLogChannelId: "ch-ban-stale",
      leaveLogChannelId: "ch-leave-stale",
    });

    await validateGuildConfiguredChannels("guild-all-stale", channelGone);

    expect(mocks.setVcLogNotifyChannel).toHaveBeenCalledOnce();
    expect(mocks.setVcLogNotifyChannel).toHaveBeenCalledWith("guild-all-stale", null);
    expect(mocks.setBanLogChannelId).toHaveBeenCalledOnce();
    expect(mocks.setBanLogChannelId).toHaveBeenCalledWith("guild-all-stale", null);
    expect(mocks.setLeaveLogChannelId).toHaveBeenCalledOnce();
    expect(mocks.setLeaveLogChannelId).toHaveBeenCalledWith("guild-all-stale", null);
  });

  // 25 (guildId forwarding for guild settings)
  it("passes the correct guildId to getGuildSettings", async () => {
    mocks.getGuildSettings.mockResolvedValue({ banLogChannelId: null, leaveLogChannelId: null });

    await validateGuildConfiguredChannels("guild-99", channelGone);

    expect(mocks.getGuildSettings).toHaveBeenCalledOnce();
    expect(mocks.getGuildSettings).toHaveBeenCalledWith("guild-99");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("runStartupChannelValidation – startup iteration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setVcLogNotifyChannel.mockResolvedValue(undefined);
    mocks.setBanLogChannelId.mockResolvedValue(undefined);
    mocks.setLeaveLogChannelId.mockResolvedValue(undefined);
    mocks.getVcLogSettings.mockResolvedValue({ notifyChannelId: null });
  });

  // 26 — called for every guild in the iterable
  it("validates every guild in the iterable (calls validateGuildConfiguredChannels for each)", async () => {
    mocks.getGuildSettings.mockResolvedValue({
      banLogChannelId: "ch-stale",
      leaveLogChannelId: null,
    });

    const guilds = [{ id: "guild-A" }, { id: "guild-B" }, { id: "guild-C" }];
    const resolverFactory = vi.fn().mockReturnValue(channelGone);

    await runStartupChannelValidation(guilds, resolverFactory);

    // resolverFactory called once per guild
    expect(resolverFactory).toHaveBeenCalledTimes(3);
    expect(resolverFactory).toHaveBeenCalledWith(guilds[0]);
    expect(resolverFactory).toHaveBeenCalledWith(guilds[1]);
    expect(resolverFactory).toHaveBeenCalledWith(guilds[2]);

    // The DB setter was called for each guild
    expect(mocks.setBanLogChannelId).toHaveBeenCalledTimes(3);
    expect(mocks.setBanLogChannelId).toHaveBeenCalledWith("guild-A", null);
    expect(mocks.setBanLogChannelId).toHaveBeenCalledWith("guild-B", null);
    expect(mocks.setBanLogChannelId).toHaveBeenCalledWith("guild-C", null);
  });

  // 27 — one guild's error does not prevent others
  it("continues validating remaining guilds when one guild's validation throws", async () => {
    // guild-A: getGuildSettings throws (simulates a DB blip for that guild)
    // guild-B: normal — leaveLogChannelId is stale and gets cleared
    mocks.getGuildSettings
      .mockRejectedValueOnce(new Error("DB blip for guild-A"))
      .mockResolvedValueOnce({ banLogChannelId: null, leaveLogChannelId: "ch-stale-B" });

    const guilds = [{ id: "guild-A" }, { id: "guild-B" }];
    const resolverFactory = vi.fn().mockReturnValue(channelGone);

    await runStartupChannelValidation(guilds, resolverFactory);

    // guild-A had an error — setLeaveLogChannelId must NOT have been called for it
    // guild-B must still have been processed
    expect(mocks.setLeaveLogChannelId).toHaveBeenCalledOnce();
    expect(mocks.setLeaveLogChannelId).toHaveBeenCalledWith("guild-B", null);
  });

  // 28 — resolverFactory receives the guild object
  it("passes each guild object to resolverFactory", async () => {
    mocks.getGuildSettings.mockResolvedValue({ banLogChannelId: null, leaveLogChannelId: null });

    const guildA = { id: "guild-A" };
    const guildB = { id: "guild-B" };
    const resolverFactory = vi.fn().mockReturnValue(channelExists);

    await runStartupChannelValidation([guildA, guildB], resolverFactory);

    expect(resolverFactory).toHaveBeenCalledWith(guildA);
    expect(resolverFactory).toHaveBeenCalledWith(guildB);
  });

  // 29 — empty iterable is a no-op
  it("completes without error and makes no DB calls when the guild iterable is empty", async () => {
    const resolverFactory = vi.fn();

    await runStartupChannelValidation([], resolverFactory);

    expect(resolverFactory).not.toHaveBeenCalled();
    expect(mocks.getVcLogSettings).not.toHaveBeenCalled();
    expect(mocks.getGuildSettings).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// makeChannelResolver integration tests
//
// These tests wire the real makeChannelResolver closure (extracted from
// index.ts) with a fake guild object, then pass the resulting resolver to
// validateGuildConfiguredChannels so the entire path is exercised end-to-end.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a minimal DiscordAPIError instance without invoking its real
 * constructor (which requires a full RawError payload).  The resolver only
 * checks `err instanceof DiscordAPIError` and `err.code`, so this is enough.
 */
function makeDiscordAPIError(code: number, message: string): DiscordAPIError {
  const err = Object.create(DiscordAPIError.prototype) as DiscordAPIError;
  Object.defineProperty(err, "code", { value: code, writable: false });
  err.message = message;
  return err;
}

describe("makeChannelResolver integration – end-to-end with validateGuildConfiguredChannels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setVcLogNotifyChannel.mockResolvedValue(undefined);
    mocks.setBanLogChannelId.mockResolvedValue(undefined);
    mocks.setLeaveLogChannelId.mockResolvedValue(undefined);
    mocks.getVcLogSettings.mockResolvedValue({ notifyChannelId: null });
  });

  // 30 — fetch() throws DiscordAPIError 50013 (Missing Access) → ID NOT cleared
  it("does NOT clear banLogChannelId when guild.channels.fetch rejects with DiscordAPIError 50013 (Missing Access)", async () => {
    mocks.getGuildSettings.mockResolvedValue({
      banLogChannelId: "ch-banlog",
      leaveLogChannelId: null,
    });

    const missingAccessError = makeDiscordAPIError(50013, "Missing Access");
    const fakeGuild = {
      channels: {
        cache: { has: (_id: string) => false },
        fetch: vi.fn().mockRejectedValue(missingAccessError),
      },
    };

    const resolver = makeChannelResolver(fakeGuild);
    await validateGuildConfiguredChannels("guild-transient", resolver);

    // Transient error — must NOT clear the configured ID
    expect(mocks.setBanLogChannelId).not.toHaveBeenCalled();
  });

  // 31 — fetch() throws DiscordAPIError 10003 (Unknown Channel) → ID IS cleared
  it("clears banLogChannelId when guild.channels.fetch rejects with DiscordAPIError 10003 (Unknown Channel)", async () => {
    mocks.getGuildSettings.mockResolvedValue({
      banLogChannelId: "ch-banlog",
      leaveLogChannelId: null,
    });

    const unknownChannelError = makeDiscordAPIError(10003, "Unknown Channel");
    const fakeGuild = {
      channels: {
        cache: { has: (_id: string) => false },
        fetch: vi.fn().mockRejectedValue(unknownChannelError),
      },
    };

    const resolver = makeChannelResolver(fakeGuild);
    await validateGuildConfiguredChannels("guild-gone", resolver);

    // Unknown Channel is confirmed-gone — must clear the configured ID
    expect(mocks.setBanLogChannelId).toHaveBeenCalledOnce();
    expect(mocks.setBanLogChannelId).toHaveBeenCalledWith("guild-gone", null);
  });

  // 32 — channel found in cache → fetch is never called → ID NOT cleared
  it("does NOT call fetch and does NOT clear banLogChannelId when the channel is in the guild cache", async () => {
    mocks.getGuildSettings.mockResolvedValue({
      banLogChannelId: "ch-cached",
      leaveLogChannelId: null,
    });

    const fetchSpy = vi.fn();
    const fakeGuild = {
      channels: {
        cache: { has: (id: string) => id === "ch-cached" },
        fetch: fetchSpy,
      },
    };

    const resolver = makeChannelResolver(fakeGuild);
    await validateGuildConfiguredChannels("guild-cached", resolver);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.setBanLogChannelId).not.toHaveBeenCalled();
  });
});
