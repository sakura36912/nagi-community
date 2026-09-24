import { describe, expect, it, vi } from "vitest";
import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";

vi.mock("@workspace/db", () => ({
  URA_TALK: "talk",
  URA_SLEEP: "sleep",
  getUraRecruitmentSettings: vi.fn(),
}));

import { getUraRecruitmentSettings } from "@workspace/db";
import { uraRecruitmentCommand } from "../commands/uraRecruitment";

describe("/裏航海", () => {
  it("データベースの応答を待つ前に非公開の応答を確定する", async () => {
    let resolveSettings!: (value: { panelChannelId: null; recruitmentChannelId: null }) => void;
    vi.mocked(getUraRecruitmentSettings).mockReturnValueOnce(
      new Promise((resolve) => { resolveSettings = resolve as typeof resolveSettings; }) as ReturnType<typeof getUraRecruitmentSettings>,
    );
    const deferReply = vi.fn(async () => undefined);
    const editReply = vi.fn(async () => undefined);
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