/**
 * Tests for the VC leave-notification duration display added to the
 * voiceStateUpdate handler (sendVcNotifyLeave with joinedAt derived from
 * recordVcLogLeave's returned durationSeconds or getVcLogPresence).
 *
 * Because index.ts creates a Discord client on import, we inline the exact
 * notification + session-log logic and inject mock dependencies — same pattern
 * as vc-delete-scheduler.test.ts.
 *
 * Scenarios covered:
 *   Leave (to nothing / AFK):
 *     1. Duration suffix 「滞在: X分Y秒」 appears when recordVcLogLeave returns durationSeconds.
 *     2. No suffix when recordVcLogLeave returns undefined (no prior presence row).
 *
 *   Move tracked → untracked:
 *     3. Duration suffix appears in leave notification.
 *     4. No suffix when no presence row exists.
 *
 *   Move tracked → tracked (different category):
 *     5. Leave notification carries the duration suffix (read from getVcLogPresence).
 *     6. getVcLogPresence is called — session NOT mutated via recordVcLogLeave/Join.
 *     7. Join notification is sent for the new channel.
 *     8. No suffix when getVcLogPresence returns undefined.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  getVcLogSettings: vi.fn(),
  getVcLogPresence: vi.fn(),
  recordVcLogLeave: vi.fn(),
  recordVcLogJoin: vi.fn(),
  loggerError: vi.fn(),
  loggerInfo: vi.fn(),
  channelSend: vi.fn(),
}));

vi.mock("../lib/vcReward.js", () => ({
  getVcLogSettings: mocks.getVcLogSettings,
  getVcLogPresence: mocks.getVcLogPresence,
  recordVcLogLeave: mocks.recordVcLogLeave,
  recordVcLogJoin: mocks.recordVcLogJoin,
}));

vi.mock("../lib/logger.js", () => ({
  logger: { info: mocks.loggerInfo, error: mocks.loggerError },
}));

import {
  getVcLogSettings,
  getVcLogPresence,
  recordVcLogLeave,
  recordVcLogJoin,
} from "../lib/vcReward.js";

// ─── Inline helpers (mirrors index.ts exactly) ────────────────────────────────

type FakeGuild = {
  id: string;
  channels: { cache: Map<string, { send: ReturnType<typeof vi.fn> }> };
};

function makeGuild(channelSend: ReturnType<typeof vi.fn>): FakeGuild {
  return {
    id: "guild-1",
    channels: { cache: new Map([["ch-old", { send: channelSend }]]) },
  };
}

/**
 * Mirrors sendVcNotifyLeave from index.ts.
 * The notify channel ID must be a key in guild.channels.cache.
 */
async function sendVcNotifyLeave(
  guild: FakeGuild,
  userId: string,
  channelId: string,
  notifyChannelId: string,
  joinedAt?: Date,
): Promise<void> {
  try {
    const ch = guild.channels.cache.get(notifyChannelId);
    if (!ch || !("send" in ch)) return;
    let suffix = "";
    if (joinedAt) {
      const secs = Math.floor((Date.now() - joinedAt.getTime()) / 1000);
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      suffix = `（滞在: ${m}分${s}秒）`;
    }
    await ch.send(`🔇 <@${userId}> が <#${channelId}> から退出しました${suffix}`);
  } catch {
    // 通知失敗は無視
  }
}

async function sendVcNotifyJoin(
  guild: FakeGuild,
  userId: string,
  channelId: string,
  notifyChannelId: string,
): Promise<void> {
  try {
    const ch = guild.channels.cache.get(notifyChannelId);
    if (!ch || !("send" in ch)) return;
    await ch.send(`🔊 <@${userId}> が <#${channelId}> に参加しました`);
  } catch {
    // 通知失敗は無視
  }
}

function getLogCategoryId(
  channelId: string,
  categoryIds: string[],
  channelParentMap: Map<string, string | null>,
): string | null {
  if (categoryIds.length === 0) return null;
  const parentId = channelParentMap.get(channelId) ?? null;
  if (!parentId) return null;
  return categoryIds.includes(parentId) ? parentId : null;
}

// ─── Inlined leave handler (straight-leave path) ─────────────────────────────
// Mirrors the "Left VC" branch of the voiceStateUpdate handler.

