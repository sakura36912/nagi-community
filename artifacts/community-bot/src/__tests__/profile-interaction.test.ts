import { Collection } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(), getData: vi.fn(), setField: vi.fn(),
  setDisplayRole: vi.fn(), setRankRole: vi.fn(), setAppearance: vi.fn(),
}));
vi.mock("@workspace/db", async importOriginal => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  return {
    ...actual,
    getProfileSettings: mocks.getSettings,
    getProfileData: mocks.getData,
    setProfileField: mocks.setField,
    setProfileDisplayRole: mocks.setDisplayRole,
    setProfileRankRole: mocks.setRankRole,
    setProfileAppearance: mocks.setAppearance,
  };
});

import { DEFAULT_PROFILE_SETTINGS, type ProfileSettings } from "@workspace/db";
import { profileCommand, profileSettingsCommand } from "../commands/profile";

const userId = "123456789012345678";
const configured: ProfileSettings = {
  ...DEFAULT_PROFILE_SETTINGS,
  displayRoleIds: ["role-staff"],
  rankRoles: [{ roleId: "role-vip", tier: "vip" }],
};
const data = {
  weapon: { weaponType: "greatsword", weaponLevel: 3, attack: 999 },
  bounty: 500000, balance: 123456, currencyName: "$",
  inventory: [{ name: "宝箱", quantity: 2 }],
  pet: { name: "キツネ", level: 4, bond: 50 }, petInventory: ["キツネ（Lv4）"],
  battle: { defeats: 2, maxDamage: 9500, participated: 3 },
  pvp: { wins: 4, losses: 2, draws: 1 },
  casino: { totalBet: 5000, net: -300, wins: 5, maxPayout: 9000, games: 12 },
};
function interaction({ admin = false, subcommand = "", options = {} }: {
  admin?: boolean; subcommand?: string; options?: Record<string, unknown>;
} = {}) {
  const member = {
    displayName: "Sakura",
    joinedAt: new Date("2024-01-01T00:00:00Z"),
    roles: { cache: new Collection([["role-staff", { id: "role-staff", name: "軍師" }], ["role-vip", { id: "role-vip", name: "VIP" }]]) },
    permissions: { has: () => admin },
  };
  return {
    id: "interaction-id", user: { id: userId, username: "SakuraUser", displayAvatarURL: () => "https://cdn.example/avatar.png" },
    guild: { id: "guild", name: "Nagi", members: { fetch: vi.fn().mockResolvedValue(member) },
      roles: { cache: new Collection([["role-staff", { id: "role-staff", name: "軍師" }], ["role-vip", { id: "role-vip", name: "VIP" }]]) } },
    options: {
      getSubcommand: () => subcommand,
      getString: (key: string) => options[key] ?? null,
      getBoolean: (key: string) => options[key] ?? null,
      getRole: (key: string) => options[key] ?? null,
    },
    deferReply: vi.fn(), editReply: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue(configured);
  mocks.getData.mockResolvedValue(data);
  for (const fn of [mocks.setField, mocks.setDisplayRole, mocks.setRankRole, mocks.setAppearance]) fn.mockResolvedValue(configured);
});

describe("profile slash commands", () => {
  it("exposes both display and administrator configuration commands", () => {
    expect(profileCommand.data.toJSON().name).toBe("プロフィール");
    const definition = profileSettingsCommand.data.toJSON();
    expect(definition.name).toBe("プロフィール設定");
    expect(definition.options?.map(option => option.name)).toEqual([
      "項目", "表示ロール追加", "表示ロール削除", "ランクロール", "ランクロール解除", "色", "画像", "枠",
    ]);
  });

  it("renders configured roles, rank, saved stats, and hides internal weapon attack", async () => {
    const i = interaction();
    await profileCommand.execute(i as never);
    const embed = i.editReply.mock.calls[0]![0].embeds[0].toJSON();
    const fields = embed.fields as { name: string; value: string }[] | undefined;
    expect(embed.title).toContain("VIP");
    expect(fields?.map(field => field.name)).toContain("🎭 ロール");
    expect(fields?.find(field => field.name === "🎭 ロール")?.value).toContain("軍師");
    expect(fields?.find(field => field.name === "⚔️ 戦闘情報")?.value).toContain("大剣 Lv3");
    expect(fields?.find(field => field.name === "⚔️ 戦闘情報")?.value).not.toContain("999");
    expect(fields?.find(field => field.name === "🎰 カジノ（保存済み記録）")?.value).toContain("総BET");
  });

  it("requires administrator permission before changing display settings", async () => {
    const i = interaction({ subcommand: "項目", options: { "項目": "casino", "表示": false } });
    await profileSettingsCommand.execute(i as never);
    expect(mocks.setField).not.toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalledWith({ content: "管理者のみ設定できます。" });
  });

  it("saves a requested field toggle for administrators", async () => {
    const i = interaction({ admin: true, subcommand: "項目", options: { "項目": "casino", "表示": false } });
    await profileSettingsCommand.execute(i as never);
    expect(mocks.setField).toHaveBeenCalledWith("guild", "casino", false);
  });
});
