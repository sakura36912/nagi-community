import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ButtonInteraction, MessageFlags, PermissionFlagsBits, type ChatInputCommandInteraction } from "discord.js";
import { blackjackCommand, handleBlackjackButton, resolveOutcome } from "../commands/blackjack";
import { getGuildSettings, getOrCreateWallet, recordTransaction, setBjPayouts } from "../lib/economy";
import { getBjCardImages } from "../lib/bjCardImages";
import { tryStartCasinoMemberPlay } from "../lib/casinoPlayLimits";

const wallet = vi.hoisted(() => ({
  returning: vi.fn(), set: vi.fn(),
}));
vi.mock("@workspace/db", () => ({
  db: { update: () => ({ set: wallet.set }) }, walletsTable: {},
}));
vi.mock("../commands/casino", () => ({ CASINO_DEFAULT_MAX_BET: 100_000 }));
vi.mock("../lib/economy", () => ({
  getGuildSettings: vi.fn(), getOrCreateWallet: vi.fn(), setBjPayouts: vi.fn(),
  recordTransaction: vi.fn(), setBjSuitEmoji: vi.fn(),
}));
vi.mock("../lib/bjCardImages", () => ({
  getBjCardImages: vi.fn(), setBjCardImage: vi.fn(), deleteBjCardImage: vi.fn(),
}));
vi.mock("../lib/gcsStorage", () => ({
  uploadImageFromUrl: vi.fn(), downloadImageAsBuffer: vi.fn(), deleteGcsObject: vi.fn(),
}));
vi.mock("../lib/casinoPlayLimits", () => ({
  tryStartCasinoMemberPlay: vi.fn(), dailyLimitReachedMessage: vi.fn(),
}));

type Game = Parameters<typeof resolveOutcome>[0];
function game(player: string[], dealer: string[], blackjack = 2, win = 1): Game {
  return {
    bet: 1001,
    playerHand: player.map((rank) => ({ rank, suit: "♠" })) as Game["playerHand"],
    dealerHand: dealer.map((rank) => ({ rank, suit: "♥" })) as Game["dealerHand"],
    bjPayoutBlackjack: blackjack, bjPayoutWin: win,
  };
}

describe("resolveOutcome blackjack precedence", () => {
  it("loses when the player is below 21 and the dealer has blackjack", () => {
    expect(resolveOutcome(game(["10", "9"], ["A", "K"]))).toEqual({
      outcome: "lose", netDelta: -1001,
    });
  });

  it("pushes when both the player and dealer have blackjack", () => {
    expect(resolveOutcome(game(["A", "K"], ["A", "Q"]))).toEqual({
      outcome: "push", netDelta: 0,
    });
  });

  it("awards blackjack when only the player has blackjack", () => {
    expect(resolveOutcome(game(["A", "K"], ["10", "9"]))).toEqual({
      outcome: "blackjack", netDelta: 2002,
    });
  });
});

