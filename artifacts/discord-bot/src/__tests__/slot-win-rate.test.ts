import { describe, expect, it, vi } from "vitest";
import {
  evaluatePaylines,
  SLOT_SETTING_PROFILES,
  hasSlotSetupAccess,
  slotCommand,
  spinGridWithWinRate,
} from "../commands/slot.js";

const pool = ["🍒", "🍋"];

describe("スロットの当選確率設定", () => {
  it("100%では少なくとも1ラインが当選する", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);

    const grid = spinGridWithWinRate(pool, 100);

    expect(evaluatePaylines(grid).some((line) => line.won)).toBe(true);
    vi.restoreAllMocks();
  });

  it("0%では当選ラインを作らない", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);

    const grid = spinGridWithWinRate(pool, 0);

    expect(evaluatePaylines(grid).some((line) => line.won)).toBe(false);
    vi.restoreAllMocks();
  });

  it("確率未設定時は従来どおり重みに基づく通常抽選を使う", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);

    const grid = spinGridWithWinRate(pool, null);

    expect(evaluatePaylines(grid).some((line) => line.won)).toBe(true);
    vi.restoreAllMocks();
  });

  it("中間の確率設定は指定値に近い当選率になる", () => {
    const trials = 1_000;
    let wins = 0;
    for (let i = 0; i < trials; i++) {
      if (evaluatePaylines(spinGridWithWinRate(pool, 40)).some((line) => line.won)) {
        wins++;
      }
    }

    expect(wins / trials).toBeGreaterThan(0.32);
    expect(wins / trials).toBeLessThan(0.48);
  });

  it("設定1〜6は当選確率だけを段階的に変更する", () => {
    expect(SLOT_SETTING_PROFILES.map((profile) => profile.setting)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(SLOT_SETTING_PROFILES.map((profile) => profile.winRate)).toEqual([33, 35, 36, 38, 40, 43]);
    expect(SLOT_SETTING_PROFILES.map((profile) => profile.payoutRate)).toEqual([84, 88, 92.6, 97, 102, 108]);
  });

  it("設定サブコマンドに1〜6の選択肢が登録されている", () => {
    type CommandOption = {
      name?: string;
      options?: CommandOption[];
      choices?: Array<{ value?: number }>;
    };
    const command = slotCommand.data.toJSON() as {
      options?: CommandOption[];
    };
    const setup = command.options?.find((option) => option.name === "setup");
    const setting = setup?.options?.find((option) => option.name === "setting");
    expect(setting?.options?.[0]?.choices?.map((choice) => choice.value)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("賭博頭領ロールには設定変更・一覧の権限を与える", async () => {
    const interaction = {
      user: { id: "user-1" },
      memberPermissions: { has: () => false },
      guild: {
        members: {
          cache: {
            get: () => ({
              roles: {
                cache: {
                  some: (predicate: (role: { name: string }) => boolean) => predicate({ name: "賭博頭領" }),
                },
              },
            }),
          },
        },
      },
    } as unknown as Parameters<typeof hasSlotSetupAccess>[0];

    await expect(hasSlotSetupAccess(interaction)).resolves.toBe(true);
  });

  it("賭博頭領でない一般ユーザーには設定権限を与えない", async () => {
    const interaction = {
      user: { id: "user-1" },
      memberPermissions: { has: () => false },
      guild: {
        members: {
          cache: {
            get: () => ({
              roles: {
                cache: {
                  some: () => false,
                },
              },
            }),
          },
        },
      },
    } as unknown as Parameters<typeof hasSlotSetupAccess>[0];

    await expect(hasSlotSetupAccess(interaction)).resolves.toBe(false);
  });
});