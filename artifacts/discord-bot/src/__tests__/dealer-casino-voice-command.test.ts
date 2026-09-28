import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType, type ChatInputCommandInteraction } from "discord.js";
import {
  getActiveDealerCasinoGame,
  getDealerCasinoSettings,
  getLatestDealerCasinoGame,
  cancelDealerCasinoGame,
  getDealerCasinoGame,
  getHubChannelById,
  getHubSession,
  createDealerCasinoGame,
  resetDealerCasinoChohanStreak,
  setDealerCasinoSettings,
  setDealerCasinoPanelMessage,
} from "@workspace/db";
import { handleDealerCasinoSlash, handleDealerCasinoVoiceDeparture } from "../commands/dealerCasino";
import { isConfiguredHubVoice } from "../lib/configuredHubVoice";

vi.mock("@workspace/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@workspace/db")>(),
  getActiveDealerCasinoGame: vi.fn(),
  getDealerCasinoSettings: vi.fn(),
  getLatestDealerCasinoGame: vi.fn(),
  cancelDealerCasinoGame: vi.fn(),
  getDealerCasinoGame: vi.fn(),
  getHubChannelById: vi.fn(),
  getHubSession: vi.fn(),
  createDealerCasinoGame: vi.fn(),
  resetDealerCasinoChohanStreak: vi.fn(),
  setDealerCasinoSettings: vi.fn(),
  setDealerCasinoPanelMessage: vi.fn(),
}));

vi.mock("../lib/economy", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/economy")>(),
  getGuildSettings: vi.fn().mockResolvedValue({ currencyName: "コイン" }),
}));

function makeInteraction({
  admin = true, sub = "game_vc", group = "setup",
  channelType = ChannelType.GuildVoice, voiceChannelId = "child-1",
} = {}) {
  const editReply = vi.fn().mockResolvedValue(undefined);
  const member = { id: "admin-1", permissions: { has: vi.fn().mockReturnValue(admin) },
    voice: { channelId: voiceChannelId }, roles: { cache: { has: vi.fn().mockReturnValue(false) } } };
  const send = vi.fn().mockResolvedValue({ id: "panel-1" });
  const interaction = {
    guildId: "guild-1",
    channelId: "text-1",
    channel: { isTextBased: () => true, send },
    guild: { members: { fetch: vi.fn().mockResolvedValue(member) } },
    user: { id: "admin-1" },
    options: {
      getSubcommandGroup: vi.fn().mockReturnValue(group),
      getSubcommand: vi.fn().mockReturnValue(sub),
      getChannel: vi.fn((name: string) => name === "vc" ? { id: "voice-2", type: channelType } : null),
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply,
    deferred: true,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, editReply, send };
}

describe("/casino setup game_vc", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDealerCasinoSettings).mockResolvedValue({
      voiceChannelId: "voice-1", logChannelId: "log-1",
    } as Awaited<ReturnType<typeof getDealerCasinoSettings>>);
    vi.mocked(getActiveDealerCasinoGame).mockResolvedValue(null);
    vi.mocked(getHubSession).mockResolvedValue(null as never);
    vi.mocked(getHubChannelById).mockResolvedValue(null as never);
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

  it("転送先で進行中でも設定元Hubと同じVCへの再設定を認める", async () => {
    vi.mocked(getDealerCasinoSettings).mockResolvedValue({
      voiceChannelId: "hub-1", logChannelId: "log-1",
    } as Awaited<ReturnType<typeof getDealerCasinoSettings>>);
    vi.mocked(getActiveDealerCasinoGame).mockResolvedValue({
      voiceChannelId: "child-1",
    } as Awaited<ReturnType<typeof getActiveDealerCasinoGame>>);
    const { interaction } = makeInteraction();
    const options = interaction.options as unknown as { getChannel: ReturnType<typeof vi.fn> };
    options.getChannel.mockReturnValue({ id: "hub-1", type: ChannelType.GuildVoice });
    await handleDealerCasinoSlash(interaction);
    expect(setDealerCasinoSettings).toHaveBeenCalledWith("guild-1", { voiceChannelId: "hub-1" });
  });
});