describe("blackjack payout math", () => {
  it("uses default and custom BJ net multipliers, rounding down", () => {
    expect(resolveOutcome(game(["A", "K"], ["10", "9"]))).toEqual({ outcome: "blackjack", netDelta: 2002 });
    expect(resolveOutcome(game(["A", "K"], ["10", "9"], 2.5))).toEqual({ outcome: "blackjack", netDelta: 2502 });
  });
  it("uses normal-win multipliers for higher hands and dealer bust", () => {
    expect(resolveOutcome(game(["10", "9"], ["10", "8"]))).toEqual({ outcome: "win", netDelta: 1001 });
    expect(resolveOutcome(game(["10", "9"], ["10", "8"], 2, 0.75))).toEqual({ outcome: "win", netDelta: 750 });
    expect(resolveOutcome(game(["10", "8"], ["10", "9", "5"], 2, 3))).toEqual({ outcome: "win", netDelta: 3003 });
  });
  it("allows zero profit without losing the returned stake", () => {
    expect(resolveOutcome(game(["A", "K"], ["10", "9"], 0))).toEqual({ outcome: "blackjack", netDelta: 0 });
    expect(resolveOutcome(game(["10", "9"], ["10", "8"], 2, 0))).toEqual({ outcome: "win", netDelta: 0 });
  });
  it("does not change draws and losses", () => {
    expect(resolveOutcome(game(["A", "K"], ["A", "Q"], 100, 100))).toEqual({ outcome: "push", netDelta: 0 });
    expect(resolveOutcome(game(["10", "8"], ["10", "8"], 100, 100))).toEqual({ outcome: "push", netDelta: 0 });
    expect(resolveOutcome(game(["10", "9"], ["A", "K"], 100, 100))).toEqual({ outcome: "lose", netDelta: -1001 });
    expect(resolveOutcome(game(["10", "9", "5"], ["10", "8"], 100, 100))).toEqual({ outcome: "lose", netDelta: -1001 });
    expect(resolveOutcome(game(["10", "7"], ["10", "8"], 100, 100))).toEqual({ outcome: "lose", netDelta: -1001 });
  });
});

function config(guildId: string, blackjack: number | null, win: number | null, admin = true) {
  return {
    guildId,
    memberPermissions: { has: vi.fn().mockReturnValue(admin) },
    options: {
      getSubcommand: () => "payout", getSubcommandGroup: () => "config",
      getNumber: (name: string) => name === "blackjack" ? blackjack : win,
    },
    reply: vi.fn(), deferReply: vi.fn(), editReply: vi.fn(),
  };
}
const execute = (interaction: ReturnType<typeof config>) =>
  blackjackCommand.execute(interaction as unknown as ChatInputCommandInteraction);

