/**
 * Tests for the payHubSalary function in lib/vcReward.ts.
 *
 * Mirrors the payVcReward test structure.  Verifies that the Hub salary path:
 *   1. Credits the wallet and sends a DM to the member.
 *   2. Silently ignores Discord error 50007 (DMs closed) — must NOT propagate.
 *   3. Propagates non-50007 DM errors to the caller.
 *   4. Propagates DB errors to the caller (reward actually failed).
 *   5. Returns 0 and sends no DM when the session is below minMinutes.
 *   6. Returns 0 and sends no DM when the computed reward is 0 (rate yields 0 coins).
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import { DiscordAPIError } from "discord.js";

// ─── DiscordAPIError factory ──────────────────────────────────────────────────
function makeDiscordAPIError(code: number, message: string): DiscordAPIError {
  const err = Object.create(DiscordAPIError.prototype) as DiscordAPIError;
  Object.defineProperties(err, {
    code:    { value: code,    writable: true, enumerable: true, configurable: true },
    message: { value: message, writable: true, enumerable: true, configurable: true },
    status:  { value: 403,    writable: true, enumerable: true, configurable: true },
    method:  { value: "POST", writable: true, enumerable: true, configurable: true },
    url:     { value: "",     writable: true, enumerable: true, configurable: true },
  });
  return err;
}

// ─── Hoist mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  let nextInsertError: Error | null = null;

  function makeInsertChain() {
    const chain = {
      values(_v: unknown) { return chain; },
      onConflictDoUpdate(_opts: unknown) { return chain; },
      then(
        resolve: (v: unknown) => void,
        reject: (e: unknown) => void,
      ) {
        if (nextInsertError) {
          const err = nextInsertError;
          nextInsertError = null;
          reject(err);
        } else {
          resolve([]);
        }
      },
    };
    return chain;
  }

  const db = {
    insert(_table: unknown) { return makeInsertChain(); },
  };

  return {
    db,
    setNextInsertError(err: Error) { nextInsertError = err; },
  };
});

// ─── Mock @workspace/db ───────────────────────────────────────────────────────
vi.mock("@workspace/db", () => ({
  db: mocks.db,
  walletsTable:      { guildId: {}, userId: {}, balance: {} },
  transactionsTable: { guildId: {}, userId: {}, amount: {}, reason: {} },
}));

// ─── Mock drizzle-orm (keep sql passthrough) ──────────────────────────────────
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return { ...actual };
});

// ─── Import SUT (after mocks) ─────────────────────────────────────────────────
import { payHubSalary } from "../lib/vcReward.js";

// ─── Shared fixture ───────────────────────────────────────────────────────────
const SETTINGS = { ratePerHour: 120, minMinutes: 5 } as const;

/** joinedAt N minutes ago */
function makeJoinedAt(minutesAgo: number): Date {
  return new Date(Date.now() - minutesAgo * 60_000);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("payHubSalary — DM success", () => {
  it("returns a positive reward and calls sendDm with the reward amount", async () => {
    const sendDm = vi.fn().mockResolvedValue(undefined);
    const reward = await payHubSalary(
      "guild-1", "user-1", makeJoinedAt(60), "コイン", SETTINGS, sendDm,
    );
    expect(reward).toBeGreaterThan(0);
    expect(sendDm).toHaveBeenCalledOnce();
    expect(sendDm).toHaveBeenCalledWith(expect.stringContaining(`${reward}`));
  });

  it("includes the currencyName in the DM message", async () => {
    const sendDm = vi.fn().mockResolvedValue(undefined);
    await payHubSalary("guild-1", "user-1", makeJoinedAt(60), "ゴールド", SETTINGS, sendDm);
    expect(sendDm).toHaveBeenCalledWith(expect.stringContaining("ゴールド"));
  });
});

describe("payHubSalary — DM silently ignored on 50007", () => {
  it("does NOT throw when sendDm rejects with DiscordAPIError 50007", async () => {
    const dmsClosed = makeDiscordAPIError(50007, "Cannot send messages to this user");
    const sendDm = vi.fn().mockRejectedValue(dmsClosed);

    await expect(
      payHubSalary("guild-2", "user-2", makeJoinedAt(60), "コイン", SETTINGS, sendDm),
    ).resolves.toBeGreaterThan(0);
  });

  it("still credits the wallet before the DM failure (positive return value)", async () => {
    const dmsClosed = makeDiscordAPIError(50007, "Cannot send messages to this user");
    const sendDm = vi.fn().mockRejectedValue(dmsClosed);
    const reward = await payHubSalary(
      "guild-2", "user-2", makeJoinedAt(60), "コイン", SETTINGS, sendDm,
    );
    expect(reward).toBeGreaterThan(0);
  });

  it("propagates a non-50007 DM error to the caller", async () => {
    const serverError = makeDiscordAPIError(500, "Internal Server Error");
    const sendDm = vi.fn().mockRejectedValue(serverError);
    await expect(
      payHubSalary("guild-2", "user-3", makeJoinedAt(60), "コイン", SETTINGS, sendDm),
    ).rejects.toBeInstanceOf(DiscordAPIError);
  });
});

describe("payHubSalary — DB error", () => {
  it("propagates the DB error to the caller (not swallowed)", async () => {
    const dbErr = new Error("connection refused");
    mocks.setNextInsertError(dbErr);
    const sendDm = vi.fn();
    await expect(
      payHubSalary("guild-3", "user-4", makeJoinedAt(60), "コイン", SETTINGS, sendDm),
    ).rejects.toThrow("connection refused");
  });

  it("does not call sendDm when the DB insert fails", async () => {
    mocks.setNextInsertError(new Error("connection refused"));
    const sendDm = vi.fn();
    await payHubSalary("guild-3", "user-5", makeJoinedAt(60), "コイン", SETTINGS, sendDm).catch(
      () => {},
    );
    expect(sendDm).not.toHaveBeenCalled();
  });
});

describe("payHubSalary — zero reward (no DB writes, no DM)", () => {
  it("returns 0 and skips DM when session is below minMinutes", async () => {
    const sendDm = vi.fn();
    const result = await payHubSalary(
      "guild-4", "user-6", makeJoinedAt(2), "コイン",
      { ratePerHour: 120, minMinutes: 5 }, sendDm,
    );
    expect(result).toBe(0);
    expect(sendDm).not.toHaveBeenCalled();
  });

  it("returns 0 and skips DM when computed reward rounds to 0", async () => {
    const sendDm = vi.fn();
    // 1 minute at 1 coin/hour → Math.floor(1/60 * 1) = 0
    const result = await payHubSalary(
      "guild-4", "user-7", makeJoinedAt(1), "コイン",
      { ratePerHour: 1, minMinutes: 0 }, sendDm,
    );
    expect(result).toBe(0);
    expect(sendDm).not.toHaveBeenCalled();
  });
});

describe("payHubSalary — no sendDm callback", () => {
  it("still credits the wallet and returns a reward when no sendDm is provided", async () => {
    const reward = await payHubSalary(
      "guild-5", "user-8", makeJoinedAt(60), "コイン", SETTINGS,
      // no sendDm
    );
    expect(reward).toBeGreaterThan(0);
  });
});
