import { beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionFlagsBits, PermissionsBitField, type ChatInputCommandInteraction } from "discord.js";

const mocks = vi.hoisted(() => ({
  grant: vi.fn(), settings: vi.fn(), error: vi.fn(),
}));
vi.mock("../lib/adminGrant", () => ({ grantAdminCurrency: mocks.grant, MAX_GRANT_AMOUNT: 2_147_483_647 }));
vi.mock("../lib/economy", () => ({ getGuildSettings: mocks.settings }));
vi.mock("../lib/logger", () => ({ logger: { error: mocks.error } }));
import { giveCommand } from "../commands/give";

function interaction({ admin = true, amount = 100, bot = false, guild = true } = {}) {
  return {
    id: "operation", guildId: guild ? "guild" : null,
    guild: guild ? { members: { fetch: vi.fn().mockResolvedValue({ id: "target" }) } } : null,
    user: { id: "admin" },
    memberPermissions: new PermissionsBitField(admin ? PermissionFlagsBits.Administrator : PermissionFlagsBits.ManageGuild),
    options: { getUser: vi.fn().mockReturnValue({ id: "target", bot }), getInteger: vi.fn().mockReturnValue(amount) },
    reply: vi.fn(), deferReply: vi.fn(), editReply: vi.fn(),
  };
}
type Interaction = ReturnType<typeof interaction>;
async function run(i: Interaction) { await giveCommand.execute(i as unknown as ChatInputCommandInteraction); }

beforeEach(() => {
  vi.resetAllMocks();
  mocks.settings.mockResolvedValue({ currencyName: "ベリー" });
  mocks.grant.mockResolvedValue({ balance: 300, duplicate: false });
});
describe("admin-only /give", () => {
  it("registers only a positive user grant, not the old wallet/treasury/deposit subcommands", () => {
    const data = giveCommand.data.toJSON();
    expect(data.default_member_permissions).toBe(PermissionFlagsBits.Administrator.toString());
    expect(data.dm_permission).toBe(false);
    expect(data.options?.map(o => o.name)).toEqual(["user", "amount"]);
    expect(data.options?.[1]).toMatchObject({ min_value: 1, max_value: 2_147_483_647 });
  });
  it("rejects ManageGuild without Administrator before reading or changing balances", async () => {
    const i = interaction({ admin: false });
    await run(i);
    expect(i.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("管理者のみ") }));
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(mocks.settings).not.toHaveBeenCalled();
  });
  it("rejects DMs", async () => {
    await run(interaction({ guild: false }));
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5, 2_147_483_648, NaN])("rejects invalid amount %s", async amount => {
    await run(interaction({ amount }));
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it("rejects bots", async () => {
    await run(interaction({ bot: true }));
    expect(mocks.grant).not.toHaveBeenCalled();
  });
  it("rejects an absent member or failed member lookup", async () => {
    const i = interaction();
    i.guild!.members.fetch.mockRejectedValue(new Error("unknown member"));
    await run(i);
    expect(mocks.grant).not.toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining("付与していません"));
  });
  it("defers, grants using actor and interaction IDs, and reports amount and balance", async () => {
    const i = interaction();
    await run(i);
    expect(i.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(mocks.grant).toHaveBeenCalledExactlyOnceWith("guild", "target", "admin", 100, "operation");
    const embed = i.editReply.mock.calls[0]![0].embeds[0].toJSON();
    expect(embed.description).toContain("100ベリー");
    expect(embed.fields[0].value).toContain("300ベリー");
  });
  it("reports an already processed operation without claiming another credit", async () => {
    mocks.grant.mockResolvedValue({ balance: 300, duplicate: true });
    const i = interaction();
    await run(i);
    expect(i.editReply.mock.calls[0]![0].embeds[0].toJSON().description).toContain("二重付与はしていません");
  });
  it("hides raw errors without showing success", async () => {
    mocks.grant.mockRejectedValue(new Error("private database error"));
    const i = interaction();
    await run(i);
    expect(i.editReply).toHaveBeenCalledWith(expect.stringContaining("完了できません"));
    expect(JSON.stringify(i.editReply.mock.calls)).not.toContain("private database");
  });
  it("does not retry a committed grant when Discord fails to deliver the receipt", async () => {
    const i = interaction();
    i.editReply.mockRejectedValue(new Error("Discord failure"));
    await expect(run(i)).rejects.toThrow("Discord failure");
    expect(mocks.grant).toHaveBeenCalledTimes(1);
    expect(mocks.error).not.toHaveBeenCalled();
  });
});