async function handleLeave(
  guild: FakeGuild,
  userId: string,
  oldChannelId: string,
): Promise<void> {
  try {
    const logSettings = await getVcLogSettings(guild.id);
    const leaveResult = await recordVcLogLeave(guild.id, userId);
    if (logSettings.notifyChannelId) {
      const joinedAt = leaveResult
        ? new Date(Date.now() - leaveResult.durationSeconds * 1000)
        : undefined;
      await sendVcNotifyLeave(guild, userId, oldChannelId, logSettings.notifyChannelId, joinedAt);
    }
  } catch (err) {
    mocks.loggerError(`[vclog] recordVcLogLeave error for ${userId}`, err);
  }
}

// ─── Inlined move handler (session-log + notify portion) ─────────────────────
// Mirrors the "Moved between two non-AFK VCs" branch of the voiceStateUpdate handler.

async function handleMove(
  guild: FakeGuild,
  userId: string,
  oldChannelId: string,
  newChannelId: string,
  channelParentMap: Map<string, string | null>,
): Promise<void> {
  try {
    const logSettings = await getVcLogSettings(guild.id);
    const categoryIds: string[] = logSettings.categoryIds ?? [];
    const wasLogCat = getLogCategoryId(oldChannelId, categoryIds, channelParentMap);
    const nowLogCat = getLogCategoryId(newChannelId, categoryIds, channelParentMap);

    if (wasLogCat && !nowLogCat) {
      // tracked → untracked: settle session, show duration in leave notification
      const leaveResult = await recordVcLogLeave(guild.id, userId);
      if (logSettings.notifyChannelId) {
        const joinedAt = leaveResult
          ? new Date(Date.now() - leaveResult.durationSeconds * 1000)
          : undefined;
        await sendVcNotifyLeave(guild, userId, oldChannelId, logSettings.notifyChannelId, joinedAt);
      }
    } else if (!wasLogCat && nowLogCat) {
      await recordVcLogJoin(guild.id, userId, newChannelId, nowLogCat);
      if (logSettings.notifyChannelId) {
        await sendVcNotifyJoin(guild, userId, newChannelId, logSettings.notifyChannelId);
      }
    } else if (wasLogCat && nowLogCat && logSettings.notifyChannelId) {
      // Both tracked: notify move only (session tracking continues uninterrupted)
      const presence = await getVcLogPresence(guild.id, userId);
      await sendVcNotifyLeave(guild, userId, oldChannelId, logSettings.notifyChannelId, presence?.joinedAt);
      await sendVcNotifyJoin(guild, userId, newChannelId, logSettings.notifyChannelId);
    }
  } catch (err) {
    mocks.loggerError(`[vclog] channel-move log error for ${userId}`, err);
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const NOTIFY_CH = "ch-old"; // re-use the channel the guild has in cache

describe("sendVcNotifyLeave – duration suffix", () => {
  it("includes 「滞在: X分Y秒」 when joinedAt is provided", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const guild = makeGuild(send);
    const joinedAt = new Date(Date.now() - 90 * 1000); // 1分30秒前

    await sendVcNotifyLeave(guild, "user-1", "ch-old", NOTIFY_CH, joinedAt);

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toMatch(/滞在: 1分30秒/);
  });

  it("omits the duration suffix when joinedAt is not provided", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const guild = makeGuild(send);

    await sendVcNotifyLeave(guild, "user-1", "ch-old", NOTIFY_CH);

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).not.toMatch(/滞在/);
  });
});

describe("handleLeave – straight leave duration propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getVcLogSettings.mockResolvedValue({
      notifyChannelId: NOTIFY_CH,
      categoryIds: ["cat-1"],
    });
  });

  it("shows duration in the leave notification when a presence row existed", async () => {
    mocks.recordVcLogLeave.mockResolvedValue({ durationSeconds: 125 }); // 2分5秒
    const send = vi.fn().mockResolvedValue(undefined);
    const guild = makeGuild(send);

    await handleLeave(guild, "user-1", "ch-old");

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toMatch(/滞在: 2分5秒/);
  });

  it("omits duration when recordVcLogLeave returns undefined (no presence row)", async () => {
    mocks.recordVcLogLeave.mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    const guild = makeGuild(send);

    await handleLeave(guild, "user-1", "ch-old");

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).not.toMatch(/滞在/);
  });
});

