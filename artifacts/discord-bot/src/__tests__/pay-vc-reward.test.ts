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
 *   3. A DB error during the transaction insert propagates normally.
 *   4. Rate = 0 → returns 0 immediately without touching the DB or sending a DM.
 *   5. Session below minMinutes → returns 0 without touching the DB or sending a DM.
 *   6. Calling payVcReward twice with the same (guildId, userId, joinedAt) does
 *      NOT produce a duplicate wallet credit or a duplicate transaction row —
 *      the second call returns 0 immediately.
 *   7. A wallet-upsert failure inside the DB transaction rolls back the ledger
 *      row so that a subsequent retry for the same session can succeed.
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
  /** Error injected into the NEXT transaction-table insert (fires once). */
  let nextTxInsertError: Error | null = null;
  /** Error injected into the NEXT wallet-table insert inside a transaction (fires once). */
  let nextWalletError: Error | null = null;

  /**
   * Session keys that have already been committed to the DB.
   * Simulates the unique constraint on transactions.session_key:
   *   - A key is added when a transaction insert succeeds.
   *   - A key is removed when the surrounding DB transaction is rolled back.
   */
  const seenSessionKeys = new Set<string>();

  /** How many times the wallet upsert completed successfully. */
  let walletCreditCalls = 0;

  // ── Insert chain factories ──────────────────────────────────────────────────

  /**
   * Chain for transaction-table inserts:
   *   insert(txTable).values({…sessionKey}).onConflictDoNothing().returning()
   *
   * Returns [] when the key already exists (conflict = already paid),
   * or [{id:1}] when the insert succeeds.
   */
  function makeTxInsertChain(key: string | null, isConflict: boolean) {
    return {
      onConflictDoNothing() {
        return {
          returning(): Promise<unknown[]> {
            if (nextTxInsertError) {
              const err = nextTxInsertError;
              nextTxInsertError = null;
              return Promise.reject(err);
            }
            return Promise.resolve(isConflict ? [] : [{ id: 1 }]);
          },
        };
      },
    };
  }

  /**
   * Chain for wallet-table inserts:
   *   insert(walletTable).values({…balance}).onConflictDoUpdate({…})
   */
  function makeWalletInsertChain() {
    return {
      onConflictDoUpdate(_opts: unknown): Promise<unknown> {
        if (nextWalletError) {
          const err = nextWalletError;
          nextWalletError = null;
          return Promise.reject(err);
        }
        walletCreditCalls++;
        return Promise.resolve([]);
      },
    };
  }

  /**
   * Route insert calls to the correct chain based on the values object.
   * Transaction inserts carry a `sessionKey` field; wallet inserts carry `balance`.
   */
  function makeInsert(_table: unknown) {
    return {
      values(v: Record<string, unknown>) {
        if ("sessionKey" in v) {
          const key = typeof v.sessionKey === "string" ? v.sessionKey : null;
          const isConflict = key !== null && seenSessionKeys.has(key);
          // Tentatively mark the key as "in flight"; the transaction wrapper
          // will remove it again if a rollback occurs.
          if (key !== null && !isConflict) seenSessionKeys.add(key);
          return makeTxInsertChain(key, isConflict);
        }
        return makeWalletInsertChain();
      },
    };
  }

  // ── db.transaction simulation ───────────────────────────────────────────────
  /**
   * Simulate a DB transaction:
   *   - Run the callback with a `tx` proxy that shares state with `db`.
   *   - On success, committed changes persist.
   *   - On failure, roll back: restore seenSessionKeys and walletCreditCalls to
   *     their pre-transaction snapshot so a retry can proceed cleanly.
   */
  async function transaction<T>(
    fn: (tx: { insert: typeof makeInsert }) => Promise<T>,
  ): Promise<T> {
    // Snapshot state before the transaction begins.
    const keySnapshot = new Set(seenSessionKeys);
    const walletSnapshot = walletCreditCalls;

    try {
      return await fn({ insert: makeInsert });
    } catch (err) {
      // Rollback: restore the pre-transaction state.
      seenSessionKeys.clear();
      for (const k of keySnapshot) seenSessionKeys.add(k);
      walletCreditCalls = walletSnapshot;
      throw err;
    }
  }

  const db = { insert: makeInsert, transaction };

  return {
    db,
    /** Inject an error that fires on the next transaction-table insert. */
    setNextTxInsertError(err: Error) { nextTxInsertError = err; },
    /** Inject an error that fires on the next wallet insert (tests rollback recovery). */
    setNextWalletError(err: Error) { nextWalletError = err; },
    /** @deprecated kept for test backward-compat; same as setNextTxInsertError */
    setNextInsertError(err: Error) { nextTxInsertError = err; },
    getWalletCreditCalls() { return walletCreditCalls; },
    resetState() {
      seenSessionKeys.clear();
      walletCreditCalls = 0;
      nextTxInsertError = null;
      nextWalletError = null;
    },
  };
});

