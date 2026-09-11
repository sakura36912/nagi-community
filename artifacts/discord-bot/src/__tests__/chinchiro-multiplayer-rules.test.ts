import { describe, expect, it } from "vitest";
import type { ChinchiroTable, ChinchiroTablePlayer } from "@workspace/db";
import {
  buildMultiplayerChinchiroComponents,
  buildMultiplayerChinchiroPanel,
  calculateRoundResults,
  chinchiroMultiplier,
  pairStake,
  rollOrder,
} from "../commands/chinchiroMultiplayer";
import { evaluateChinchiroRoll } from "../commands/chinchiro";

const player = (userId: string, joinOrder: number, bet: number, attempts: number[][]): ChinchiroTablePlayer => ({
  id: joinOrder,
  tableId: 1,
  userId,
  displayName: userId,
  joinOrder,
  bet,
  roll: JSON.stringify(evaluateChinchiroRoll(attempts)),
  active: 1,
  createdAt: new Date(),
});

describe("multiplayer chinchiro planning helpers", () => {
  it("puts the parent first regardless of join order", () => {
    expect(rollOrder("third", [
      { userId: "first", joinOrder: 1 },
      { userId: "second", joinOrder: 2 },
      { userId: "third", joinOrder: 3 },
    ])).toEqual(["third", "first", "second"]);
  });

  it("uses the pair minimum and the winning hand multiplier", () => {
    expect(pairStake(2_000, 500)).toBe(500);
    expect(chinchiroMultiplier({ kind: "pinzoro" })).toBe(5);
    expect(chinchiroMultiplier({ kind: "hifumi" })).toBe(2);
  });

  it("builds isolated pair results and planned net changes", () => {
    const result = calculateRoundResults("parent", [
      player("parent", 2, 1_000, [[1, 1, 1]]),
      player("child", 1, 400, [[2, 2, 6]]),
    ]);
    expect(result.pairs[0]).toMatchObject({ childId: "child", stake: 400, winner: "parent", amount: 2_000 });
    expect(result.net).toEqual({ parent: 2_000, child: -2_000 });
  });

  it("does not include the rules field in the public table embed", () => {
    const table: ChinchiroTable = {
      id: 1,
      guildId: "guild",
      channelId: "channel",
      messageId: null,
      ownerId: "parent",
      parentId: "parent",
      status: "rolling",
      currencyName: "コイン",
      round: 1,
      turnUserId: "parent",
      results: null,
      history: "[]",
      expiresAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const embed = buildMultiplayerChinchiroPanel(table, [
      player("parent", 1, 1_000, []),
      player("child", 2, 1_000, []),
    ]).toJSON();
    expect(embed.fields?.some((field) => field.name === "ルール")).toBe(false);
    expect(JSON.stringify(embed)).not.toContain("最大3投");
  });

  it("does not show a roll button on the public table during another player's turn", () => {
    const table: ChinchiroTable = {
      id: 1,
      guildId: "guild",
      channelId: "channel",
      messageId: null,
      ownerId: "parent",
      parentId: "parent",
      status: "rolling",
      currencyName: "コイン",
      round: 1,
      turnUserId: "parent",
      results: null,
      history: "[]",
      expiresAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(buildMultiplayerChinchiroComponents(table)).toEqual([]);
  });
});