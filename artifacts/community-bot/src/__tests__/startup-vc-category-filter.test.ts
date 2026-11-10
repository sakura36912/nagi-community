import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType, type Guild } from "discord.js";
const mocks = vi.hoisted(() => ({
  openVcSessionIfTracked: vi.fn().mockResolvedValue(undefined),
  closeSessionAndGetDuration: vi.fn().mockResolvedValue(null),
}));
vi.mock("../lib/community.js", () => mocks);
vi.mock("../lib/logger.js", () => ({ logger: { error: vi.fn() } }));
import { restoreVcHistorySessions, handleVoiceStateUpdate } from "../lib/vc-session-handler.js";

const member = { roles: { cache: { some: () => false } } };
function guild(channels: { id: string; type: ChannelType; parentId: string | null }[], id = "guild") {
  return {
    id,
    channels: { cache: new Map(channels.map(ch => [ch.id, {
      ...ch, members: new Map([["user", member]]),
    }])) },
  } as unknown as Guild;
}

describe("production all-VC startup and event handlers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("restores ordinary, private/shop, Hub, root and stage VCs, not text channels", async () => {
    await restoreVcHistorySessions([guild([
      { id: "ordinary", type: ChannelType.GuildVoice, parentId: "cat-A" },
      { id: "shop-private", type: ChannelType.GuildVoice, parentId: "cat-B" },
      { id: "hub-child", type: ChannelType.GuildVoice, parentId: "cat-C" },
      { id: "root", type: ChannelType.GuildVoice, parentId: null },
      { id: "stage", type: ChannelType.GuildStageVoice, parentId: null },
      { id: "text", type: ChannelType.GuildText, parentId: null },
    ])]);
    expect(mocks.openVcSessionIfTracked.mock.calls.map(call => call[2]))
      .toEqual(["ordinary", "shop-private", "hub-child", "root", "stage"]);
  });

  it("keeps guild scopes separate", async () => {
    const channel = { id: "vc", type: ChannelType.GuildVoice, parentId: null };
    await restoreVcHistorySessions([guild([channel], "A"), guild([channel], "B")]);
    expect(mocks.openVcSessionIfTracked.mock.calls.map(call => call[0])).toEqual(["A", "B"]);
  });

  it("records a new entry without a source session", async () => {
    await handleVoiceStateUpdate({ guildId: "guild", userId: "user", oldChannelId: null,
      newChannelId: "private", channelParentId: "outside", member });
    expect(mocks.openVcSessionIfTracked).toHaveBeenCalledWith("guild", "user", "private", "outside", false);
    expect(mocks.closeSessionAndGetDuration).not.toHaveBeenCalled();
  });

  it("closes a source before recording the destination on a move", async () => {
    await handleVoiceStateUpdate({ guildId: "guild", userId: "user", oldChannelId: "A",
      newChannelId: "B", channelParentId: null, member });
    expect(mocks.closeSessionAndGetDuration).toHaveBeenCalledWith("guild", "user");
    expect(mocks.openVcSessionIfTracked).toHaveBeenCalledWith("guild", "user", "B", null, false);
    expect(mocks.closeSessionAndGetDuration.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.openVcSessionIfTracked.mock.invocationCallOrder[0]);
  });

  it("closes on disconnect without opening a new session", async () => {
    await handleVoiceStateUpdate({ guildId: "guild", userId: "user", oldChannelId: "A",
      newChannelId: null, channelParentId: null, member });
    expect(mocks.closeSessionAndGetDuration).toHaveBeenCalledWith("guild", "user");
    expect(mocks.openVcSessionIfTracked).not.toHaveBeenCalled();
  });

  it("does not split history on mute or stream toggles", async () => {
    await handleVoiceStateUpdate({ guildId: "guild", userId: "user", oldChannelId: "A",
      newChannelId: "A", channelParentId: null, member });
    expect(mocks.closeSessionAndGetDuration).not.toHaveBeenCalled();
    expect(mocks.openVcSessionIfTracked).not.toHaveBeenCalled();
  });
});
