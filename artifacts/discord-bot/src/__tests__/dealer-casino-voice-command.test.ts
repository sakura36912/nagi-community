import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType, type ChatInputCommandInteraction } from "discord.js";
import {
  getActiveDealerCasinoGame,
  getDealerCasinoSettings,
  setDealerCasinoSettings,
} from "@workspace/db";
import { handleDealerCasinoSlash } from "../commands/dealerCasino";

vi.mock("@workspace/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@workspace/db")>(),
  getActiveDealerCasinoGame: vi.fn(),
  getDealerCasinoSettings: vi.fn(),
  setDealerCasinoSettings: vi.fn(),
}));

function makeInteraction({ admin = true, sub = "game_vc", channelType = ChannelType.GuildVoice } = {}) {
  const editReply = vi.fn().mockResolvedValue(undefined);
  const member = { permissions: { has: vi.fn().mockReturnValue(admin) } };
  const interaction = {
    guildId: "guild-1",
    guild: { members: { fetch: vi.fn().mockResolvedValue(member) } },
    user: { id: "admin-1" },
    options: {
      getSubcommandGroup: vi.fn().mockReturnValue("setup"),
      getSubcommand: vi.fn().mockReturnValue(sub),
      getChannel: vi.fn((name: string) => name === "vc" ? { id: "voice-2", type: channelType } : null),
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply,
    deferred: true,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, editReply };
}

describe("/casino setup game_vc", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDealerCasinoSettings).mockResolvedValue({
      voiceChannelId: "voice-1", logChannelId: "log-1",
    } as Awaited<ReturnType<typeof getDealerCasinoSettings>>);
    vi.mocked(getActiveDealerCasinoGame).mockResolvedValue(null);
    vi.mocked(setDealerCasinoSettings).mockResolvedValue({} as Awaited<ReturnType<typeof setDealerCasinoSettings>>);
  });

  it("管理者が両ゲーム共通のVCだけを変更し、ログ先は維持する", async () => {
    const { interaction, editReply } = makeInteraction();
    await handleDealerCasinoSlash(interaction);
    expect(setDealerCasinoSettings).toHaveBeenCalledWith("guild-1", { voiceChannelId: "voice-2" });
    expect(editReply).toHaveBeenCalledWith({
      content: "丁半・スリーカードポーカー共通の開催VCを <#voice-2> に設定しました。",
    });
  });

  it("進行中のゲームを別VCへ移動しない", async () => {
    vi.mocked(getActiveDealerCasinoGame).mockResolvedValue({
      voiceChannelId: "voice-1",
    } as Awaited<ReturnType<typeof getActiveDealerCasinoGame>>);
    const { interaction, editReply } = makeInteraction();
    await handleDealerCasinoSlash(interaction);
    expect(setDealerCasinoSettings).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("精算またはキャンセル後にVCを変更"),
    }));
  });

  it("管理者以外は変更できない", async () => {
    const { interaction, editReply } = makeInteraction({ admin: false });
    await handleDealerCasinoSlash(interaction);
    expect(setDealerCasinoSettings).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("サーバー管理者のみ"),
    }));
  });

  it("旧 dealer_room コマンドも進行中のVC変更を拒否する", async () => {
    vi.mocked(getActiveDealerCasinoGame).mockResolvedValue({
      voiceChannelId: "voice-1",
    } as Awaited<ReturnType<typeof getActiveDealerCasinoGame>>);
    const { interaction } = makeInteraction({ sub: "dealer_room" });
    await handleDealerCasinoSlash(interaction);
    expect(setDealerCasinoSettings).not.toHaveBeenCalled();
  });
});