describe("設定VC Hubからの転送", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getHubSession).mockResolvedValue({
      guildId: "guild-1", hubId: 7,
    } as Awaited<ReturnType<typeof getHubSession>>);
    vi.mocked(getHubChannelById).mockResolvedValue({
      guildId: "guild-1", hubChannelId: "hub-1",
    } as Awaited<ReturnType<typeof getHubChannelById>>);
    vi.mocked(getDealerCasinoSettings).mockResolvedValue({
      voiceChannelId: "hub-1", minBet: 1000, maxBet: 10000, maxPlayers: 16,
      pokerAceLowEnabled: 1,
    } as Awaited<ReturnType<typeof getDealerCasinoSettings>>);
    vi.mocked(getActiveDealerCasinoGame).mockResolvedValue(null);
    vi.mocked(resetDealerCasinoChohanStreak).mockResolvedValue(undefined as never);
  });

  it("同じサーバーの転送先だけを設定VCとして扱う", async () => {
    expect(await isConfiguredHubVoice("guild-1", "child-1", "hub-1")).toBe(true);
    expect(await isConfiguredHubVoice("guild-2", "child-1", "hub-1")).toBe(false);
    expect(await isConfiguredHubVoice("guild-1", "child-1", "other-hub")).toBe(false);
    expect(await isConfiguredHubVoice("guild-1", "hub-1", "hub-1")).toBe(true);
  });

  it.each(["chohan", "poker"] as const)("%s を転送先VCで開始し、そのVCをゲームに保存する", async (gameType) => {
    vi.mocked(createDealerCasinoGame).mockImplementation(async (input) => ({
      ...input, id: 8, state: "RECRUITING",
    } as Awaited<ReturnType<typeof createDealerCasinoGame>>));
    const { interaction, editReply, send } = makeInteraction({ group: gameType, sub: "start" });
    await handleDealerCasinoSlash(interaction);
    expect(createDealerCasinoGame).toHaveBeenCalledWith(expect.objectContaining({
      gameType, voiceChannelId: "child-1",
    }));
    expect(send).toHaveBeenCalled();
    expect(setDealerCasinoPanelMessage).toHaveBeenCalledWith(8, "panel-1");
    expect(editReply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("募集パネルを投稿"),
    }));
  });

  it("転送先VCで精算後に次の募集を開始できる", async () => {
    vi.mocked(getLatestDealerCasinoGame).mockResolvedValue({
      guildId: "guild-1", dealerId: "admin-1", gameType: "chohan",
      voiceChannelId: "child-1", state: "FINISHED", sessionEnded: 0,
    } as Awaited<ReturnType<typeof getLatestDealerCasinoGame>>);
    vi.mocked(createDealerCasinoGame).mockImplementation(async (input) => ({
      ...input, id: 9, state: "RECRUITING",
    } as Awaited<ReturnType<typeof createDealerCasinoGame>>));
    const { interaction, send } = makeInteraction({ group: "", sub: "next" });
    await handleDealerCasinoSlash(interaction);
    expect(createDealerCasinoGame).toHaveBeenCalledWith(expect.objectContaining({
      gameType: "chohan", voiceChannelId: "child-1",
    }));
    expect(send).toHaveBeenCalled();
  });

  it("別の転送先VCから進行中の卓を操作できない", async () => {
    vi.mocked(getActiveDealerCasinoGame).mockResolvedValue({
      guildId: "guild-1", dealerId: "admin-1", voiceChannelId: "child-1",
    } as Awaited<ReturnType<typeof getActiveDealerCasinoGame>>);
    const { interaction, editReply } = makeInteraction({
      group: "", sub: "close", voiceChannelId: "child-2",
    });
    await handleDealerCasinoSlash(interaction);
    expect(editReply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("このゲームが進行しているVC"),
    }));
  });

  it("転送先が消えた卓も管理者が設定VCから中止できる", async () => {
    vi.mocked(getActiveDealerCasinoGame).mockResolvedValue({
      id: 12, guildId: "guild-1", dealerId: "admin-1", voiceChannelId: "deleted-child",
    } as Awaited<ReturnType<typeof getActiveDealerCasinoGame>>);
    vi.mocked(cancelDealerCasinoGame).mockResolvedValue(undefined as never);
    vi.mocked(getDealerCasinoGame).mockResolvedValue(null);
    const { interaction } = makeInteraction({
      group: "", sub: "cancel", voiceChannelId: "hub-1",
    });
    await handleDealerCasinoSlash(interaction);
    expect(cancelDealerCasinoGame).toHaveBeenCalledWith(12);
  });

  it("別のHubの転送先ではゲームを開始できない", async () => {
    vi.mocked(getHubChannelById).mockResolvedValue({
      guildId: "guild-1", hubChannelId: "other-hub",
    } as Awaited<ReturnType<typeof getHubChannelById>>);
    const { interaction, editReply } = makeInteraction({ group: "chohan", sub: "start" });
    await handleDealerCasinoSlash(interaction);
    expect(createDealerCasinoGame).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("設定された賭博場VCまたはその転送先VC"),
    }));
  });

  it("設定元Hubから転送先へ移動しても連勝を失わず、範囲外へ出ると失う", async () => {
    const oldState = { guild: { id: "guild-1" }, member: { id: "user-1" }, channelId: "hub-1" };
    await handleDealerCasinoVoiceDeparture(oldState as never, { channelId: "child-1" } as never);
    expect(resetDealerCasinoChohanStreak).not.toHaveBeenCalled();
    vi.mocked(getHubSession).mockResolvedValue(null as never);
    await handleDealerCasinoVoiceDeparture(oldState as never, { channelId: "outside-1" } as never);
    expect(resetDealerCasinoChohanStreak).toHaveBeenCalledWith("guild-1", "user-1");
  });
});