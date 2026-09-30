import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplicationCommandOptionType, Collection, type ChatInputCommandInteraction } from "discord.js";

const dbMocks = vi.hoisted(() => ({
  getBountyPoints: vi.fn(),
  getBountySettings: vi.fn(),
  listBountyAccountBalances: vi.fn(),
}));
vi.mock("@workspace/db", () => dbMocks);

import { BOUNTY_GUILD_ID, bountyCommand } from "../commands/bounty";

const member = (id: string, crew: boolean, bot = false) => ({
  id, user: { bot },
  roles: { cache: { has: (roleId: string) => roleId === "crew" && crew } },
});

function makeInteraction(subcommand: string, opts: {
  userId?: string; staff?: boolean; page?: number; members?: ReturnType<typeof member>[];
} = {}) {
  const members = new Collection((opts.members ?? []).map((value) => [value.id, value]));
  const reply = vi.fn();
  const deferReply = vi.fn();
  const editReply = vi.fn();
  const interaction = {
    guildId: BOUNTY_GUILD_ID,
    guild: { memberCount: members.size, members: { fetch: vi.fn(async () => members) } },
    user: { id: "self" },
    memberPermissions: { has: () => opts.staff ?? false },
    options: {
      getSubcommand: () => subcommand,
      getUser: () => opts.userId ? { id: opts.userId } : null,
      getInteger: () => opts.page ?? null,
    },
    reply, deferReply, editReply,
  };
  return { interaction: interaction as unknown as ChatInputCommandInteraction, reply, deferReply, editReply };
}

afterEach(() => vi.resetAllMocks());

describe("/bounty points commands", () => {
  it("registers a user picker for balance and a page option for ranking", () => {
    const options = bountyCommand.data.toJSON().options ?? [];
    const balance = options.find((option) => option.name === "balance");
    const ranking = options.find((option) => option.name === "ranking");
    expect(balance?.type).toBe(ApplicationCommandOptionType.Subcommand);
    expect(ranking?.type).toBe(ApplicationCommandOptionType.Subcommand);
    if (!balance || !("options" in balance) || !ranking || !("options" in ranking)) {
      throw new Error("Missing bounty command options");
    }
    expect(balance.options?.map((option) => option.name)).toEqual(["user"]);
    expect(ranking.options?.map((option) => option.name)).toEqual(["page"]);
  });

  it("retains own balance while letting only staff look up someone else", async () => {
    dbMocks.getBountyPoints.mockResolvedValue(250);
    const own = makeInteraction("balance");
    await bountyCommand.execute(own.interaction);
    expect(dbMocks.getBountyPoints).toHaveBeenCalledWith(BOUNTY_GUILD_ID, "self");
    expect(own.reply.mock.calls[0]?.[0].content).toContain("250 pt");

    const denied = makeInteraction("balance", { userId: "other" });
    await bountyCommand.execute(denied.interaction);
    expect(denied.reply.mock.calls[0]?.[0].ephemeral).toBe(true);
    expect(dbMocks.getBountyPoints).toHaveBeenCalledTimes(1);

    const permitted = makeInteraction("balance", { userId: "other", staff: true });
    await bountyCommand.execute(permitted.interaction);
    expect(dbMocks.getBountyPoints).toHaveBeenCalledWith(BOUNTY_GUILD_ID, "other");
    expect(permitted.reply.mock.calls[0]?.[0]).toMatchObject({
      content: expect.stringContaining("<@other> の賞金ポイント: **250 pt**"),
      ephemeral: true,
    });
  });

  it("ranks current non-bot crew members including zero points, not past members or other roles", async () => {
    dbMocks.getBountySettings.mockResolvedValue({ crewRoleId: "crew" });
    dbMocks.listBountyAccountBalances.mockResolvedValue([
      { userId: "former", points: 999 },
      { userId: "visitor", points: 500 },
      { userId: "bot", points: 400 },
      { userId: "second", points: 50 },
      { userId: "first", points: 120 },
    ]);
    const { interaction, editReply, deferReply } = makeInteraction("ranking", {
      members: [member("first", true), member("second", true), member("zero", true),
        member("visitor", false), member("bot", true, true)],
    });
    await bountyCommand.execute(interaction);
    expect(deferReply).toHaveBeenCalledOnce();
    const output = editReply.mock.calls[0]?.[0].content as string;
    expect(output).toContain("5");
    expect(output).toContain("1位 <@first> — 120 pt");
    expect(output).toContain("2位 <@second> — 50 pt");
    expect(output).toContain("3位 <@zero> — 0 pt");
    expect(output).not.toContain("former");
    expect(output).not.toContain("visitor");
    expect(output).not.toContain("<@bot>");
    expect(editReply.mock.calls[0]?.[0].allowedMentions).toEqual({ parse: [] });
  });

  it("supports ranking pages and rejects an incomplete member fetch", async () => {
    dbMocks.getBountySettings.mockResolvedValue({ crewRoleId: "crew" });
    dbMocks.listBountyAccountBalances.mockResolvedValue([]);
    const paged = makeInteraction("ranking", {
      page: 2,
      members: Array.from({ length: 11 }, (_, index) => member(`user-${String(index).padStart(2, "0")}`, true)),
    });
    await bountyCommand.execute(paged.interaction);
    expect(paged.editReply.mock.calls[0]?.[0].content).toContain("11位 <@user-10> — 0 pt");
    expect(paged.editReply.mock.calls[0]?.[0].content).not.toContain("<@user-00>");

    const incomplete = makeInteraction("ranking", { members: [member("first", true)] });
    (incomplete.interaction.guild as { memberCount: number }).memberCount = 2;
    await bountyCommand.execute(incomplete.interaction);
    expect(incomplete.editReply.mock.calls[0]?.[0]).toContain("全メンバーを取得できなかった");
    expect(dbMocks.listBountyAccountBalances).toHaveBeenCalledTimes(1);
  });
});