import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChannelType, Collection, MessageFlags, type ActionRowBuilder, type ChannelSelectMenuBuilder,
  type ChannelSelectMenuInteraction, type ChatInputCommandInteraction,
} from "discord.js";
const m = vi.hoisted(() => ({ config: vi.fn(), update: vi.fn(), change: vi.fn(), game: vi.fn() }));
vi.mock("@workspace/db", async original => ({
  ...await original<typeof import("@workspace/db")>(),
  getZombieConfig: m.config, updateZombieConfig: m.update, changeZombieSettingList: m.change, getZombieGame: m.game,
}));
vi.mock("../lib/zombieRuntime.js", () => ({
  flushZombieJobs: vi.fn(), observeZombieGuild: vi.fn(), zombieRoleName: vi.fn(), zombieTextChannel: vi.fn(),
}));
import { handleZombieVcSelection, zombieCommands } from "../commands/zombie";
const G = "100000000000000001", U = "200000000000000001";
const A = "300000000000000001", B = "300000000000000002", C = "300000000000000003";
function fixture() {
  const flags = { admin: true };
  return {
    flags, commandName: "zombie", user: { id: U }, client: {},
    customId: `zmbvc:${G}:${U}:${Date.now()}`, values: [A, B],
    guild: {
      id: G, roles: { fetch: vi.fn(async () => new Collection()) },
      members: { fetch: vi.fn(async () => ({ permissions: { has: () => flags.admin } })) },
      channels: { fetch: vi.fn(async (id: string): Promise<{ id: string; type: ChannelType; guildId: string } | null> =>
        ({ id, type: ChannelType.GuildVoice, guildId: G })) },
    },
    options: {
      getSubcommand: () => "vc", getChannel: vi.fn(() => null as { id: string } | null),
      getBoolean: vi.fn(() => null as boolean | null),
    },
    deferReply: vi.fn(async (_data: unknown) => undefined), deferUpdate: vi.fn(async () => undefined),
    editReply: vi.fn(async (_data: unknown) => undefined), followUp: vi.fn(async (_data: unknown) => undefined),
  };
}
const run = (i: ReturnType<typeof fixture>) => zombieCommands[0]!.execute(i as unknown as ChatInputCommandInteraction);
const select = (i: ReturnType<typeof fixture>) => handleZombieVcSelection(i as unknown as ChannelSelectMenuInteraction);
beforeEach(() => {
  vi.resetAllMocks();
  m.config.mockResolvedValue({ vcIds: [A, B], excludedUsers: ["excluded"], rewards: { humanSurvival: 10 } });
});
describe("zombie multi-VC selection", () => {
  it("makes both legacy options optional so /zombie vc can open the selector", () => {
    const vc = zombieCommands[0]!.data.toJSON().options!.find(o => o.name === "vc")!;
    expect("options" in vc && vc.options!.every(o => !o.required)).toBe(true);
  });
  it("opens a private multi-selector with existing selections without changing data", async () => {
    const i = fixture(); await run(i);
    expect(i.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    const payload = i.editReply.mock.calls[0]![0] as { components: ActionRowBuilder<ChannelSelectMenuBuilder>[] };
    const menu = payload.components[0]!.components[0]!.toJSON();
    expect(menu.channel_types).toEqual([ChannelType.GuildVoice]);
    expect(menu.max_values).toBe(25); expect(menu.min_values).toBe(0);
    expect(menu.default_values?.map(v => v.id)).toEqual([A, B]);
    expect(menu.custom_id).toMatch(new RegExp(`^zmbvc:${G}:${U}:`));
    expect(m.update).not.toHaveBeenCalled(); expect(m.change).not.toHaveBeenCalled();
  });
  it("allows opening before any VCs are configured", async () => {
    m.config.mockResolvedValue(null);
    const i = fixture(); await run(i);
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("0件") }));
  });
  it("replaces the whole VC list atomically without touching rewards or the active game", async () => {
    const i = fixture(); i.values = [B, C]; await select(i);
    expect(i.deferUpdate).toHaveBeenCalled();
    expect(m.update).toHaveBeenCalledExactlyOnceWith(G, { vcIds: [B, C] });
    expect(m.game).not.toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ components: [], content: expect.stringContaining("2件保存") }));
    expect(i.followUp).not.toHaveBeenCalled();
  });
  it("explicitly clears all targets when zero VCs are selected", async () => {
    const i = fixture(); i.values = []; await select(i);
    expect(m.update).toHaveBeenCalledWith(G, { vcIds: [] });
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("すべて解除") }));
  });
  it("rechecks administrator permissions at selection time", async () => {
    const i = fixture(); i.flags.admin = false; await select(i);
    expect(m.update).not.toHaveBeenCalled();
    expect(i.followUp).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral, content: "管理者のみ操作できます。" }));
  });
  it.each(["owner", "guild", "expired", "future", "malformed"])("rejects a %s mismatch without overwriting config", async kind => {
    const i = fixture();
    if (kind === "owner") i.user.id = "200000000000000002";
    if (kind === "guild") i.guild.id = "100000000000000002";
    if (kind === "expired") i.customId = `zmbvc:${G}:${U}:${Date.now() - 16 * 60000}`;
    if (kind === "future") i.customId = `zmbvc:${G}:${U}:${Date.now() + 60000}`;
    if (kind === "malformed") i.customId = `zmbvc:${G}:${U}:NaN`;
    await select(i);
    expect(m.update).not.toHaveBeenCalled(); expect(i.editReply).not.toHaveBeenCalled();
    expect(i.followUp).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
  });
  it.each(["text", "stage", "deleted", "foreign"])("rejects a %s channel before saving any selection", async kind => {
    const i = fixture();
    i.guild.channels.fetch.mockResolvedValueOnce({ id: A, type: ChannelType.GuildVoice, guildId: G })
      .mockResolvedValueOnce(kind === "deleted" ? null : {
        id: B, type: kind === "text" ? ChannelType.GuildText : kind === "stage" ? ChannelType.GuildStageVoice : ChannelType.GuildVoice,
        guildId: kind === "foreign" ? "other" : G,
      });
    await select(i); expect(m.update).not.toHaveBeenCalled();
    expect(i.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("保存していません") }));
  });
  it.each(["duplicates", "over-limit"])("rejects %s selections", async kind => {
    const i = fixture();
    i.values = kind === "duplicates" ? [A, A] : Array.from({ length: 26 }, (_, n) => String(BigInt(A) + BigInt(n)));
    await select(i); expect(m.update).not.toHaveBeenCalled();
  });
  it("omits deleted defaults without silently removing them from saved settings", async () => {
    const i = fixture();
    i.guild.channels.fetch.mockRejectedValueOnce({ code: 10003 });
    await run(i);
    const payload = i.editReply.mock.calls[0]![0] as { components: ActionRowBuilder<ChannelSelectMenuBuilder>[] };
    expect(payload.components[0]!.components[0]!.toJSON().default_values?.map(v => v.id)).toEqual([B]);
    expect(m.update).not.toHaveBeenCalled();
  });
  it.each([true, false])("preserves legacy single-VC add/remove with enabled=%s", async enabled => {
    const i = fixture(); i.options.getChannel.mockReturnValue({ id: A }); i.options.getBoolean.mockReturnValue(enabled);
    await run(i);
    expect(m.change).toHaveBeenCalledWith(G, "vcIds", A, enabled);
    expect(m.update).not.toHaveBeenCalled();
  });
  it("requires both legacy options together", async () => {
    const i = fixture(); i.options.getChannel.mockReturnValue({ id: A });
    await run(i); expect(m.change).not.toHaveBeenCalled(); expect(m.update).not.toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("両方") }));
  });
  it("does not handle unrelated channel selectors", async () => {
    const i = fixture(); i.customId = "other:vc";
    expect(await select(i)).toBe(false); expect(i.deferUpdate).not.toHaveBeenCalled();
  });
});
