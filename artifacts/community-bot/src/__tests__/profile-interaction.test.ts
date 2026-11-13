import { Collection } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(), getData: vi.fn(), setField: vi.fn(),
  setDisplayRole: vi.fn(), setRankRole: vi.fn(), setAppearance: vi.fn(),
  getBackground: vi.fn(), fetchImage: vi.fn(), renderCard: vi.fn(), clearBackground: vi.fn(),
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
vi.mock("../lib/profileCardImage.js", () => ({
  clearProfileBackgroundCache: mocks.clearBackground,
  fetchProfileImage: mocks.fetchImage,
  getCachedProfileBackground: mocks.getBackground,
  renderProfileCard: mocks.renderCard,
}));

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
  bounty: 500000, currencyName: "$",
  inventory: [{ name: "宝箱", quantity: 2 }],
  pet: { name: "キツネ", level: 4, bond: 50 },
  petStock: ["ノーマル卵：0個", "レア卵：1個", "エピック卵：0個", "レジェンド卵：0個", "ミシック卵：0個", "エサ：2個", "おもちゃ：1個"],
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
  mocks.getBackground.mockResolvedValue(Buffer.from("background"));
  mocks.fetchImage.mockResolvedValue(Buffer.from("avatar"));
  mocks.renderCard.mockResolvedValue(Buffer.from("png"));
});

describe("profile slash commands", () => {
  it("exposes both display and administrator configuration commands", () => {
    expect(profileCommand.data.toJSON().name).toBe("プロフィール");
    const definition = profileSettingsCommand.data.toJSON();
    expect(definition.name).toBe("プロフィール設定");
    expect(definition.options?.map(option => option.name)).toEqual([
      "項目", "表示ロール追加", "表示ロール削除", "ランクロール", "ランクロール解除", "色", "画像", "枠",
    ]);
    expect(JSON.stringify(definition.options?.find(option => option.name === "項目"))).not.toContain("銀行残高");
  });

  it("renders configured roles, rank, saved stats, and hides internal weapon attack", async () => {
    const i = interaction();
    await profileCommand.execute(i as never);
    const response = i.editReply.mock.calls[0]![0];
    const embed = response.embeds[0].toJSON();
    expect(embed.title).toContain("VIP");
    expect(embed.fields ?? []).toHaveLength(0);
    expect(embed.description).toContain("画像カード");
    expect(embed.image?.url).toBe("attachment://profile-card.png");
    const card = mocks.renderCard.mock.calls[0]![0];
    const cardSections = card.sections as { title: string; lines: string[] }[];
    const renderedText = JSON.stringify(cardSections);
    expect(renderedText).toContain("軍師");
    expect(renderedText).toContain("大剣 Lv3");
    expect(renderedText).toContain("総BET");
    expect(renderedText).not.toContain("999");
    expect(renderedText).not.toContain("銀行残高");
    const inventory = cardSections.find(section => section.title.includes("所持品"))?.lines.join("\n") ?? "";
    expect(inventory).toContain("レア卵：1個");
    expect(inventory).toContain("エサ：2個");
    expect(inventory).toContain("おもちゃ：1個");
    expect(inventory).not.toContain("宝箱");
    expect(inventory).not.toContain("キツネ");
    expect(response.files).toHaveLength(1);
    expect(card).toMatchObject({
      displayName: "Sakura",
      username: "SakuraUser",
      bountyValue: "500,000$",
      backgroundBuffer: null,
      avatarBuffer: Buffer.from("avatar"),
    });
    expect(cardSections.some(section => section.title.includes("懸賞金"))).toBe(false);
  });

  it("loads and overlays the configured background image", async () => {
    mocks.getSettings.mockResolvedValue({ ...configured, backgroundUrl: "https://images.example/card.jpg" });
    const i = interaction();
    await profileCommand.execute(i as never);
    expect(mocks.getBackground).toHaveBeenCalledWith("https://images.example/card.jpg");
    expect(mocks.renderCard).toHaveBeenCalledWith(expect.objectContaining({
      backgroundBuffer: Buffer.from("background"),
    }));
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
