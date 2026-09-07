/**
 * Tests that the production VoiceStateUpdate handler (handleVoiceStateUpdate
 * from lib/vc-session-handler.ts, which index.ts delegates to for every
 * VoiceStateUpdate event) preserves the exile flag correctly during a channel
 * move.
 *
 * Because we import the real production function, removing or changing the
 * resolveIsExile call in vc-session-handler.ts will cause these tests to fail,
 * giving us the regression guarantee the task requires.
 *
 * A "move" event has BOTH oldChannelId and newChannelId set (and they differ).
 *
 * Covers:
 *   1. 追放者 member moves channel → openVcSessionIfTracked called with isExile=true
 *   2. Non-exile member moves channel → openVcSessionIfTracked called with isExile=false
 *   3. closeSessionAndGetDuration is always called for the source channel (exile member)
 *   4. closeSessionAndGetDuration is always called for the source channel (non-exile member)
 *   5. Correct guildId, userId, and destination channelId are forwarded
 *   6. channelParentId is forwarded when set
 *   7. channelParentId falls back to null when absent
 *   8. 追放者 alongside other roles still yields isExile=true
 *   9. null member falls back to isExile=false (safe fallback)
 *  10. No error logged during a normal channel move
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock functions ─────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  openVcSessionIfTracked: vi.fn(),
  closeSessionAndGetDuration: vi.fn(),
  loggerError: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
}));

// ─── Mock community lib ───────────────────────────────────────────────────────
vi.mock("../lib/community.js", () => ({
  openVcSessionIfTracked: mocks.openVcSessionIfTracked,
  closeSessionAndGetDuration: mocks.closeSessionAndGetDuration,
}));

// ─── Mock logger ──────────────────────────────────────────────────────────────
vi.mock("../lib/logger.js", () => ({
  logger: {
    error: mocks.loggerError,
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
  },
}));

// ─── Import the real production handler ──────────────────────────────────────
//
// This is what index.ts calls for every VoiceStateUpdate event. Tests here
// exercise the actual production function — any change to the isExile wiring
// inside vc-session-handler.ts will be caught immediately.
import { handleVoiceStateUpdate } from "../lib/vc-session-handler.js";
import { openVcSessionIfTracked, closeSessionAndGetDuration } from "../lib/community.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMember(roleNames: string[]) {
  const roles = roleNames.map((name) => ({ name }));
  return {
    roles: {
      cache: {
        some(predicate: (role: { name: string }) => boolean): boolean {
          return roles.some(predicate);
        },
      },
    },
  };
}

const BASE = {
  guildId: "guild-1",
  userId: "user-1",
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("handleVoiceStateUpdate (production) – exile flag preserved on channel move", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.closeSessionAndGetDuration.mockResolvedValue(60); // 60-second session
    mocks.openVcSessionIfTracked.mockResolvedValue(undefined);
  });

  // ── Case 1: 追放者 member moves → isExile=true ──────────────────────────────

  it("calls openVcSessionIfTracked with isExile=true when the moving member holds 追放者", async () => {
    await handleVoiceStateUpdate({
      ...BASE,
      oldChannelId: "channel-A",
      newChannelId: "channel-B",
      channelParentId: null,
      member: makeMember(["追放者"]),
    });

    expect(openVcSessionIfTracked).toHaveBeenCalledOnce();
    expect(openVcSessionIfTracked).toHaveBeenCalledWith(
      BASE.guildId,
      BASE.userId,
      "channel-B",
      null,
      true, // isExile
    );
  });

  // ── Case 2: non-exile member moves → isExile=false ──────────────────────────

  it("calls openVcSessionIfTracked with isExile=false when the moving member lacks 追放者", async () => {
    await handleVoiceStateUpdate({
      ...BASE,
      oldChannelId: "channel-A",
      newChannelId: "channel-B",
      channelParentId: null,
      member: makeMember(["島民"]),
    });

    expect(openVcSessionIfTracked).toHaveBeenCalledOnce();
    expect(openVcSessionIfTracked).toHaveBeenCalledWith(
      BASE.guildId,
      BASE.userId,
      "channel-B",
      null,
      false, // isExile
    );
  });

  // ── Case 3: closeSessionAndGetDuration called for exile member ───────────────

  it("calls closeSessionAndGetDuration for the source channel when member is 追放者", async () => {
    await handleVoiceStateUpdate({
      ...BASE,
      oldChannelId: "channel-A",
      newChannelId: "channel-B",
      channelParentId: null,
      member: makeMember(["追放者"]),
    });

    expect(closeSessionAndGetDuration).toHaveBeenCalledOnce();
    expect(closeSessionAndGetDuration).toHaveBeenCalledWith(BASE.guildId, BASE.userId);
  });

  // ── Case 4: closeSessionAndGetDuration called for non-exile member ───────────

  it("calls closeSessionAndGetDuration for the source channel when member is not 追放者", async () => {
    await handleVoiceStateUpdate({
      ...BASE,
      oldChannelId: "channel-A",
      newChannelId: "channel-B",
      channelParentId: null,
      member: makeMember(["島民"]),
    });

    expect(closeSessionAndGetDuration).toHaveBeenCalledOnce();
    expect(closeSessionAndGetDuration).toHaveBeenCalledWith(BASE.guildId, BASE.userId);
  });

  // ── Case 5: correct guildId, userId, destination channelId ──────────────────

  it("forwards the correct guildId, userId, and destination channelId to openVcSessionIfTracked", async () => {
    await handleVoiceStateUpdate({
      guildId: "guild-99",
      userId: "user-42",
      oldChannelId: "src-channel",
      newChannelId: "dst-channel",
      channelParentId: null,
      member: makeMember(["追放者"]),
    });

    expect(openVcSessionIfTracked).toHaveBeenCalledWith(
      "guild-99",
      "user-42",
      "dst-channel",
      null,
      true,
    );
  });

  // ── Case 6: channelParentId is forwarded ─────────────────────────────────────

  it("forwards channelParentId to openVcSessionIfTracked when set on the destination channel", async () => {
    await handleVoiceStateUpdate({
      ...BASE,
      oldChannelId: "channel-A",
      newChannelId: "channel-B",
      channelParentId: "category-X",
      member: makeMember(["追放者"]),
    });

    expect(openVcSessionIfTracked).toHaveBeenCalledWith(
      BASE.guildId,
      BASE.userId,
      "channel-B",
      "category-X",
      true,
    );
  });

  // ── Case 7: channelParentId null when absent ─────────────────────────────────

  it("passes null as channelParentId when the destination channel has no parent", async () => {
    await handleVoiceStateUpdate({
      ...BASE,
      oldChannelId: "channel-A",
      newChannelId: "channel-B",
      channelParentId: null,
      member: makeMember(["島民"]),
    });

    expect(openVcSessionIfTracked).toHaveBeenCalledWith(
      BASE.guildId,
      BASE.userId,
      "channel-B",
      null,
      false,
    );
  });

  // ── Case 8: 追放者 alongside other roles still yields isExile=true ────────────

  it("calls openVcSessionIfTracked with isExile=true when 追放者 is present alongside other roles", async () => {
    await handleVoiceStateUpdate({
      ...BASE,
      oldChannelId: "channel-A",
      newChannelId: "channel-B",
      channelParentId: null,
      member: makeMember(["島民", "追放者", "守門卿"]),
    });

    expect(openVcSessionIfTracked).toHaveBeenCalledWith(
      BASE.guildId,
      BASE.userId,
      "channel-B",
      null,
      true,
    );
  });

  // ── Case 9: null member falls back to isExile=false ──────────────────────────

  it("calls openVcSessionIfTracked with isExile=false when member is null (safe fallback)", async () => {
    await handleVoiceStateUpdate({
      ...BASE,
      oldChannelId: "channel-A",
      newChannelId: "channel-B",
      channelParentId: null,
      member: null,
    });

    expect(openVcSessionIfTracked).toHaveBeenCalledWith(
      BASE.guildId,
      BASE.userId,
      "channel-B",
      null,
      false,
    );
  });

  // ── Case 10: no error logged on normal move ───────────────────────────────────

  it("does not log any error during a normal channel move", async () => {
    await handleVoiceStateUpdate({
      ...BASE,
      oldChannelId: "channel-A",
      newChannelId: "channel-B",
      channelParentId: null,
      member: makeMember(["追放者"]),
    });

    expect(mocks.loggerError).not.toHaveBeenCalled();
  });
});
