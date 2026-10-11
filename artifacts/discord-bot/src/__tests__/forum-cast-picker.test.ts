import { Collection, type Guild, type GuildMember } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { buildForumCastPicker, fetchForumCastMembers, getForumCastRoleIds, isEligibleForumCast } from "../lib/forumCastPicker";

function member(id: string, roles = ["cast-role"], bot = false): GuildMember {
  return {
    id, displayName: `キャスト${id}`, user: { username: `user${id}`, bot },
    roles: { cache: new Collection(roles.map((role) => [role, { id: role }])) },
  } as unknown as GuildMember;
}

describe("role-filtered forum cast selector", () => {
  it("uses the new role list while preserving legacy single-role panels", () => {
    expect(getForumCastRoleIds({ castRoleId: "old" })).toEqual(["old"]);
    expect(getForumCastRoleIds({ castRoleId: "old", castRoleIds: [] })).toEqual(["old"]);
    expect(getForumCastRoleIds({ castRoleId: "old", castRoleIds: ["new", "other", "new"] })).toEqual(["new", "other"]);
    expect(getForumCastRoleIds({})).toEqual([]);
  });
  it("accepts any selected role rather than requiring all roles", () => {
    expect(isEligibleForumCast(member("1", ["second"]), ["first", "second"])).toBe(true);
    expect(isEligibleForumCast(member("1", ["first"]), ["first", "second"])).toBe(true);
    expect(isEligibleForumCast(member("1", ["unselected"]), ["first", "second"])).toBe(false);
    expect(isEligibleForumCast(member("1", ["second"], true), ["first", "second"])).toBe(false);
    expect(isEligibleForumCast(member("1", ["second"]), [])).toBe(false);
  });
  it("merges multiple role groups without duplicating members", async () => {
    const first = member("1", ["first"]), second = member("2", ["second"]), both = member("3", ["first", "second"]);
    const neither = member("4", ["other"]);
    const guild = {
      id: "guild", roles: { fetch: vi.fn(async (id: string) => ({ id })) },
      members: { fetch: vi.fn(async () => new Collection([first, second, both, neither].map((row) => [row.id, row]))) },
    } as unknown as Guild;
    const result = await fetchForumCastMembers(guild, ["first", "second", "first"]);
    expect(result.map((row) => row.id)).toEqual(["1", "2", "3"]);
    expect(guild.roles.fetch).toHaveBeenCalledTimes(2);
    expect(guild.members.fetch).toHaveBeenCalledOnce();
  });
  it("only includes human members holding the configured role, never a fallback to everyone", () => {
    expect(isEligibleForumCast(member("1"), "cast-role")).toBe(true);
    expect(isEligibleForumCast(member("2", ["other-role"]), "cast-role")).toBe(false);
    expect(isEligibleForumCast(member("3", ["cast-role"], true), "cast-role")).toBe(false);
    expect(isEligibleForumCast(member("4"), null)).toBe(false);
    expect(isEligibleForumCast(null, "cast-role")).toBe(false);
  });
  it("uses a complete member fetch rather than a partial role-members cache", async () => {
    const one = member("1"), two = member("2"), other = member("3", []), bot = member("4", ["cast-role"], true);
    const guild = {
      id: "guild", roles: { fetch: vi.fn(async () => ({ id: "cast-role", members: new Collection() })) },
      members: { fetch: vi.fn(async () => new Collection([one, two, other, bot].map((row) => [row.id, row]))) },
    } as unknown as Guild;
    expect((await fetchForumCastMembers(guild, "cast-role")).map((row) => row.id)).toEqual(["1", "2"]);
    expect(guild.members.fetch).toHaveBeenCalledWith({ withPresences: false });
  });
  it("rejects missing roles and fetch failures instead of showing unrestricted members", async () => {
    const guild = {
      id: "guild", roles: { fetch: vi.fn().mockResolvedValue(null) }, members: { fetch: vi.fn() },
    } as unknown as Guild;
    await expect(fetchForumCastMembers(guild, "removed")).rejects.toThrow("ロールが無効");
    expect(guild.members.fetch).not.toHaveBeenCalled();
    vi.mocked(guild.roles.fetch).mockResolvedValue({ id: "cast-role" } as never);
    vi.mocked(guild.members.fetch).mockRejectedValue(new Error("Member fetch failed"));
    await expect(fetchForumCastMembers(guild, "cast-role")).rejects.toThrow("Member fetch failed");
  });
  it("paginates all candidates in groups of 25 with correct navigation boundaries", () => {
    const members = Array.from({ length: 51 }, (_, i) => member(String(i)));
    const pages = [0, 1, 2].map((page) => buildForumCastPicker(10, 3, members, page));
    const ids = pages.flatMap((page) => {
      const menu = page.components[0].components[0].toJSON();
      return "options" in menu ? menu.options.map((option) => option.value) : [];
    });
    expect(ids).toEqual(members.map((row) => row.id));
    expect(pages[0].components[1].components[0].data).toMatchObject({ disabled: true });
    expect(pages[1].components[1].components[0].data).toMatchObject({ disabled: false });
    expect(pages[2].components[1].components[1].data).toMatchObject({ disabled: true });
    expect(pages[0].content).toContain("51人");
    expect(buildForumCastPicker(10, 3, members, 999).content).toContain("3/3ページ");
  });
  it("shows no selector when the role has no human members and respects Discord label limits", () => {
    expect(() => buildForumCastPicker(10, 3, [])).toThrow("キャストがいません");
    const row = member("1");
    Object.assign(row, { displayName: "長".repeat(150) });
    const page = buildForumCastPicker(10, 3, [row]);
    const menu = page.components[0].components[0].toJSON();
    expect("options" in menu && menu.options[0].label.length).toBe(100);
    expect(page.components).toHaveLength(1);
  });
});