// ─── Mock @workspace/db ───────────────────────────────────────────────────────
vi.mock("@workspace/db", () => ({
  db: mocks.db,
  walletsTable:      { guildId: {}, userId: {}, balance: {} },
  transactionsTable: { guildId: {}, userId: {}, amount: {}, reason: {}, sessionKey: {} },
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

beforeEach(() => {
  mocks.resetState();
});

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

describe("payVcReward — idempotency guard (duplicate leave event)", () => {
  it("returns 0 on a second call with the same (guildId, userId, joinedAt)", async () => {
    const joinedAt = makeJoinedAt(30);
    const sendDm = vi.fn().mockResolvedValue(undefined);

    const first = await payVcReward("guild-5", "user-8", joinedAt, "コイン", SETTINGS, sendDm);
    expect(first).toBeGreaterThan(0);

    const second = await payVcReward("guild-5", "user-8", joinedAt, "コイン", SETTINGS, sendDm);
    expect(second).toBe(0);
  });

  it("does not credit the wallet a second time on a duplicate call", async () => {
    const joinedAt = makeJoinedAt(30);
    const sendDm = vi.fn().mockResolvedValue(undefined);

    await payVcReward("guild-5", "user-9", joinedAt, "コイン", SETTINGS, sendDm);
    const afterFirst = mocks.getWalletCreditCalls();

    await payVcReward("guild-5", "user-9", joinedAt, "コイン", SETTINGS, sendDm);
    const afterSecond = mocks.getWalletCreditCalls();

    // Wallet must have been credited exactly once across both calls.
    expect(afterFirst).toBe(1);
    expect(afterSecond).toBe(1);
  });

  it("does not send a DM on the duplicate call", async () => {
    const joinedAt = makeJoinedAt(30);
    const sendDm = vi.fn().mockResolvedValue(undefined);

    await payVcReward("guild-5", "user-10", joinedAt, "コイン", SETTINGS, sendDm);
    expect(sendDm).toHaveBeenCalledTimes(1);

    await payVcReward("guild-5", "user-10", joinedAt, "コイン", SETTINGS, sendDm);
    // Still exactly once — the duplicate call exits before reaching the DM step.
    expect(sendDm).toHaveBeenCalledTimes(1);
  });

  it("treats a different joinedAt as a distinct session (both calls pay)", async () => {
    const sendDm = vi.fn().mockResolvedValue(undefined);
    const joinedAt1 = new Date(Date.now() - 30 * 60_000);
    const joinedAt2 = new Date(Date.now() - 60 * 60_000); // different timestamp

    const first  = await payVcReward("guild-5", "user-11", joinedAt1, "コイン", SETTINGS, sendDm);
    const second = await payVcReward("guild-5", "user-11", joinedAt2, "コイン", SETTINGS, sendDm);

    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(0);
    expect(mocks.getWalletCreditCalls()).toBe(2);
  });
});

describe("payVcReward — DB transaction rollback on wallet failure", () => {
  it("rolls back the session key so a retry for the same session can succeed", async () => {
    const joinedAt = makeJoinedAt(30);
    const sendDm = vi.fn().mockResolvedValue(undefined);

    // First call: wallet upsert fails → the whole DB transaction rolls back.
    // The session key must NOT be permanently consumed.
    mocks.setNextWalletError(new Error("wallet DB error"));
    await expect(
      payVcReward("guild-6", "user-12", joinedAt, "コイン", SETTINGS, sendDm),
    ).rejects.toThrow("wallet DB error");

    // Retry with the same session: should succeed because the key was rolled back.
    const retryReward = await payVcReward(
      "guild-6", "user-12", joinedAt, "コイン", SETTINGS, sendDm,
    );
    expect(retryReward).toBeGreaterThan(0);
    expect(mocks.getWalletCreditCalls()).toBe(1);
    expect(sendDm).toHaveBeenCalledTimes(1);
  });

  it("does not send a DM when the wallet insert fails", async () => {
    const joinedAt = makeJoinedAt(30);
    const sendDm = vi.fn().mockResolvedValue(undefined);

    mocks.setNextWalletError(new Error("wallet DB error"));
    await payVcReward("guild-6", "user-13", joinedAt, "コイン", SETTINGS, sendDm).catch(() => {});

    expect(sendDm).not.toHaveBeenCalled();
  });
});
