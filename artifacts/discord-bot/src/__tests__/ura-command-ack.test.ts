import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComponentType, MessageFlags, type ButtonInteraction, type ChatInputCommandInteraction, type Client } from "discord.js";

vi.mock("@workspace/db", () => ({
  URA_TALK: "talk",
  URA_SLEEP: "sleep",
  getUraRecruitmentSettings: vi.fn(),
  getActiveUraMatchForUser: vi.fn(),
  listUraMatchesForGuildBefore: vi.fn(),
  removeUraMatch: vi.fn(),
  getUraRecruitmentById: vi.fn(),
  getOpenUraRecruitmentByOwner: vi.fn(),
  cancelUraRecruitment: vi.fn(),
  listUraApplications: vi.fn(),
  listOpenUraRecruitments: vi.fn(),
  listUraMatchesReadyForDeletion: vi.fn(),
}));

import {
  cancelUraRecruitment, getActiveUraMatchForUser, getOpenUraRecruitmentByOwner, getUraRecruitmentById,
  getUraRecruitmentSettings, listOpenUraRecruitments, listUraApplications,
  listUraMatchesForGuildBefore, listUraMatchesReadyForDeletion, removeUraMatch,
} from "@workspace/db";
import { handleUraInteraction, runUraRecruitmentCleanup, uraRecruitmentCommand } from "../commands/uraRecruitment";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listUraMatchesForGuildBefore).mockResolvedValue([]);
});

describe("/裏航海", () => {
  it("データベースの応答を待つ前に非公開の応答を確定する", async () => {
    let resolveSettings!: (value: { panelChannelId: null; recruitmentChannelId: null }) => void;
    vi.mocked(getUraRecruitmentSettings).mockReturnValueOnce(
      new Promise((resolve) => { resolveSettings = resolve as typeof resolveSettings; }) as ReturnType<typeof getUraRecruitmentSettings>,
    );
    const deferReply = vi.fn(async () => undefined);
    const editReply = vi.fn(async (_options: unknown) => undefined);
    const interaction = {
      guild: { id: "test-guild" },
      memberPermissions: { has: () => true },
      options: { getSubcommand: () => "panel" },
      deferReply,
      editReply,
    } as unknown as ChatInputCommandInteraction;

    const execution = uraRecruitmentCommand.execute(interaction);
    await vi.waitFor(() => expect(getUraRecruitmentSettings).toHaveBeenCalled());
    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(editReply).not.toHaveBeenCalled();
    resolveSettings({ panelChannelId: null, recruitmentChannelId: null });
    await execution;
    expect(editReply).toHaveBeenCalledWith("先に `/裏航海 setup` を実行してください。");
  });
});

describe("裏航海パネルのVC削除ボタン", () => {
  it("本人の進行中マッチだけを非公開で確認する", async () => {
    vi.mocked(getActiveUraMatchForUser).mockResolvedValueOnce({
      id: 42, guildId: "test-guild", hostId: "test-user", guestId: "test-guest", channelId: "test-vc", status: "active",
    } as NonNullable<Awaited<ReturnType<typeof getActiveUraMatchForUser>>>);
    const editReply = vi.fn(async (_options: unknown) => undefined);
    const deferReply = vi.fn(async () => undefined);
    const interaction = {
      customId: "ura:panel:delete",
      isButton: () => true,
      guild: { id: "test-guild" },
      user: { id: "test-user" },
      deferReply, editReply,
    } as unknown as ButtonInteraction;
    await handleUraInteraction(interaction, {} as Client);
    expect(getActiveUraMatchForUser).toHaveBeenCalledWith("test-guild", "test-user");
    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    const confirmation = editReply.mock.calls[0]?.[0] as unknown as { components: [{ components: [{ data: { custom_id: string } }] }] };
    expect(confirmation.components[0].components[0].data.custom_id).toBe("ura:match:delete:42");
  });
});

describe("管理者のマッチ一括削除", () => {
  it("削除前に件数と進行中VCを表示して確認を求める", async () => {
    vi.mocked(listUraMatchesForGuildBefore).mockResolvedValueOnce([
      { id: 1, status: "finished" },
      { id: 2, status: "finished" },
      { id: 3, status: "active" },
    ] as Awaited<ReturnType<typeof listUraMatchesForGuildBefore>>);
    const editReply = vi.fn(async (_options: unknown) => undefined);
    const interaction = {
      guild: { id: "test-guild" },
      memberPermissions: { has: () => true },
      options: { getSubcommand: () => "purge-matches" },
      deferReply: vi.fn(async () => undefined),
      editReply,
    } as unknown as ChatInputCommandInteraction;
    await uraRecruitmentCommand.execute(interaction);
    const preview = editReply.mock.calls[0]?.[0] as { content: string; components: [{ components: [{ data: { custom_id: string } }] }] };
    expect(preview.content).toContain("マッチ3件（進行中1件、終了済み2件）");
    expect(preview.components[0].components[0].data.custom_id).toMatch(/^ura:matches:purge:\d+$/);
    expect(removeUraMatch).not.toHaveBeenCalled();
  });
});

