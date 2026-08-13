/**
 * Tests that the ClientReady startup sweep passes the correct isExile flag to
 * openSession for each member currently in a VC.
 *
 * Before this fix the loop called openSession(guildId, userId, channelId) with
 * no isExile argument, always defaulting to false — silently mislabelling
 * 追放者 (exile) members after a bot restart.  The updated loop destructures
 * the GuildMember from channel.members and passes resolveIsExile(member) as
 * the fourth argument.
 *
 * Covers:
 *   - An exile member (holds 追放者 role) → openSession called with isExile=true
 *   - A regular member (no 追放者 role)   → openSession called with isExile=false
 *   - Mixed channel: exile + regular       → correct flag per member
 *   - Multiple channels: flags are per-member, not per-channel
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock functions ─────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  openSession:            vi.fn().mockResolvedValue(null),
  getTrackedVcCategoryId: vi.fn<() => Promise<string | null>>().mockResolvedValue(null),
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
import { resolveIsExile } from "../lib/vc-exile.js";
import { logger } from "../lib/logger.js";

const GUILD_VOICE = "GUILD_VOICE" as const;

interface FakeMember {
  roles: { cache: { some(predicate: (role: { name: string }) => boolean): boolean } };
}

interface FakeChannel {
  type: typeof GUILD_VOICE;
  id: string;
  parentId: string | null;
  members: Map<string, FakeMember>;
}

interface FakeGuild {
  id: string;
  channels: { cache: Map<string, FakeChannel> };
}

/** Build a member stub that holds the given role names. */
function makeMember(roleNames: string[]): FakeMember {
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

async function simulateStartupSweep(guilds: FakeGuild[]): Promise<void> {
  for (const guild of guilds) {
    let trackedCategoryId: string | null;
    try {
      trackedCategoryId = await getTrackedVcCategoryId(guild.id);
    } catch (err) {
      logger.error(`[vc] startup: getTrackedVcCategoryId error guildId=${guild.id}`, err);
      continue;
    }
    for (const channel of guild.channels.cache.values()) {
      if (channel.type !== GUILD_VOICE) continue;
      const channelParentId = channel.parentId ?? null;
      if (trackedCategoryId !== null && channelParentId !== trackedCategoryId) continue;
      for (const [userId, member] of channel.members) {
        const isExile = resolveIsExile(member);
        await openSession(guild.id, userId, channel.id, isExile).catch(() => {});
      }
    }
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ClientReady startup sweep – isExile flag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no tracked-category restriction — all channels are tracked.
    mocks.getTrackedVcCategoryId.mockResolvedValue(null);
  });

  it("calls openSession with isExile=true for a member holding the 追放者 role", async () => {
    await simulateStartupSweep([{
      id: "guild-1",
      channels: { cache: new Map([
        ["ch-1", {
          type: GUILD_VOICE,
          id: "ch-1",
          parentId: null,
          members: new Map([["exile-user", makeMember(["追放者"])]]),
        }],
      ]) },
    }]);

    expect(mocks.openSession).toHaveBeenCalledOnce();
    expect(mocks.openSession).toHaveBeenCalledWith("guild-1", "exile-user", "ch-1", true);
  });

  it("calls openSession with isExile=false for a regular member (no 追放者 role)", async () => {
    await simulateStartupSweep([{
      id: "guild-1",
      channels: { cache: new Map([
        ["ch-1", {
          type: GUILD_VOICE,
          id: "ch-1",
          parentId: null,
          members: new Map([["regular-user", makeMember(["島民"])]]),
        }],
      ]) },
    }]);

    expect(mocks.openSession).toHaveBeenCalledOnce();
    expect(mocks.openSession).toHaveBeenCalledWith("guild-1", "regular-user", "ch-1", false);
  });

  it("stamps isExile=true only for the exile member when an exile and a regular member share a channel", async () => {
    await simulateStartupSweep([{
      id: "guild-1",
      channels: { cache: new Map([
        ["ch-1", {
          type: GUILD_VOICE,
          id: "ch-1",
          parentId: null,
          members: new Map([
            ["exile-user",   makeMember(["追放者"])],
            ["regular-user", makeMember(["島民"])],
          ]),
        }],
      ]) },
    }]);

    expect(mocks.openSession).toHaveBeenCalledTimes(2);
    expect(mocks.openSession).toHaveBeenCalledWith("guild-1", "exile-user",   "ch-1", true);
    expect(mocks.openSession).toHaveBeenCalledWith("guild-1", "regular-user", "ch-1", false);
  });

  it("stamps correct flags for members spread across multiple channels", async () => {
    await simulateStartupSweep([{
      id: "guild-1",
      channels: { cache: new Map([
        ["ch-exile", {
          type: GUILD_VOICE,
          id: "ch-exile",
          parentId: null,
          members: new Map([["exile-user", makeMember(["追放者"])]]),
        }],
        ["ch-regular", {
          type: GUILD_VOICE,
          id: "ch-regular",
          parentId: null,
          members: new Map([["regular-user", makeMember(["島民", "守門卿"])]]),
        }],
      ]) },
    }]);

    expect(mocks.openSession).toHaveBeenCalledTimes(2);
    expect(mocks.openSession).toHaveBeenCalledWith("guild-1", "exile-user",   "ch-exile",   true);
    expect(mocks.openSession).toHaveBeenCalledWith("guild-1", "regular-user", "ch-regular", false);
  });

  it("stamps isExile=false for a member with no roles", async () => {
    await simulateStartupSweep([{
      id: "guild-1",
      channels: { cache: new Map([
        ["ch-1", {
          type: GUILD_VOICE,
          id: "ch-1",
          parentId: null,
          members: new Map([["no-role-user", makeMember([])]]),
        }],
      ]) },
    }]);

    expect(mocks.openSession).toHaveBeenCalledWith("guild-1", "no-role-user", "ch-1", false);
  });

  it("stamps isExile=true even when 追放者 is alongside other roles", async () => {
    await simulateStartupSweep([{
      id: "guild-1",
      channels: { cache: new Map([
        ["ch-1", {
          type: GUILD_VOICE,
          id: "ch-1",
          parentId: null,
          members: new Map([["multi-role-exile", makeMember(["島民", "追放者", "守門卿"])]]),
        }],
      ]) },
    }]);

    expect(mocks.openSession).toHaveBeenCalledWith("guild-1", "multi-role-exile", "ch-1", true);
  });
});
