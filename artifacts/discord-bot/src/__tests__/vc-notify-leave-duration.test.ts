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
 *   Straight leave – notify channel deleted:
 *     5. send is never called (and no error propagates) when notifyChannelId
 *        points to a channel that is no longer in guild.channels.cache.
 *
 *   Move untracked → tracked:
 *     6. sendVcNotifyJoin fires with the new channel.
 *     7. recordVcLogLeave is NOT called.
 *     8. recordVcLogJoin is called with the new channel and its category.
 *     9. sendVcNotifyJoin is suppressed when notifyChannelId is null.
 *
 *   Move tracked → tracked (different category):
 *     9.  Leave notification carries the duration suffix (read from getVcLogPresence).
 *     10. getVcLogPresence is called — session NOT mutated via recordVcLogLeave/Join.
 *     11. Join notification is sent for the new channel.
 *     12. No suffix when getVcLogPresence returns undefined.
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

import { handleVcLogMove, type VcLogMoveNotify } from "../lib/vcLogMove.js";

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

// ─── Helpers for handleVcLogMove tests ───────────────────────────────────────

/** Build the channelParentId callback that handleVcLogMove expects. */
function makeChannelParentId(map: Map<string, string | null>) {
  return (channelId: string) => map.get(channelId) ?? null;
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

  it("does not call send and does not throw when the notify channel has been deleted", async () => {
    // notifyChannelId points to a channel that is NOT in guild.channels.cache
    mocks.getVcLogSettings.mockResolvedValue({
      notifyChannelId: "deleted-notify-ch",
      categoryIds: ["cat-1"],
    });
    mocks.recordVcLogLeave.mockResolvedValue({ durationSeconds: 60 });
    const send = vi.fn().mockResolvedValue(undefined);
    // guild only has "ch-old" in cache — "deleted-notify-ch" is absent
    const guild = makeGuild(send);

    await expect(handleLeave(guild, "user-1", "ch-old")).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});

// ─── handleVcLogMove tests — exercise the real production function ────────────

describe("handleVcLogMove – tracked → untracked", () => {
  const channelParentId = makeChannelParentId(new Map([
    ["ch-old", "cat-1"],   // tracked
    ["ch-new", "cat-99"],  // not tracked
  ]));

  let sendJoin: ReturnType<typeof vi.fn>;
  let sendLeave: ReturnType<typeof vi.fn>;
  let notify: VcLogMoveNotify;

  beforeEach(() => {
    vi.clearAllMocks();
    sendJoin = vi.fn().mockResolvedValue(undefined);
    sendLeave = vi.fn().mockResolvedValue(undefined);
    notify = { sendJoin, sendLeave };
    mocks.getVcLogSettings.mockResolvedValue({
      notifyChannelId: "notify-ch",
      categoryIds: ["cat-1"],
    });
  });

  it("shows duration in leave notification when presence row existed", async () => {
    mocks.recordVcLogLeave.mockResolvedValue({ durationSeconds: 60 });

    await handleVcLogMove("guild-1", "user-1", "ch-old", "ch-new", channelParentId, notify);

    expect(sendLeave).toHaveBeenCalledOnce();
    const [uid, channelId, notifyChannelId, joinedAt] = sendLeave.mock.calls[0];
    expect(uid).toBe("user-1");
    expect(channelId).toBe("ch-old");
    expect(notifyChannelId).toBe("notify-ch");
    expect(joinedAt).toBeInstanceOf(Date);
  });

  it("omits duration when no presence row existed", async () => {
    mocks.recordVcLogLeave.mockResolvedValue(undefined);

    await handleVcLogMove("guild-1", "user-1", "ch-old", "ch-new", channelParentId, notify);

    expect(sendLeave).toHaveBeenCalledOnce();
    const [, , , joinedAt] = sendLeave.mock.calls[0];
    expect(joinedAt).toBeUndefined();
  });

  it("does not call sendLeave when notifyChannelId is null", async () => {
    mocks.getVcLogSettings.mockResolvedValue({
      notifyChannelId: null,
      categoryIds: ["cat-1"],
    });
    mocks.recordVcLogLeave.mockResolvedValue({ durationSeconds: 60 });

    await handleVcLogMove("guild-1", "user-1", "ch-old", "ch-new", channelParentId, notify);

    expect(sendLeave).not.toHaveBeenCalled();
  });
});

describe("handleVcLogMove – untracked → tracked", () => {
  const channelParentId = makeChannelParentId(new Map([
    ["ch-old", "cat-99"], // NOT tracked
    ["ch-new", "cat-1"],  // tracked
  ]));

  let sendJoin: ReturnType<typeof vi.fn>;
  let sendLeave: ReturnType<typeof vi.fn>;
  let notify: VcLogMoveNotify;

  beforeEach(() => {
    vi.clearAllMocks();
    sendJoin = vi.fn().mockResolvedValue(undefined);
    sendLeave = vi.fn().mockResolvedValue(undefined);
    notify = { sendJoin, sendLeave };
    mocks.getVcLogSettings.mockResolvedValue({
      notifyChannelId: "notify-ch",
      categoryIds: ["cat-1"],
    });
    mocks.recordVcLogJoin.mockResolvedValue(undefined);
  });

  it("fires sendVcNotifyJoin with the new channel", async () => {
    await handleVcLogMove("guild-1", "user-1", "ch-old", "ch-new", channelParentId, notify);

    expect(sendJoin).toHaveBeenCalledOnce();
    expect(sendJoin).toHaveBeenCalledWith("user-1", "ch-new", "notify-ch");
  });

  it("does not call recordVcLogLeave", async () => {
    await handleVcLogMove("guild-1", "user-1", "ch-old", "ch-new", channelParentId, notify);

    expect(mocks.recordVcLogLeave).not.toHaveBeenCalled();
  });

  it("calls recordVcLogJoin with the new channel and its category", async () => {
    await handleVcLogMove("guild-1", "user-1", "ch-old", "ch-new", channelParentId, notify);

    expect(mocks.recordVcLogJoin).toHaveBeenCalledOnce();
    expect(mocks.recordVcLogJoin).toHaveBeenCalledWith("guild-1", "user-1", "ch-new", "cat-1");
  });

  it("does not call sendJoin when notifyChannelId is null", async () => {
    mocks.getVcLogSettings.mockResolvedValue({
      notifyChannelId: null,
      categoryIds: ["cat-1"],
    });

    await handleVcLogMove("guild-1", "user-1", "ch-old", "ch-new", channelParentId, notify);

    expect(sendJoin).not.toHaveBeenCalled();
    // session tracking still happens
    expect(mocks.recordVcLogJoin).toHaveBeenCalledOnce();
  });
});

describe("handleVcLogMove – tracked → tracked (different category)", () => {
  const channelParentId = makeChannelParentId(new Map([
    ["ch-old", "cat-1"],  // tracked
    ["ch-new", "cat-2"],  // also tracked
  ]));

  let sendJoin: ReturnType<typeof vi.fn>;
  let sendLeave: ReturnType<typeof vi.fn>;
  let notify: VcLogMoveNotify;

  beforeEach(() => {
    vi.clearAllMocks();
    sendJoin = vi.fn().mockResolvedValue(undefined);
    sendLeave = vi.fn().mockResolvedValue(undefined);
    notify = { sendJoin, sendLeave };
    mocks.getVcLogSettings.mockResolvedValue({
      notifyChannelId: "notify-ch",
      categoryIds: ["cat-1", "cat-2"],
    });
  });

  it("calls getVcLogPresence (not recordVcLogLeave) so session is not terminated", async () => {
    mocks.getVcLogPresence.mockResolvedValue({ joinedAt: new Date(Date.now() - 120 * 1000) });

    await handleVcLogMove("guild-1", "user-1", "ch-old", "ch-new", channelParentId, notify);

    expect(mocks.getVcLogPresence).toHaveBeenCalledOnce();
    expect(mocks.getVcLogPresence).toHaveBeenCalledWith("guild-1", "user-1");
    expect(mocks.recordVcLogLeave).not.toHaveBeenCalled();
    expect(mocks.recordVcLogJoin).not.toHaveBeenCalled();
  });

  it("passes joinedAt from getVcLogPresence to sendLeave", async () => {
    const joinedAt = new Date(Date.now() - 185 * 1000); // 3分5秒
    mocks.getVcLogPresence.mockResolvedValue({ joinedAt });

    await handleVcLogMove("guild-1", "user-1", "ch-old", "ch-new", channelParentId, notify);

    expect(sendLeave).toHaveBeenCalledOnce();
    const [, , , passedJoinedAt] = sendLeave.mock.calls[0];
    expect(passedJoinedAt).toBe(joinedAt);
  });

  it("omits joinedAt when getVcLogPresence returns undefined", async () => {
    mocks.getVcLogPresence.mockResolvedValue(undefined);

    await handleVcLogMove("guild-1", "user-1", "ch-old", "ch-new", channelParentId, notify);

    expect(sendLeave).toHaveBeenCalledOnce();
    const [, , , joinedAt] = sendLeave.mock.calls[0];
    expect(joinedAt).toBeUndefined();
  });

  it("sends both a leave and a join notification", async () => {
    mocks.getVcLogPresence.mockResolvedValue({ joinedAt: new Date(Date.now() - 30 * 1000) });

    await handleVcLogMove("guild-1", "user-1", "ch-old", "ch-new", channelParentId, notify);

    expect(sendLeave).toHaveBeenCalledOnce();
    expect(sendLeave).toHaveBeenCalledWith("user-1", "ch-old", "notify-ch", expect.any(Date));
    expect(sendJoin).toHaveBeenCalledOnce();
    expect(sendJoin).toHaveBeenCalledWith("user-1", "ch-new", "notify-ch");
  });
});