describe("blackjack payout command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wallet.set.mockReturnValue({ where: () => ({ returning: wallet.returning }) });
    wallet.returning.mockResolvedValue([{ balance: 13_000 }]);
    vi.mocked(recordTransaction).mockResolvedValue(undefined as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("registers fractional number options with valid limits", () => {
    const definition = blackjackCommand.data.toJSON();
    const group = definition.options!.find((option) => option.name === "config") as any;
    const payout = group.options.find((option: any) => option.name === "payout");
    expect(payout.options).toEqual([
      expect.objectContaining({ name: "blackjack", type: 10, min_value: 0, max_value: 100 }),
      expect.objectContaining({ name: "win", type: 10, min_value: 0, max_value: 100 }),
    ]);
  });

  it("rejects non-administrators before reading or writing settings", async () => {
    const interaction = config("guild-a", 3, 2, false);
    await execute(interaction);
    expect(interaction.memberPermissions.has).toHaveBeenCalledWith(PermissionFlagsBits.Administrator);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
    expect(setBjPayouts).not.toHaveBeenCalled();
    expect(getGuildSettings).not.toHaveBeenCalled();
  });

  it.each([-1, 101, NaN, Infinity])("rejects invalid multipliers %s", async (value) => {
    const interaction = config("guild-a", value, null);
    await execute(interaction);
    expect(interaction.reply).toHaveBeenCalled();
    expect(setBjPayouts).not.toHaveBeenCalled();
  });

  it("writes only supplied settings in the invoking guild", async () => {
    vi.mocked(setBjPayouts).mockResolvedValue({ bjPayoutBlackjack: 2.5, bjPayoutWin: 1 } as never);
    const a = config("guild-a", 2.5, null);
    await execute(a);
    expect(setBjPayouts).toHaveBeenLastCalledWith("guild-a", { bjPayoutBlackjack: 2.5 });
    expect(a.editReply.mock.calls[0][0].embeds[0].toJSON().description).toContain("2.5倍");
    vi.mocked(setBjPayouts).mockResolvedValue({ bjPayoutBlackjack: 2, bjPayoutWin: 0 } as never);
    await execute(config("guild-b", null, 0));
    expect(setBjPayouts).toHaveBeenLastCalledWith("guild-b", { bjPayoutWin: 0 });
    expect(a.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  });

  it("shows current settings without updating when options are omitted", async () => {
    vi.mocked(getGuildSettings).mockResolvedValue({ bjPayoutBlackjack: 4, bjPayoutWin: 1.5 } as never);
    const interaction = config("guild-b", null, null);
    await execute(interaction);
    expect(getGuildSettings).toHaveBeenCalledWith("guild-b");
    expect(setBjPayouts).not.toHaveBeenCalled();
    expect(interaction.editReply.mock.calls[0][0].embeds[0].toJSON().description).toContain("1.5倍");
  });

  it("shows the starting guild's actual multipliers in the game", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.mocked(getGuildSettings).mockResolvedValue({
      currencyName: "coins", bjPayoutBlackjack: 3.5, bjPayoutWin: 1.25,
    } as never);
    vi.mocked(getOrCreateWallet).mockResolvedValue({} as never);
    vi.mocked(getBjCardImages).mockResolvedValue(new Map());
    vi.mocked(tryStartCasinoMemberPlay).mockResolvedValue({ ok: true, balance: 9000 } as never);
    const interaction = {
      guildId: "display-guild", user: { id: "display-user" },
      options: { getSubcommand: () => "play", getSubcommandGroup: () => null, getInteger: () => 1000 },
      deferReply: vi.fn(), editReply: vi.fn().mockResolvedValue({ edit: vi.fn() }),
    };
    await blackjackCommand.execute(interaction as unknown as ChatInputCommandInteraction);
    const footer = interaction.editReply.mock.calls[0][0].embeds.at(-1).toJSON().footer.text;
    expect(footer).toContain("BJ=3.5倍");
    expect(footer).toContain("通常勝利=1.25倍");
  });

  it.each([
    { random: 0.32, bj: 2.5, win: 1, payout: 3503, delta: 2502, immediate: true },
    { random: 0.04, bj: 2, win: 1.25, payout: 2252, delta: 1251, immediate: false },
  ])("credits stake plus configured profit for $immediate immediate settlement", async ({ random, bj, win, payout, delta, immediate }) => {
    vi.spyOn(Math, "random").mockReturnValue(random);
    const settings = { currencyName: "coins", bjPayoutBlackjack: bj, bjPayoutWin: win };
    vi.mocked(getGuildSettings).mockResolvedValue(settings as never);
    vi.mocked(getOrCreateWallet).mockResolvedValue({} as never);
    vi.mocked(getBjCardImages).mockResolvedValue(new Map());
    vi.mocked(tryStartCasinoMemberPlay).mockResolvedValue({ ok: true, balance: 8999 } as never);
    const guildId = `settlement-${immediate}`;
    const userId = "winner";
    const publicMessage = { edit: vi.fn() };
    const interaction = {
      guildId, user: { id: userId },
      options: { getSubcommand: () => "play", getSubcommandGroup: () => null, getInteger: () => 1001 },
      deferReply: vi.fn(), editReply: vi.fn().mockResolvedValue(publicMessage),
    };
    await blackjackCommand.execute(interaction as unknown as ChatInputCommandInteraction);
    if (!immediate) {
      // Changing guild settings after the opening hand must not alter the agreed payout.
      settings.bjPayoutWin = 99;
      const button = Object.assign(Object.create(ButtonInteraction.prototype), {
        guildId, user: { id: userId }, customId: `bj:stand:${userId}`,
        deferUpdate: vi.fn(),
      });
      await handleBlackjackButton(button);
    }
    expect(wallet.set).toHaveBeenCalledTimes(1);
    const query = wallet.set.mock.calls[0][0].balance;
    expect(query.queryChunks).toContain(payout);
    expect(recordTransaction).toHaveBeenCalledWith(guildId, userId, delta, expect.any(String));
    expect(getGuildSettings).toHaveBeenCalledTimes(1);
  });
});
