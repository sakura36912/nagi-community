import { ChannelType, Collection, type Guild } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findConfiguredRoleSelfIntro } from "../lib/sheetIntroSources";
import { findSelfIntro, buildSheetEmbed } from "../lib/sheet";

vi.mock("../lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/economy", () => ({
  getEvalSheetSettings: vi.fn(), getLatestEvalSheet: vi.fn(), getSheetVcSeconds: vi.fn(),
}));
const firstId = "1535330543636320407", secondId = "1535330581020414093";
const message = (id: string, userId: string, content: string, createdTimestamp = 1) => ({
  id, author: { id: userId }, content, createdTimestamp, url: `https://discord.com/channels/guild/source/${id}`,
});
function fixture(roles = ["追放者"]) {
  const source = (id: string) => ({
    id, guildId: "guild", type: ChannelType.GuildText,
    messages: { fetch: vi.fn().mockResolvedValue(new Collection()) },
  });
  const first = source(firstId), second = source(secondId);
  const guild = {
    id: "guild",
    members: { fetch: vi.fn().mockResolvedValue({ roles: { cache: new Collection(
      roles.map(name => [name, { name }]),
    ) } }) },
    channels: { cache: new Collection(), fetch: vi.fn(async (id?: string) =>
      id === firstId ? first : id === secondId ? second : null) },
  };
  const search = () => findConfiguredRoleSelfIntro(guild as unknown as Guild, "target");
  return { first, second, guild, search };
}
beforeEach(() => {
  vi.stubEnv("EVAL_SHEET_INTRO_CHANNELS_BY_ROLE", JSON.stringify({ guild: { "追放者": [firstId, secondId] } }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("role-specific evaluation sheet introductions", () => {
  it("selects the target's latest introduction across both configured channels, not someone else's post", async () => {
    const f = fixture();
    f.first.messages.fetch.mockResolvedValue(new Collection([
      ["other", message("other", "someone-else", "他の人の投稿", 9)],
      ["old", message("old", "target", "以前の自己紹介", 1)],
    ]));
    f.second.messages.fetch.mockResolvedValue(new Collection([
      ["new", message("new", "target", "最新の自己紹介", 2)],
    ]));
    await expect(f.search()).resolves.toEqual({
      configured: true, intro: { content: "最新の自己紹介", url: message("new", "target", "").url },
    });
    expect(f.guild.members.fetch).toHaveBeenCalledWith({ user: "target", force: true });
    expect(f.guild.channels.fetch.mock.calls.map(call => call[0])).toEqual([firstId, secondId]);
  });
  it("reads older pages and skips empty posts", async () => {
    const f = fixture();
    f.first.messages.fetch.mockResolvedValueOnce(new Collection([
      ["blank", message("blank", "target", "  ")],
    ])).mockResolvedValueOnce(new Collection([["older", message("older", "target", "紹介です")]]));
    await expect(f.search()).resolves.toMatchObject({ configured: true, intro: { content: "紹介です" } });
    expect(f.first.messages.fetch).toHaveBeenNthCalledWith(2, { limit: 100, before: "blank" });
  });
  it("uses the configured sources even when no category is set and includes text plus link in the sheet", async () => {
    const f = fixture();
    f.first.messages.fetch.mockResolvedValue(new Collection([["intro", message("intro", "target", "自己紹介本文")]]));
    const intro = await findSelfIntro(f.guild as unknown as Guild, "target", null);
    expect(intro?.content).toBe("自己紹介本文");
    const embed = buildSheetEmbed({
      targetUser: { id: "target", displayAvatarURL: () => "https://example.com/avatar.png" } as never,
      displayName: "メンバー", startDate: new Date(), endDate: new Date(), vcSeconds: 0,
      selfIntro: intro?.content, rosterPostUrl: intro?.url, createdByLabel: "ロール付与により自動生成",
    }).toJSON();
    expect(embed.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "📝 自己紹介", value: "自己紹介本文" }),
      expect.objectContaining({ name: "📋 船員名簿", value: expect.stringContaining("/intro") }),
    ]));
  });
  it("never falls back to unrelated category chat when the specified sources contain no introduction", async () => {
    const f = fixture();
    await expect(findSelfIntro(f.guild as unknown as Guild, "target", "unrelated-category")).resolves.toBeNull();
    expect(f.guild.channels.fetch.mock.calls.map(call => call[0])).toEqual([firstId, secondId]);
  });
  it("continues to the second source if the first source is inaccessible", async () => {
    const f = fixture(); f.first.messages.fetch.mockRejectedValue(new Error("Missing Access"));
    f.second.messages.fetch.mockResolvedValue(new Collection([["intro", message("intro", "target", "紹介です")]]));
    await expect(f.search()).resolves.toMatchObject({ configured: true, intro: { content: "紹介です" } });
  });
  it("does not copy messages from a different guild", async () => {
    const f = fixture(); f.first.guildId = "another-guild";
    await expect(f.search()).resolves.toEqual({ configured: true, intro: null });
    expect(f.first.messages.fetch).not.toHaveBeenCalled();
  });
  it.each([{ roles: ["本船員"] }, { roles: ["追放者見習い"] }, { roles: [] }])("keeps existing category behavior for other roles: %j", async ({ roles }) => {
    const f = fixture(roles);
    await expect(f.search()).resolves.toEqual({ configured: false });
    expect(f.guild.channels.fetch).not.toHaveBeenCalled();
  });
  it("ignores configuration belonging to another server", async () => {
    const f = fixture(); f.guild.id = "another-guild";
    await expect(f.search()).resolves.toEqual({ configured: false });
    expect(f.guild.members.fetch).not.toHaveBeenCalled();
  });
  it("keeps existing behavior when no role-specific sources are configured", async () => {
    vi.stubEnv("EVAL_SHEET_INTRO_CHANNELS_BY_ROLE", "");
    await expect(fixture().search()).resolves.toEqual({ configured: false });
  });
  it("fails closed if fresh membership cannot be verified", async () => {
    const f = fixture(); f.guild.members.fetch.mockRejectedValue(new Error("Missing Member"));
    await expect(f.search()).rejects.toThrow("検索対象ロールを確認できません");
    expect(f.guild.channels.fetch).not.toHaveBeenCalled();
  });
  it("reports malformed configuration instead of searching arbitrary channels", async () => {
    vi.stubEnv("EVAL_SHEET_INTRO_CHANNELS_BY_ROLE", JSON.stringify({ guild: { "追放者": ["not-a-channel"] } }));
    const f = fixture();
    await expect(f.search()).rejects.toThrow("検索先設定が不正");
    expect(f.guild.channels.fetch).not.toHaveBeenCalled();
  });
  it("bounds history search to five pages per source", async () => {
    const f = fixture();
    f.first.messages.fetch.mockResolvedValue(new Collection([["other", message("other", "other", "別の人")]]));
    await expect(f.search()).resolves.toEqual({ configured: true, intro: null });
    expect(f.first.messages.fetch).toHaveBeenCalledTimes(5);
  });
});
