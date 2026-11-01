import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ButtonInteraction, ChatInputCommandInteraction } from "discord.js";
import { blackjackCommand, handleBlackjackButton } from "../commands/blackjack";
import { getOrCreateWallet, getGuildSettings } from "../lib/economy";
import { getBjCardImages } from "../lib/bjCardImages";
import { tryStartCasinoMemberPlay } from "../lib/casinoPlayLimits";

vi.mock("@workspace/db", () => ({ db: {}, walletsTable: {} }));
vi.mock("../commands/casino", () => ({ CASINO_DEFAULT_MAX_BET: 10_000 }));
vi.mock("../lib/economy", () => ({
  getOrCreateWallet: vi.fn(),
  getGuildSettings: vi.fn(),
  recordTransaction: vi.fn(),
  setBjSuitEmoji: vi.fn(),
  setBjPayouts: vi.fn(),
}));
vi.mock("../lib/bjCardImages", () => ({
  getBjCardImages: vi.fn(),
  setBjCardImage: vi.fn(),
  deleteBjCardImage: vi.fn(),
}));
vi.mock("../lib/gcsStorage", () => ({
  uploadImageFromUrl: vi.fn(),
  downloadImageAsBuffer: vi.fn(),
  deleteGcsObject: vi.fn(),
}));
vi.mock("../lib/casinoPlayLimits", () => ({
  tryStartCasinoMemberPlay: vi.fn(),
  dailyLimitReachedMessage: vi.fn(),
}));

describe("blackjack button lock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // A predictable shoe with no opening blackjack.
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.mocked(getOrCreateWallet).mockResolvedValue({} as never);
    vi.mocked(getGuildSettings).mockResolvedValue({ currencyName: "coins", casinoMaxBet: 10_000, bjPayoutBlackjack: 2, bjPayoutWin: 1 } as never);
    vi.mocked(getBjCardImages).mockResolvedValue(new Map());
    vi.mocked(tryStartCasinoMemberPlay).mockResolvedValue({ ok: true, balance: 9_000 } as never);
  });

  afterEach(() => vi.restoreAllMocks());

  it.each(["acknowledgement", "message edit"])(
    "allows a new game after a failed stand %s",
    async (failure) => {
      const userId = `stand-failure-${failure}`;
      const publicMessage = { edit: vi.fn().mockResolvedValue(undefined) };
      const play = () => ({
        guildId: "guild",
        user: { id: userId },
        options: {
          getSubcommand: () => "play",
          getSubcommandGroup: () => null,
          getInteger: () => 1_000,
        },
        deferReply: vi.fn().mockResolvedValue(undefined),
        editReply: vi.fn().mockResolvedValue(publicMessage),
      }) as unknown as ChatInputCommandInteraction;

      await blackjackCommand.execute(play());
      const button = {
        guildId: "guild",
        user: { id: userId },
        customId: `bj:stand:${userId}`,
        deferUpdate: vi.fn().mockResolvedValue(undefined),
      };
      if (failure === "acknowledgement") {
        button.deferUpdate.mockRejectedValueOnce(new Error("ack failed"));
      } else {
        publicMessage.edit.mockRejectedValueOnce(new Error("edit failed"));
      }

      await expect(handleBlackjackButton(button as unknown as ButtonInteraction)).rejects.toThrow();
      await blackjackCommand.execute(play());
      expect(tryStartCasinoMemberPlay).toHaveBeenCalledTimes(2);
    },
  );
});