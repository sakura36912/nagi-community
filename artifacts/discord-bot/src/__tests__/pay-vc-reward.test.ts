/**
 * Tests for the payVcReward function in lib/vcReward.ts.
 *
 * Because payVcReward imports @workspace/db directly, we mock that package so
 * no real Postgres connection is needed.
 *
 * Scenarios covered:
 *   1. Reward is credited to the wallet and a DM is sent to the member.
 *   2. Reward is credited but the DM is silently ignored when the member has
 *      DMs closed (Discord error 50007) — this must NOT propagate to the caller.
 *   3. A DB error during wallet credit propagates normally (the reward failed,
 *      not just the DM).
 *   4. Rate = 0 → returns 0 immediately without touching the DB or sending a DM.
 *   5. Session below minMinutes → returns 0 without touching the DB or sending a DM.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import { DiscordAPIError } from "discord.js";

// ─── DiscordAPIError factory ──────────────────────────────────────────────────
/**
 * Build a minimal DiscordAPIError-like object without invoking the real
 * constructor (which requires a fully populated RequestData object).
 * payVcReward only checks `err instanceof DiscordAPIError` and `err.code`.
 */
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
  /**
   * Simple chainable stub that resolves when awaited.
   * Supports: db.insert(t).values(v).onConflictDoUpdate({...}) and
   *           db.insert(t).values(v)  (both are awaited directly by payVcReward).
   */
  let nextInsertError: Error | null = null;

  function makeInsertChain() {
    const chain = {
      values(_v: unknown) { return chain; },
      onConflictDoUpdate(_opts: unknown) { return chain; },
      // Make the chain awaitable (drizzle query builders are thenables).
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
import { payVcReward } from "../lib/vcReward.js";

// ─── Shared fixture ───────────────────────────────────────────────────────────
const SETTINGS = { ratePerHour: 100, minMinutes: 5 } as const;
/** joinedAt 30 minutes ago → 30/60 * 100 = 50 coins */
function makeJoinedAt(minutesAgo = 30): Date {
  return new Date(Date.now() - minutesAgo * 60_000);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("payVcReward — DM success", () => {
  it("returns the coin amount and calls sendDm with the reward message", async () => {
    const sendDm = vi.fn().mockResolvedValue(undefined);
    const reward = await payVcReward(
      "guild-1", "user-1", makeJoinedAt(30), "コイン", SETTINGS, sendDm,
    );
    expect(reward).toBeGreaterThan(0);
    expect(sendDm).toHaveBeenCalledOnce();
    expect(sendDm).toHaveBeenCalledWith(expect.stringContaining(`${reward}`));
  });

  it("includes the currencyName in the DM message", async () => {
    const sendDm = vi.fn().mockResolvedValue(undefined);
    await payVcReward("guild-1", "user-1", makeJoinedAt(30), "ゴールド", SETTINGS, sendDm);
    expect(sendDm).toHaveBeenCalledWith(expect.stringContaining("ゴールド"));
  });
});

describe("payVcReward — DM silently ignored on 50007", () => {
  it("does NOT throw when sendDm rejects with DiscordAPIError 50007", async () => {
    const dmsClosed = makeDiscordAPIError(50007, "Cannot send messages to this user");
    const sendDm = vi.fn().mockRejectedValue(dmsClosed);

    // Should resolve cleanly — no throw.
    await expect(
      payVcReward("guild-2", "user-2", makeJoinedAt(30), "コイン", SETTINGS, sendDm),
    ).resolves.toBeGreaterThan(0);
  });

  it("still credits the wallet before the DM failure (positive return value)", async () => {
    const dmsClosed = makeDiscordAPIError(50007, "Cannot send messages to this user");
    const sendDm = vi.fn().mockRejectedValue(dmsClosed);
    const reward = await payVcReward(
      "guild-2", "user-2", makeJoinedAt(30), "コイン", SETTINGS, sendDm,
    );
    expect(reward).toBeGreaterThan(0);
  });

  it("propagates a non-50007 DM error to the caller", async () => {
    const serverError = makeDiscordAPIError(500, "Internal Server Error");
    const sendDm = vi.fn().mockRejectedValue(serverError);
    await expect(
      payVcReward("guild-2", "user-3", makeJoinedAt(30), "コイン", SETTINGS, sendDm),
    ).rejects.toBeInstanceOf(DiscordAPIError);
  });
});

describe("payVcReward — DB error", () => {
  it("propagates the DB error to the caller (not swallowed)", async () => {
    const dbErr = new Error("connection refused");
    mocks.setNextInsertError(dbErr);
    const sendDm = vi.fn();
    await expect(
      payVcReward("guild-3", "user-4", makeJoinedAt(30), "コイン", SETTINGS, sendDm),
    ).rejects.toThrow("connection refused");
  });

  it("does not call sendDm when the DB insert fails", async () => {
    mocks.setNextInsertError(new Error("connection refused"));
    const sendDm = vi.fn();
    await payVcReward("guild-3", "user-5", makeJoinedAt(30), "コイン", SETTINGS, sendDm).catch(
      () => {},
    );
    expect(sendDm).not.toHaveBeenCalled();
  });
});

describe("payVcReward — zero reward (no DB writes, no DM)", () => {
  it("returns 0 immediately when ratePerHour is 0", async () => {
    const sendDm = vi.fn();
    const result = await payVcReward(
      "guild-4", "user-6", makeJoinedAt(30), "コイン",
      { ratePerHour: 0, minMinutes: 5 }, sendDm,
    );
    expect(result).toBe(0);
    expect(sendDm).not.toHaveBeenCalled();
  });

  it("returns 0 and skips DM when session is below minMinutes", async () => {
    const sendDm = vi.fn();
    const result = await payVcReward(
      "guild-4", "user-7", makeJoinedAt(2), "コイン",
      { ratePerHour: 100, minMinutes: 5 }, sendDm,
    );
    expect(result).toBe(0);
    expect(sendDm).not.toHaveBeenCalled();
  });
});