describe("handleMove – tracked → untracked", () => {
  const parentMap = new Map([
    ["ch-old", "cat-1"],   // tracked
    ["ch-new", "cat-99"],  // not tracked
  ]);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getVcLogSettings.mockResolvedValue({
      notifyChannelId: NOTIFY_CH,
      categoryIds: ["cat-1"],
    });
  });

  it("shows duration in leave notification when presence row existed", async () => {
    mocks.recordVcLogLeave.mockResolvedValue({ durationSeconds: 60 }); // 1分0秒
    const send = vi.fn().mockResolvedValue(undefined);
    const guild = makeGuild(send);

    await handleMove(guild, "user-1", "ch-old", "ch-new", parentMap);

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toMatch(/滞在: 1分0秒/);
  });

  it("omits duration when no presence row existed", async () => {
    mocks.recordVcLogLeave.mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    const guild = makeGuild(send);

    await handleMove(guild, "user-1", "ch-old", "ch-new", parentMap);

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).not.toMatch(/滞在/);
  });
});

describe("handleMove – tracked → tracked (different category)", () => {
  const parentMap = new Map([
    ["ch-old", "cat-1"],  // tracked
    ["ch-new", "cat-2"],  // also tracked
  ]);

  function makeGuildWithTwo(send: ReturnType<typeof vi.fn>): FakeGuild {
    return {
      id: "guild-1",
      channels: {
        cache: new Map([
          ["ch-old", { send }],
          ["ch-new", { send }],
        ]),
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getVcLogSettings.mockResolvedValue({
      notifyChannelId: NOTIFY_CH,
      categoryIds: ["cat-1", "cat-2"],
    });
  });

  it("calls getVcLogPresence (not recordVcLogLeave) so session is not terminated", async () => {
    mocks.getVcLogPresence.mockResolvedValue({ joinedAt: new Date(Date.now() - 120 * 1000) });
    const send = vi.fn().mockResolvedValue(undefined);
    const guild = makeGuildWithTwo(send);

    await handleMove(guild, "user-1", "ch-old", "ch-new", parentMap);

    expect(mocks.getVcLogPresence).toHaveBeenCalledOnce();
    expect(mocks.getVcLogPresence).toHaveBeenCalledWith("guild-1", "user-1");
    expect(mocks.recordVcLogLeave).not.toHaveBeenCalled();
    expect(mocks.recordVcLogJoin).not.toHaveBeenCalled();
  });

  it("shows duration in leave notification when presence row existed", async () => {
    mocks.getVcLogPresence.mockResolvedValue({ joinedAt: new Date(Date.now() - 185 * 1000) }); // 3分5秒
    const send = vi.fn().mockResolvedValue(undefined);
    const guild = makeGuildWithTwo(send);

    await handleMove(guild, "user-1", "ch-old", "ch-new", parentMap);

    const leaveCalls = send.mock.calls
      .map((c) => c[0] as string)
      .filter((msg) => msg.includes("退出"));
    expect(leaveCalls).toHaveLength(1);
    expect(leaveCalls[0]).toMatch(/滞在: 3分5秒/);
  });

  it("omits duration when getVcLogPresence returns undefined", async () => {
    mocks.getVcLogPresence.mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    const guild = makeGuildWithTwo(send);

    await handleMove(guild, "user-1", "ch-old", "ch-new", parentMap);

    const leaveCalls = send.mock.calls
      .map((c) => c[0] as string)
      .filter((msg) => msg.includes("退出"));
    expect(leaveCalls).toHaveLength(1);
    expect(leaveCalls[0]).not.toMatch(/滞在/);
  });

  it("sends both a leave and a join notification", async () => {
    mocks.getVcLogPresence.mockResolvedValue({ joinedAt: new Date(Date.now() - 30 * 1000) });
    const send = vi.fn().mockResolvedValue(undefined);
    const guild = makeGuildWithTwo(send);

    await handleMove(guild, "user-1", "ch-old", "ch-new", parentMap);

    const msgs = send.mock.calls.map((c) => c[0] as string);
    expect(msgs.some((m) => m.includes("退出"))).toBe(true);
    expect(msgs.some((m) => m.includes("参加"))).toBe(true);
  });
});
