import { describe, expect, it, vi } from "vitest";
import { ChannelType, Collection, PermissionFlagsBits as P, PermissionsBitField, type Guild, type GuildChannel } from "discord.js";
import { isVcStreamingEnabled, toggleVcStreaming } from "../lib/vcStreaming";

function fixture() {
  const cache = new Collection([
    ["everyone", { id: "everyone", type: 0, allow: new PermissionsBitField(), deny: new PermissionsBitField(P.ViewChannel) }],
    ["role", { id: "role", type: 0, allow: new PermissionsBitField([P.ViewChannel, P.Connect, P.UseApplicationCommands]), deny: new PermissionsBitField(P.Stream) }],
    ["guest", { id: "guest", type: 1, allow: new PermissionsBitField([P.ViewChannel, P.Connect, P.Speak]), deny: new PermissionsBitField(P.Stream) }],
    ["owner", { id: "owner", type: 1, allow: new PermissionsBitField([P.ViewChannel, P.Connect, P.Stream]), deny: new PermissionsBitField() }],
  ]);
  const channel = {
    id: "vc", type: ChannelType.GuildVoice,
    permissionOverwrites: {
      cache,
      edit: vi.fn(async (id: string, options: { Stream: boolean }, settings: { type: number }) => {
        let overwrite = cache.get(id);
        if (!overwrite) {
          overwrite = { id, type: settings.type, allow: new PermissionsBitField(), deny: new PermissionsBitField() };
          cache.set(id, overwrite);
        }
        if (options.Stream) { overwrite.allow.add(P.Stream); overwrite.deny.remove(P.Stream); }
        else { overwrite.deny.add(P.Stream); overwrite.allow.remove(P.Stream); }
        return channel;
      }),
    },
  };
  const guild = {
    id: "guild", roles: { everyone: { id: "everyone" } },
    channels: { fetch: vi.fn(async () => channel) },
  };
  return { channel, guild: guild as unknown as Guild, cache };
}

const enabled = (channel: unknown) => isVcStreamingEnabled(channel as GuildChannel, "everyone");

describe("VC画面共有の共通権限処理", () => {
  it("所有者だけ許可されても、ロール・個別拒否が残ればONと表示しない", () => {
    const { channel } = fixture();
    expect(enabled(channel)).toBe(false);
  });

  it("everyoneが許可でもロールの拒否が残ればONと表示しない", () => {
    const { channel, cache } = fixture();
    cache.get("everyone")!.allow.add(P.Stream);
    expect(enabled(channel)).toBe(false);
  });

  it("継承で拒否がなくても明示許可なしではONと断言しない", () => {
    const { channel, cache } = fixture();
    cache.clear();
    expect(enabled(channel)).toBe(false);
  });

  it("ONでeveryone・ロール・招待者・所有者の拒否を解消し、他の権限を完全に維持する", async () => {
    const { channel, guild, cache } = fixture();
    const before = [...cache.values()].map(o => ({ id: o.id, allow: o.allow.bitfield & ~P.Stream, deny: o.deny.bitfield & ~P.Stream }));
    expect((await toggleVcStreaming(guild, "vc")).enabled).toBe(true);
    for (const o of cache.values()) {
      expect(o.allow.has(P.Stream)).toBe(true);
      expect(o.deny.has(P.Stream)).toBe(false);
    }
    expect([...cache.values()].map(o => ({ id: o.id, allow: o.allow.bitfield & ~P.Stream, deny: o.deny.bitfield & ~P.Stream }))).toEqual(before);
    expect(guild.channels.fetch).toHaveBeenNthCalledWith(1, "vc", { force: true });
    expect(guild.channels.fetch).toHaveBeenNthCalledWith(2, "vc", { force: true });
    expect(channel.permissionOverwrites.edit).toHaveBeenCalledWith("role", { Stream: true }, { type: 0 });
    expect(channel.permissionOverwrites.edit).toHaveBeenCalledWith("guest", { Stream: true }, { type: 1 });
  });

  it("OFFでも個別・ロールの許可を残さず、アクセス権限は変更しない", async () => {
    const { guild, cache } = fixture();
    await toggleVcStreaming(guild, "vc");
    const result = await toggleVcStreaming(guild, "vc");
    expect(result.enabled).toBe(false);
    for (const o of cache.values()) {
      expect(o.allow.has(P.Stream)).toBe(false);
      expect(o.deny.has(P.Stream)).toBe(true);
    }
    expect(cache.get("everyone")!.deny.has(P.ViewChannel)).toBe(true);
    expect(cache.get("role")!.allow.has(P.UseApplicationCommands)).toBe(true);
  });

  it("everyoneの上書きがなければStreamだけの上書きを追加する", async () => {
    const { guild, cache } = fixture();
    cache.delete("everyone");
    await toggleVcStreaming(guild, "vc");
    expect(cache.get("everyone")!.allow.bitfield).toBe(P.Stream);
    expect(cache.get("everyone")!.deny.bitfield).toBe(0n);
  });

  it("招待メンバーへのAPI失敗を無視せず、次回の再試行で残った拒否を修復できる", async () => {
    const { guild, channel, cache } = fixture();
    const edit = channel.permissionOverwrites.edit.getMockImplementation()!;
    channel.permissionOverwrites.edit.mockImplementation(async (id, opts, settings) => {
      if (id === "guest") throw new Error("Missing Permissions");
      return edit(id, opts, settings);
    });
    await expect(toggleVcStreaming(guild, "vc")).rejects.toThrow("1件");
    expect(enabled(channel)).toBe(false);
    expect(cache.get("guest")!.deny.has(P.Stream)).toBe(true);
    channel.permissionOverwrites.edit.mockImplementation(edit);
    expect((await toggleVcStreaming(guild, "vc")).enabled).toBe(true);
  });

  it("APIが成功しても再取得した実権限が一致しなければ失敗にする", async () => {
    const { guild, channel } = fixture();
    channel.permissionOverwrites.edit.mockImplementation(async () => channel);
    await expect(toggleVcStreaming(guild, "vc")).rejects.toThrow("反映を確認できませんでした");
  });

  it("同じVCの同時操作を拒否し、完了後はロックを解除する", async () => {
    const { guild } = fixture();
    const first = toggleVcStreaming(guild, "vc");
    await expect(toggleVcStreaming(guild, "vc")).rejects.toThrow("設定変更中");
    await first;
    await expect(toggleVcStreaming(guild, "vc")).resolves.toMatchObject({ enabled: false });
  });

  it("取得失敗でもロックを解除し、権限を書き換えない", async () => {
    const { guild, channel } = fixture();
    vi.mocked(guild.channels.fetch).mockRejectedValueOnce(new Error("Missing Access"));
    await expect(toggleVcStreaming(guild, "vc")).rejects.toThrow("Missing Access");
    expect(channel.permissionOverwrites.edit).not.toHaveBeenCalled();
    await expect(toggleVcStreaming(guild, "vc")).resolves.toMatchObject({ enabled: true });
  });

  it("VC以外のチャンネルには適用しない", async () => {
    const { guild, channel } = fixture();
    channel.type = ChannelType.GuildText as ChannelType.GuildVoice;
    await expect(toggleVcStreaming(guild, "vc")).rejects.toThrow("VCが見つかりません");
    expect(channel.permissionOverwrites.edit).not.toHaveBeenCalled();
  });
});
