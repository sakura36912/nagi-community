import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addChestVcSeconds: vi.fn(),
  getGuildSettings: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("../lib/vcReward.js", () => ({
  addChestVcSeconds: mocks.addChestVcSeconds,
}));

vi.mock("../lib/economy.js", () => ({
  getGuildSettings: mocks.getGuildSettings,
}));

vi.mock("../lib/logger.js", () => ({
  logger: {
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

import {
  flushAllTavernSessions,
  getCurrentTavernSeconds,
  getPendingTavernSeconds,
  onTavernJoin,
} from "../lib/chestTracker.js";

describe("chest tavern tracker", () => {
  let testNumber = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T00:00:00.000Z"));
    mocks.addChestVcSeconds.mockReset();
    mocks.getGuildSettings.mockReset();
    mocks.loggerWarn.mockReset();
    mocks.loggerError.mockReset();
    testNumber++;
  });

  it("includes DB-pending flush seconds so the accumulated time does not drop", async () => {
    const guildId = `guild-flush-${testNumber}`;
    const userId = `user-flush-${testNumber}`;
    let resolveWrite!: () => void;
    const writeFinished = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    mocks.addChestVcSeconds.mockReturnValueOnce(writeFinished);

    onTavernJoin(guildId, userId);
    vi.setSystemTime(new Date("2026-08-22T00:10:00.000Z"));

    const flushPromise = flushAllTavernSessions();
    await Promise.resolve();

    // The active session was reset at flush time, but its 10 minutes are still
    // counted while the database write is in flight.
    expect(getCurrentTavernSeconds(guildId, userId)).toBe(0);
    expect(getPendingTavernSeconds(guildId, userId)).toBe(600);

    vi.setSystemTime(new Date("2026-08-22T00:12:00.000Z"));
    expect(
      getPendingTavernSeconds(guildId, userId) +
        getCurrentTavernSeconds(guildId, userId),
    ).toBe(720);

    resolveWrite();
    await flushPromise;
    expect(getPendingTavernSeconds(guildId, userId)).toBe(0);
  });

  it("clears pending seconds after a failed database write", async () => {
    const guildId = `guild-failed-${testNumber}`;
    const userId = `user-failed-${testNumber}`;
    mocks.addChestVcSeconds.mockRejectedValueOnce(new Error("db unavailable"));

    onTavernJoin(guildId, userId);
    vi.setSystemTime(new Date("2026-08-22T00:10:00.000Z"));

    await flushAllTavernSessions();

    expect(getPendingTavernSeconds(guildId, userId)).toBe(0);
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });
});