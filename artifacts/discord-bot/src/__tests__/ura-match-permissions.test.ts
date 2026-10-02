import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType, Collection, OverwriteType, PermissionFlagsBits, PermissionsBitField, type Guild } from "discord.js";

const db = vi.hoisted(() => ({ listUraMatchesForGuildBefore: vi.fn() }));
vi.mock("@workspace/db", () => db);
vi.mock("../lib/logger", () => ({ logger: { warn: vi.fn() } }));
import { logger } from "../lib/logger";
import { syncExistingUraMatchPermissions, uraMatchPermissionOverwrites } from "../lib/uraMatchPermissions";

const media = [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.Stream];
const match = { id: 1, status: "active", channelId: "vc", hostId: "host", guestId: "guest" };
function fixture(allowed = false) {
  const edit = vi.fn();
  const overwrites = new Collection(["everyone", "host", "guest", "other"].map((id) => [id, {
    id, type: id === "everyone" ? OverwriteType.Role : OverwriteType.Member,
    allow: new PermissionsBitField(allowed && (id === "host" || id === "guest") ? media : []),
    deny: new PermissionsBitField([PermissionFlagsBits.ManageChannels]),
  }]));
  const channel = {
    type: ChannelType.GuildVoice, guild: { id: "guild" },
    permissionOverwrites: { cache: overwrites, edit },
  };
  const fetch = vi.fn(async () => channel);
  const guild = {
    id: "guild", roles: { everyone: { id: "everyone" } },
    client: { user: { id: "bot" } }, channels: { fetch },
  } as unknown as Guild;
  return { guild, channel, edit, fetch, overwrites };
}

beforeEach(() => {
  vi.resetAllMocks();
  db.listUraMatchesForGuildBefore.mockResolvedValue([match]);
});

describe("裏航海VCのチャット・画面共有権限", () => {
  it("新規VCは双方だけにチャット・履歴・画面共有を許可し、全員への非公開設定を維持する", () => {
    const { guild } = fixture();
    const result = uraMatchPermissionOverwrites(guild, "host", "guest");
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({
      id: "everyone", deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
    });
    for (const index of [1, 2]) {
      expect(result[index]).toEqual({
        id: index === 1 ? "host" : "guest", type: OverwriteType.Member,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, ...media],
      });
    }
    expect(result[3]).toMatchObject({ id: "bot", type: OverwriteType.Member });
  });

  it("既存のactive VCを双方のメンバー権限だけで更新し、他の設定を変更しない", async () => {
    const { guild, edit, overwrites } = fixture();
    const everyone = overwrites.get("everyone");
    const other = overwrites.get("other");
    expect(await syncExistingUraMatchPermissions(guild)).toBe(true);
    expect(db.listUraMatchesForGuildBefore).toHaveBeenCalledWith("guild", expect.any(Date));
    expect(edit).toHaveBeenCalledTimes(2);
    for (const userId of ["host", "guest"]) {
      expect(edit).toHaveBeenCalledWith(userId, {
        SendMessages: true, ReadMessageHistory: true, Stream: true,
      }, { type: OverwriteType.Member, reason: expect.any(String) });
    }
    expect(overwrites.get("everyone")).toBe(everyone);
    expect(overwrites.get("other")).toBe(other);
  });

  it("更新済みのVCは再更新せず、明示的な拒否が残る参加者だけ修正する", async () => {
    const { guild, edit, overwrites } = fixture(true);
    expect(await syncExistingUraMatchPermissions(guild)).toBe(true);
    expect(edit).not.toHaveBeenCalled();
    overwrites.get("guest")!.deny.add(PermissionFlagsBits.Stream);
    expect(await syncExistingUraMatchPermissions(guild)).toBe(true);
    expect(edit).toHaveBeenCalledOnce();
    expect(edit.mock.calls[0][0]).toBe("guest");
  });

  it("終了済み・チャンネルなしのマッチは更新しない", async () => {
    const { guild, fetch, edit } = fixture();
    db.listUraMatchesForGuildBefore.mockResolvedValue([
      { ...match, status: "finished" }, { ...match, channelId: null },
    ]);
    expect(await syncExistingUraMatchPermissions(guild)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
  });

  it("削除済みVCはスキップし、一時的な取得・更新失敗は記録して再試行できる", async () => {
    const { guild, fetch, edit } = fixture();
    fetch.mockRejectedValueOnce({ code: 10003 });
    expect(await syncExistingUraMatchPermissions(guild)).toBe(true);
    fetch.mockRejectedValueOnce(new Error("Discord unavailable"));
    expect(await syncExistingUraMatchPermissions(guild)).toBe(false);
    edit.mockRejectedValueOnce(new Error("Missing permissions"));
    expect(await syncExistingUraMatchPermissions(guild)).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(await syncExistingUraMatchPermissions(guild)).toBe(true);
  });

  it("別サーバーまたはVC以外のチャンネルを更新しない", async () => {
    const { guild, channel, edit } = fixture();
    channel.guild.id = "other-guild";
    expect(await syncExistingUraMatchPermissions(guild)).toBe(false);
    channel.guild.id = "guild";
    channel.type = ChannelType.GuildText;
    expect(await syncExistingUraMatchPermissions(guild)).toBe(false);
    expect(edit).not.toHaveBeenCalled();
  });
});