import { describe, expect, it, vi } from "vitest";
import { MessageFlags, type ButtonInteraction, type ChatInputCommandInteraction, type Client } from "discord.js";

vi.mock("@workspace/db", () => ({
  URA_TALK: "talk",
  URA_SLEEP: "sleep",
  getUraRecruitmentSettings: vi.fn(),
  getActiveUraMatchForUser: vi.fn(),
  listUraMatchesForGuildBefore: vi.fn(),
  removeUraMatch: vi.fn(),
}));

import { getActiveUraMatchForUser, getUraRecruitmentSettings, listUraMatchesForGuildBefore, removeUraMatch } from "@workspace/db";
import { handleUraInteraction, uraRecruitmentCommand } from "../commands/uraRecruitment";

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