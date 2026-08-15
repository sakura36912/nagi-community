/**
 * Tests for the ClientReady tavern-seed loop in index.ts.
 *
 * Because index.ts creates a Discord client on import (and immediately logs in),
 * we cannot import it directly.  Instead we inline the exact seed logic and
 * inject mock guilds — the same pattern used in vc-expiry-scheduler.test.ts.
 *
 * Scenarios covered:
 *   1. Members in a tavern VC (name matches) ARE seeded via onTavernJoin.
 *   2. Members in a non-tavern VC (name does not match) are NOT seeded.
 *   3. Members with no channelId in their voice state are skipped.
 *   4. Members whose channel is not in the guild channel cache are skipped.
 *   5. Multiple guilds: tavern members in each guild are independently seeded.
 *   6. When getTavernChannelNames rejects, the fallback empty set is used and
 *      no members are seeded (rather than crashing).
 *   7. Non-tavern member and tavern member coexist: only the tavern member is seeded.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  getTavernChannelNames: vi.fn(),
  onTavernJoin: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("../lib/chestTracker.js", () => ({
  getTavernChannelNames: mocks.getTavernChannelNames,
  onTavernJoin: mocks.onTavernJoin,
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    info: mocks.loggerInfo,
    error: mocks.loggerError,
  },
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────
import { getTavernChannelNames, onTavernJoin } from "../lib/chestTracker.js";
import { logger } from "../lib/logger.js";

// ─── Inline seed logic ───────────────────────────────────────────────────────
// Mirrors the ClientReady tavern-seed loop from index.ts exactly, but accepts
// a readyClient parameter so tests can inject a mock.

type MockChannel = { name: string };
type MockVoiceState = { channelId: string | null; id: string };
type MockGuild = {
  id: string;
  channels: { cache: Map<string, MockChannel> };
  voiceStates: { cache: Map<string, MockVoiceState> };
};
type MockReadyClient = {
  guilds: { cache: Map<string, MockGuild> };
};

async function runStartupTavernSeed(readyClient: MockReadyClient): Promise<number> {
  let tavernSeedCount = 0;
  for (const guild of readyClient.guilds.cache.values()) {
    const tavernNames = await getTavernChannelNames(guild.id).catch(() => undefined);
    for (const voiceState of guild.voiceStates.cache.values()) {
      const channelId = voiceState.channelId;
      if (!channelId) continue;
      const ch = guild.channels.cache.get(channelId);
      if (!ch) continue;
      const names =
        tavernNames ?? (await getTavernChannelNames(guild.id).catch(() => new Set<string>()));
      if (!names.has(ch.name)) continue;
      const userId = voiceState.id;
      onTavernJoin(guild.id, userId);
      tavernSeedCount++;
    }
  }
  if (tavernSeedCount > 0) {
    logger.info(`[chest] Seeded ${tavernSeedCount} tavern member(s) into tracker on startup`);
  }
  return tavernSeedCount;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const TAVERN_NAMES = new Set(["大酒場🍺", "小酒場🍺"]);
const NON_TAVERN_NAME = "general-voice";

function makeReadyClient(guilds: MockGuild[]): MockReadyClient {
  return {
    guilds: {
      cache: new Map(guilds.map((g) => [g.id, g])),
    },
  };
}

function makeGuild(
  id: string,
  voiceStates: MockVoiceState[],
  channels: MockChannel[],
  channelIds: string[],
): MockGuild {
  return {
    id,
    channels: {
      cache: new Map(channels.map((ch, i) => [channelIds[i], ch])),
    },
    voiceStates: {
      cache: new Map(voiceStates.map((vs, i) => [`vs-${i}`, vs])),
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("startup tavern seed – tavern members are seeded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTavernChannelNames.mockResolvedValue(TAVERN_NAMES);
    mocks.onTavernJoin.mockReturnValue(undefined);
  });

  it("calls onTavernJoin for a member sitting in a tavern VC at startup", async () => {
    const guild = makeGuild(
      "guild-1",
      [{ channelId: "ch-tavern", id: "user-1" }],
      [{ name: "大酒場🍺" }],
      ["ch-tavern"],
    );

    await runStartupTavernSeed(makeReadyClient([guild]));

    expect(mocks.onTavernJoin).toHaveBeenCalledOnce();
    expect(mocks.onTavernJoin).toHaveBeenCalledWith("guild-1", "user-1");
  });

  it("calls onTavernJoin for a member in the small tavern VC (小酒場🍺)", async () => {
    const guild = makeGuild(
      "guild-1",
      [{ channelId: "ch-small", id: "user-2" }],
      [{ name: "小酒場🍺" }],
      ["ch-small"],
    );

    await runStartupTavernSeed(makeReadyClient([guild]));

    expect(mocks.onTavernJoin).toHaveBeenCalledOnce();
    expect(mocks.onTavernJoin).toHaveBeenCalledWith("guild-1", "user-2");
  });

  it("returns the correct seed count when members are present in tavern VCs", async () => {
    const guild = makeGuild(
      "guild-1",
      [
        { channelId: "ch-tavern", id: "user-1" },
        { channelId: "ch-small", id: "user-2" },
      ],
      [{ name: "大酒場🍺" }, { name: "小酒場🍺" }],
      ["ch-tavern", "ch-small"],
    );

    const count = await runStartupTavernSeed(makeReadyClient([guild]));

    expect(count).toBe(2);
    expect(mocks.onTavernJoin).toHaveBeenCalledTimes(2);
  });

  it("logs the seeded count when at least one member is seeded", async () => {
    const guild = makeGuild(
      "guild-1",
      [{ channelId: "ch-tavern", id: "user-1" }],
      [{ name: "大酒場🍺" }],
      ["ch-tavern"],
    );

    await runStartupTavernSeed(makeReadyClient([guild]));

    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("[chest] Seeded 1 tavern member(s)"),
    );
  });
});

describe("startup tavern seed – non-tavern members are NOT seeded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTavernChannelNames.mockResolvedValue(TAVERN_NAMES);
    mocks.onTavernJoin.mockReturnValue(undefined);
  });

  it("does NOT call onTavernJoin for a member in a non-tavern VC", async () => {
    const guild = makeGuild(
      "guild-1",
      [{ channelId: "ch-general", id: "user-1" }],
      [{ name: NON_TAVERN_NAME }],
      ["ch-general"],
    );

    await runStartupTavernSeed(makeReadyClient([guild]));

    expect(mocks.onTavernJoin).not.toHaveBeenCalled();
  });

  it("returns a seed count of 0 when all members are in non-tavern VCs", async () => {
    const guild = makeGuild(
      "guild-1",
      [
        { channelId: "ch-a", id: "user-1" },
        { channelId: "ch-b", id: "user-2" },
      ],
      [{ name: "lobby" }, { name: "music" }],
      ["ch-a", "ch-b"],
    );

    const count = await runStartupTavernSeed(makeReadyClient([guild]));

    expect(count).toBe(0);
    expect(mocks.onTavernJoin).not.toHaveBeenCalled();
  });

  it("does NOT log a seeded count when no tavern members are found", async () => {
    const guild = makeGuild(
      "guild-1",
      [{ channelId: "ch-general", id: "user-1" }],
      [{ name: NON_TAVERN_NAME }],
      ["ch-general"],
    );

    await runStartupTavernSeed(makeReadyClient([guild]));

    expect(mocks.loggerInfo).not.toHaveBeenCalled();
  });
});

describe("startup tavern seed – mixed tavern and non-tavern members", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTavernChannelNames.mockResolvedValue(TAVERN_NAMES);
    mocks.onTavernJoin.mockReturnValue(undefined);
  });

  it("seeds only the tavern member when a tavern and non-tavern member coexist", async () => {
    const guild = makeGuild(
      "guild-1",
      [
        { channelId: "ch-tavern", id: "tavern-user" },
        { channelId: "ch-general", id: "other-user" },
      ],
      [{ name: "大酒場🍺" }, { name: NON_TAVERN_NAME }],
      ["ch-tavern", "ch-general"],
    );

    const count = await runStartupTavernSeed(makeReadyClient([guild]));

    expect(count).toBe(1);
    expect(mocks.onTavernJoin).toHaveBeenCalledOnce();
    expect(mocks.onTavernJoin).toHaveBeenCalledWith("guild-1", "tavern-user");
  });
});

describe("startup tavern seed – edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTavernChannelNames.mockResolvedValue(TAVERN_NAMES);
    mocks.onTavernJoin.mockReturnValue(undefined);
  });

  it("skips a voice state with no channelId (member not in any VC)", async () => {
    const guild = makeGuild(
      "guild-1",
      [{ channelId: null, id: "user-1" }],
      [],
      [],
    );

    const count = await runStartupTavernSeed(makeReadyClient([guild]));

    expect(count).toBe(0);
    expect(mocks.onTavernJoin).not.toHaveBeenCalled();
  });

  it("skips a voice state whose channel is absent from the guild channel cache", async () => {
    // voiceState references a channelId that is not in guild.channels.cache
    const guild: MockGuild = {
      id: "guild-1",
      channels: { cache: new Map() }, // empty — channel not cached
      voiceStates: {
        cache: new Map([["vs-0", { channelId: "ch-missing", id: "user-1" }]]),
      },
    };

    const count = await runStartupTavernSeed(makeReadyClient([guild]));

    expect(count).toBe(0);
    expect(mocks.onTavernJoin).not.toHaveBeenCalled();
  });

  it("seeds tavern members across multiple guilds independently", async () => {
    const guild1 = makeGuild(
      "guild-1",
      [{ channelId: "ch-tavern-1", id: "user-a" }],
      [{ name: "大酒場🍺" }],
      ["ch-tavern-1"],
    );
    const guild2 = makeGuild(
      "guild-2",
      [{ channelId: "ch-tavern-2", id: "user-b" }],
      [{ name: "小酒場🍺" }],
      ["ch-tavern-2"],
    );

    const count = await runStartupTavernSeed(makeReadyClient([guild1, guild2]));

    expect(count).toBe(2);
    expect(mocks.onTavernJoin).toHaveBeenCalledTimes(2);
    expect(mocks.onTavernJoin).toHaveBeenCalledWith("guild-1", "user-a");
    expect(mocks.onTavernJoin).toHaveBeenCalledWith("guild-2", "user-b");
  });

  it("uses an empty set and skips all members when getTavernChannelNames rejects", async () => {
    mocks.getTavernChannelNames.mockRejectedValue(new Error("DB error"));

    const guild = makeGuild(
      "guild-1",
      [{ channelId: "ch-tavern", id: "user-1" }],
      [{ name: "大酒場🍺" }],
      ["ch-tavern"],
    );

    const count = await runStartupTavernSeed(makeReadyClient([guild]));

    // Both the initial call and the fallback call reject → empty set used → no seed.
    expect(count).toBe(0);
    expect(mocks.onTavernJoin).not.toHaveBeenCalled();
  });

  it("does nothing when no guilds are in the cache", async () => {
    const count = await runStartupTavernSeed(makeReadyClient([]));

    expect(count).toBe(0);
    expect(mocks.onTavernJoin).not.toHaveBeenCalled();
    expect(mocks.loggerInfo).not.toHaveBeenCalled();
  });
});