describe("募集者専用の募集終了", () => {
  const recruitment = { id: 7, guildId: "test-guild", ownerId: "test-owner", messageId: null };
  const guild = { id: "test-guild" };
  const client = { guilds: { cache: { get: () => guild } } } as unknown as Client;

  it("DM内のボタンでも募集者本人だけが終了できる", async () => {
    vi.mocked(getUraRecruitmentById).mockResolvedValue(recruitment as Awaited<ReturnType<typeof getUraRecruitmentById>>);
    vi.mocked(cancelUraRecruitment).mockResolvedValueOnce(recruitment as Awaited<ReturnType<typeof cancelUraRecruitment>>);
    vi.mocked(listUraApplications).mockResolvedValueOnce([]);
    const editReply = vi.fn(async (_options: unknown) => undefined);
    const followUp = vi.fn(async (_options: unknown) => undefined);
    const deferUpdate = vi.fn(async () => undefined);
    const button = (userId: string) => ({
      customId: "ura:recruitment:cancel:7",
      isButton: () => true,
      guild: null,
      user: { id: userId },
      deferUpdate, editReply, followUp,
    } as unknown as ButtonInteraction);

    await handleUraInteraction(button("test-stranger"), client);
    expect(cancelUraRecruitment).not.toHaveBeenCalled();
    expect(followUp).toHaveBeenCalledWith(expect.objectContaining({ content: "募集者だけが終了できます。" }));
    await handleUraInteraction(button("test-owner"), client);
    expect(cancelUraRecruitment).toHaveBeenCalledWith(7, "test-owner");
    expect(editReply).toHaveBeenCalledWith(expect.objectContaining({ content: "募集を終了しました。" }));
  });

  it("DMが使えない場合も本人限定コマンドで終了できる", async () => {
    vi.mocked(getOpenUraRecruitmentByOwner).mockResolvedValueOnce(recruitment as Awaited<ReturnType<typeof getOpenUraRecruitmentByOwner>>);
    vi.mocked(cancelUraRecruitment).mockResolvedValueOnce(recruitment as Awaited<ReturnType<typeof cancelUraRecruitment>>);
    vi.mocked(getUraRecruitmentById).mockResolvedValueOnce(recruitment as Awaited<ReturnType<typeof getUraRecruitmentById>>);
    vi.mocked(listUraApplications).mockResolvedValueOnce([]);
    const editReply = vi.fn(async (_options: unknown) => undefined);
    const interaction = {
      guild,
      user: { id: "test-owner" },
      options: { getSubcommand: () => "close" },
      deferReply: vi.fn(async () => undefined),
      editReply,
    } as unknown as ChatInputCommandInteraction;

    await uraRecruitmentCommand.execute(interaction);
    expect(getOpenUraRecruitmentByOwner).toHaveBeenCalledWith("test-guild", "test-owner");
    expect(cancelUraRecruitment).toHaveBeenCalledWith(7, "test-owner");
    expect(editReply).toHaveBeenCalledWith("募集を終了しました。");
  });
});

describe("既存の募集中カードの非公開終了ボタン", () => {
  it("既存募集の所有者へDMし、すでに同じボタンがある場合は再送しない", async () => {
    const recruitment = {
      id: 105, guildId: "existing-guild", ownerId: "existing-owner", status: "open",
      messageId: null, createdAt: new Date(Date.now() - 60_000),
    };
    vi.mocked(listOpenUraRecruitments).mockResolvedValue([recruitment] as Awaited<ReturnType<typeof listOpenUraRecruitments>>);
    vi.mocked(listUraMatchesReadyForDeletion).mockResolvedValue([]);
    vi.mocked(getUraRecruitmentSettings).mockResolvedValue({ panelChannelId: null } as Awaited<ReturnType<typeof getUraRecruitmentSettings>>);
    vi.mocked(getUraRecruitmentById).mockResolvedValue(recruitment as Awaited<ReturnType<typeof getUraRecruitmentById>>);
    const send = vi.fn(async (_options: unknown) => undefined);
    const fetch = vi.fn()
      .mockResolvedValueOnce({ size: 0, some: () => false })
      .mockResolvedValueOnce({
        size: 1,
        some: (predicate: (message: unknown) => boolean) => predicate({
          author: { id: "test-bot" },
          components: [{ type: ComponentType.ActionRow, components: [{ customId: "ura:recruitment:cancel:105" }] }],
        }),
      });
    const dm = { messages: { fetch }, send };
    const owner = { createDM: vi.fn(async () => dm) };
    const guild = {
      id: "existing-guild",
      client: { user: { id: "test-bot" }, users: { fetch: vi.fn(async () => owner) } },
    };
    const client = { guilds: { cache: { values: () => [guild] } } } as unknown as Client;

    await runUraRecruitmentCleanup(client);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      components: [expect.objectContaining({ components: [expect.objectContaining({ data: expect.objectContaining({ custom_id: "ura:recruitment:cancel:105" }) })] })],
    }));

    // Simulate a fresh startup with another guild ID: a matching bot DM must not be resent.
    guild.id = "another-guild";
    await runUraRecruitmentCleanup(client);
    expect(send).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});