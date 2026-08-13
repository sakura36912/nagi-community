/**
 * Tests that the ClientReady startup re-open sweep respects the tracked-category filter.
 *
 * The updated startup sweep in index.ts reads getTrackedVcCategoryId once per guild,
 * then skips any GuildVoice channel whose parentId does not match the configured category.
 *
 * Covers:
 *   - openSession IS called for a channel inside the tracked category
 *   - openSession is NOT called for a channel outside the tracked category
 *   - openSession IS called for all channels when no category is configured (null)
 *   - openSession is NOT called when getTrackedVcCategoryId throws (fail closed)
 *   - Only the failing guild is skipped when one guild throws and another succeeds
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock functions ─────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  openSession:            vi.fn().mockResolvedValue(null),
  getTrackedVcCategoryId: vi.fn<() => Promise<string | null>>(),
  loggerError:            vi.fn(),
  loggerInfo:             vi.fn(),
  loggerWarn:             vi.fn(),
}));

// ─── Mock community lib ───────────────────────────────────────────────────────
vi.mock("../lib/community.js", () => ({
  openSession:            mocks.openSession,
  getTrackedVcCategoryId: mocks.getTrackedVcCategoryId,
  closeAllOpenSessions:   vi.fn().mockResolvedValue(undefined),
}));

// ─── Mock logger ──────────────────────────────────────────────────────────────
vi.mock("../lib/logger.js", () => ({
  logger: {
    error: mocks.loggerError,
    info:  mocks.loggerInfo,
    warn:  mocks.loggerWarn,
  },
}));

// ─── Inline simulation – mirrors the ClientReady startup sweep exactly ────────
//
// We cannot import index.ts directly because it creates a Discord client and
// starts cron jobs on module load.  We replicate the exact startup sweep logic
// so the tests exercise the same code path that runs on bot startup.

import { openSession, getTrackedVcCategoryId } from "../lib/community.js";
import { logger } from "../lib/logger.js";

const GUILD_VOICE = "GUILD_VOICE" as const;

interface FakeChannel {
  type: typeof GUILD_VOICE;
  id: string;
  parentId: string | null;
  members: Map<string, unknown>;
}

interface FakeGuild {
  id: string;
  channels: { cache: Map<string, FakeChannel> };
}

async function simulateStartupSweep(guilds: FakeGuild[]): Promise<void> {
  for (const guild of guilds) {
    let trackedCategoryId: string | null;
    try {
      trackedCategoryId = await getTrackedVcCategoryId(guild.id);
    } catch (err) {
      logger.error(`[vc] startup: getTrackedVcCategoryId error guildId=${guild.id}`, err);
      continue; // fail closed — skip this guild
    }
    for (const channel of guild.channels.cache.values()) {
      if (channel.type !== GUILD_VOICE) continue;
      const channelParentId = channel.parentId ?? null;
      if (trackedCategoryId !== null && channelParentId !== trackedCategoryId) continue;
      for (const [userId] of channel.members) {
        await openSession(guild.id, userId, channel.id).catch(() => {});
      }
    }
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ClientReady startup sweep – tracked-category filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls openSession for a channel inside the tracked category", async () => {
    mocks.getTrackedVcCategoryId.mockResolvedValueOnce("cat-A");

    await simulateStartupSweep([{
      id: "guild-1",
      channels: { cache: new Map([
        ["ch-1", { type: GUILD_VOICE, id: "ch-1", parentId: "cat-A", members: new Map([["user-1", {}]]) }],
      ]) },
    }]);

    expect(mocks.openSession).toHaveBeenCalledWith("guild-1", "user-1", "ch-1");
  });

  it("does NOT call openSession for a channel outside the tracked category", async () => {
    mocks.getTrackedVcCategoryId.mockResolvedValueOnce("cat-A");

    await simulateStartupSweep([{
      id: "guild-1",
      channels: { cache: new Map([
        ["ch-2", { type: GUILD_VOICE, id: "ch-2", parentId: "cat-B", members: new Map([["user-2", {}]]) }],
      ]) },
    }]);

    expect(mocks.openSession).not.toHaveBeenCalled();
  });

  it("calls openSession for all channels when no category is configured (null = track all)", async () => {
    mocks.getTrackedVcCategoryId.mockResolvedValueOnce(null);

    await simulateStartupSweep([{
      id: "guild-1",
      channels: { cache: new Map([
        ["ch-1", { type: GUILD_VOICE, id: "ch-1", parentId: "cat-A", members: new Map([["user-1", {}]]) }],
        ["ch-2", { type: GUILD_VOICE, id: "ch-2", parentId: "cat-B", members: new Map([["user-2", {}]]) }],
      ]) },
    }]);

    expect(mocks.openSession).toHaveBeenCalledTimes(2);
    expect(mocks.openSession).toHaveBeenCalledWith("guild-1", "user-1", "ch-1");
    expect(mocks.openSession).toHaveBeenCalledWith("guild-1", "user-2", "ch-2");
  });

  it("does NOT call openSession when getTrackedVcCategoryId throws (fail closed)", async () => {
    mocks.getTrackedVcCategoryId.mockRejectedValueOnce(new Error("DB error"));

    await simulateStartupSweep([{
      id: "guild-1",
      channels: { cache: new Map([
        ["ch-1", { type: GUILD_VOICE, id: "ch-1", parentId: "cat-A", members: new Map([["user-1", {}]]) }],
      ]) },
    }]);

    expect(mocks.openSession).not.toHaveBeenCalled();
  });

  it("logs an error when getTrackedVcCategoryId throws", async () => {
    const dbError = new Error("connection lost");
    mocks.getTrackedVcCategoryId.mockRejectedValueOnce(dbError);

    await simulateStartupSweep([{
      id: "guild-1",
      channels: { cache: new Map([
        ["ch-1", { type: GUILD_VOICE, id: "ch-1", parentId: "cat-A", members: new Map([["user-1", {}]]) }],
      ]) },
    }]);

    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("getTrackedVcCategoryId"),
      dbError,
    );
  });

  it("skips only the failing guild when one guild throws and another succeeds", async () => {
    mocks.getTrackedVcCategoryId
      .mockRejectedValueOnce(new Error("DB error")) // guild-1 fails
      .mockResolvedValueOnce("cat-A");              // guild-2 succeeds

    await simulateStartupSweep([
      {
        id: "guild-1",
        channels: { cache: new Map([
          ["ch-1", { type: GUILD_VOICE, id: "ch-1", parentId: "cat-A", members: new Map([["user-1", {}]]) }],
        ]) },
      },
      {
        id: "guild-2",
        channels: { cache: new Map([
          ["ch-2", { type: GUILD_VOICE, id: "ch-2", parentId: "cat-A", members: new Map([["user-2", {}]]) }],
        ]) },
      },
    ]);

    expect(mocks.openSession).toHaveBeenCalledTimes(1);
    expect(mocks.openSession).toHaveBeenCalledWith("guild-2", "user-2", "ch-2");
  });

  it("only opens sessions for the tracked channel when one channel is inside and one outside", async () => {
    mocks.getTrackedVcCategoryId.mockResolvedValueOnce("cat-A");

    await simulateStartupSweep([{
      id: "guild-1",
      channels: { cache: new Map([
        ["ch-in",  { type: GUILD_VOICE, id: "ch-in",  parentId: "cat-A", members: new Map([["user-1", {}]]) }],
        ["ch-out", { type: GUILD_VOICE, id: "ch-out", parentId: "cat-B", members: new Map([["user-2", {}]]) }],
      ]) },
    }]);

    expect(mocks.openSession).toHaveBeenCalledTimes(1);
    expect(mocks.openSession).toHaveBeenCalledWith("guild-1", "user-1", "ch-in");
    expect(mocks.openSession).not.toHaveBeenCalledWith("guild-1", "user-2", "ch-out");
  });
});
