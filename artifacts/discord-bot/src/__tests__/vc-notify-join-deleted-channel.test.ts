/**
 * Tests confirming that send is never called when the notify channel is absent
 * from guild.channels.cache during a straight VC join.
 *
 * These tests exercise the real production functions extracted from index.ts:
 *   - sendVcNotifyJoin  (lib/vcNotify.ts) — the notification sender itself
 *   - handleVcLogJoin   (lib/vcLogJoin.ts) — the full straight-join branch
 *
 * Both functions guard against a deleted notify channel by checking
 * guild.channels.cache before attempting to send.
 *
 * Scenarios covered:
 *   1. sendVcNotifyJoin is silent (no send, no throw) when notifyChannelId is
 *      absent from guild.channels.cache.
 *   2. handleVcLogJoin is silent (no send, no throw) when notifyChannelId is
 *      absent from guild.channels.cache (end-to-end straight-join path).
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import type { VoiceState } from "discord.js";

// ─── Hoist mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  getVcLogSettings: vi.fn(),
  recordVcLogJoin: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("../lib/vcReward.js", () => ({
  getVcLogSettings: mocks.getVcLogSettings,
  recordVcLogJoin: mocks.recordVcLogJoin,
}));

vi.mock("../lib/logger.js", () => ({
  logger: { error: mocks.loggerError, info: vi.fn() },
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────
import { sendVcNotifyJoin } from "../lib/vcNotify.js";
import { handleVcLogJoin } from "../lib/vcLogJoin.js";

// ─── Guild factory ────────────────────────────────────────────────────────────

/**
 * Builds a minimal guild-like object.
 *
 * @param channelEntries - Map entries to populate guild.channels.cache.
 *   Each entry is [channelId, { send: spy }]. Channels NOT in this map
 *   simulate the "channel has been deleted" condition.
 */
function makeGuild(
  channelEntries: Array<[string, { send: ReturnType<typeof vi.fn> }]> = [],
): VoiceState["guild"] {
  return {
    id: "guild-1",
    channels: { cache: new Map(channelEntries) },
    members: { cache: new Map() },
  } as unknown as VoiceState["guild"];
}

// ─── Tests: sendVcNotifyJoin ──────────────────────────────────────────────────

describe("sendVcNotifyJoin – notify channel absent from cache", () => {
  it("does not call send and does not throw when notifyChannelId is not in guild.channels.cache", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    // guild has "ch-join" but NOT "deleted-notify-ch"
    const guild = makeGuild([["ch-join", { send }]]);

    await expect(
      sendVcNotifyJoin(guild, "user-1", "ch-join", "deleted-notify-ch"),
    ).resolves.toBeUndefined();

    expect(send).not.toHaveBeenCalled();
  });

  it("does not call send and does not throw when guild.channels.cache is empty", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const guild = makeGuild(); // empty cache — no channels at all

    await expect(
      sendVcNotifyJoin(guild, "user-1", "ch-join", "notify-ch"),
    ).resolves.toBeUndefined();

    expect(send).not.toHaveBeenCalled();
  });
});

// ─── Tests: handleVcLogJoin ───────────────────────────────────────────────────

describe("handleVcLogJoin – notify channel absent from cache (straight-join path)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.recordVcLogJoin.mockResolvedValue(undefined);
  });

  it("does not call send and does not throw when notifyChannelId points to a deleted channel", async () => {
    mocks.getVcLogSettings.mockResolvedValue({
      notifyChannelId: "deleted-notify-ch",
      categoryIds: ["cat-1"],
    });

    const send = vi.fn().mockResolvedValue(undefined);
    // guild has "ch-join" (with a parent so it can be tracked) but NOT "deleted-notify-ch"
    const guild = {
      id: "guild-1",
      channels: {
        cache: new Map([
          // "ch-join" exists with a parentId so getLogCategoryId can resolve it
          ["ch-join", { send, parentId: "cat-1" }],
          // "deleted-notify-ch" is intentionally absent
        ]),
      },
      members: { cache: new Map() },
    } as unknown as VoiceState["guild"];

    await expect(
      handleVcLogJoin(guild, "user-1", "ch-join"),
    ).resolves.toBeUndefined();

    expect(send).not.toHaveBeenCalled();
  });

  it("does not call send and does not throw when notifyChannelId is null", async () => {
    mocks.getVcLogSettings.mockResolvedValue({
      notifyChannelId: null,
      categoryIds: ["cat-1"],
    });

    const send = vi.fn().mockResolvedValue(undefined);
    const guild = makeGuild([["ch-join", { send }]]);

    await expect(
      handleVcLogJoin(guild, "user-1", "ch-join"),
    ).resolves.toBeUndefined();

    expect(send).not.toHaveBeenCalled();
  });
});
