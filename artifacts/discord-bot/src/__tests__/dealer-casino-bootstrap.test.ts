import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType, type Client } from "discord.js";
import { db, getDealerCasinoSettings } from "@workspace/db";
import { initializeDealerCasinoForGuild } from "../lib/dealerCasinoBootstrap";

vi.mock("@workspace/db", () => ({
  db: { insert: vi.fn() },
  dealerCasinoSettingsTable: { guildId: "guild_id" },
  getDealerCasinoSettings: vi.fn(),
}));
vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const guildId = "1526418867335725247";
const channelId = "1528954400263897088";
const dealerId = "1528278375829864459";
const directorId = "1540665709686689863";
const adminId = "1526565082769653760";

function clientWithRoles() {
  const roles = new Map([
    [dealerId, { name: "賭博師" }],
    [directorId, { name: "賭博頭領" }],
    [adminId, { name: "管理者" }],
  ]);
  const guild = {
    channels: { fetch: vi.fn().mockResolvedValue({ type: ChannelType.GuildVoice, name: "賭博VC" }) },
    roles: { fetch: vi.fn((id: string) => Promise.resolve(roles.get(id))) },
  };
  const client = { guilds: { cache: new Map([[guildId, guild]]) } } as unknown as Client;
  return { client, guild, roles };
}

describe("賭博場の初回設定", () => {
  beforeEach(() => vi.clearAllMocks());

  it("既存の設定を上書きしない", async () => {
    vi.mocked(getDealerCasinoSettings).mockResolvedValue({ guildId } as Awaited<ReturnType<typeof getDealerCasinoSettings>>);
    const { client, guild } = clientWithRoles();
    await initializeDealerCasinoForGuild(client);
    expect(guild.roles.fetch).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("管理者ロール・賭博VC・指定ルールを、設定がないサーバーに限り登録する", async () => {
    vi.mocked(getDealerCasinoSettings).mockResolvedValue(null);
    const returning = vi.fn().mockResolvedValue([{ guildId }]);
    const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
    const values = vi.fn().mockReturnValue({ onConflictDoNothing });
    vi.mocked(db.insert).mockReturnValue({ values } as unknown as ReturnType<typeof db.insert>);

    const { client, guild } = clientWithRoles();
    await initializeDealerCasinoForGuild(client);

    expect(guild.channels.fetch).toHaveBeenCalledWith(channelId);
    expect(guild.roles.fetch).toHaveBeenCalledTimes(3);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      guildId, voiceChannelId: channelId,
      dealerRoleId: dealerId, directorRoleId: directorId, adminRoleId: adminId,
      minBet: 1000, maxBet: 10000, maxPlayers: 16,
      chohanEnabled: 1, chohanMaxStreakMultiplier: 10, streakRetentionSeconds: 300,
      pokerEnabled: 1, pokerBaseMultiplier: 2, pokerAceLowEnabled: 1,
      pokerBonusEnabled: 1, pokerDealerQualificationRank: "high-card", pokerDealerMinimumHighCard: 12,
    }));
    const settings = values.mock.calls[0]![0];
    expect(settings.chohanMultipliers["1"]).toBe(2);
    expect(settings.chohanMultipliers["10"]).toBe(10);
    expect(settings.pokerBonusMultipliers["straight-flush"]).toBe(10);
    expect(Object.keys(settings.pokerBonusMultipliers)).toHaveLength(6);
    expect(onConflictDoNothing).toHaveBeenCalledOnce();
  });

  it("指定されたロールが別名になっていたら保存しない", async () => {
    vi.mocked(getDealerCasinoSettings).mockResolvedValue(null);
    const { client, roles } = clientWithRoles();
    roles.set(adminId, { name: "別ロール" });
    await expect(initializeDealerCasinoForGuild(client)).rejects.toThrow("初期設定を保存しませんでした");
    expect(db.insert).not.toHaveBeenCalled();
  });
});