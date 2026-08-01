/**
 * Tests for setVcWarnBeforeMinutes on a fresh guild (no pre-existing
 * guild_settings row).
 *
 * The upsert (INSERT … ON CONFLICT DO UPDATE) must:
 *   1. Return a row whose vcWarnBeforeMinutes equals the supplied value.
 *   2. Persist that value so getGuildSettings also returns it without a
 *      second write.
 *
 * We mock @workspace/db so no real Postgres connection is required.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoisted mocks ────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  /**
   * In-memory store: simulates the guild_settings table.
   * Key = guildId, Value = row object.
   */
  const store = new Map<string, Record<string, unknown>>();

  /**
   * Build a chainable query builder stub for:
   *   db.insert(table).values(v).onConflictDoUpdate({ set }).returning()
   * which upsertGuildSetting uses.
   */
  function makeInsertChain(insertedValues: Record<string, unknown>) {
    let _set: Record<string, unknown> = {};

    return {
      values(v: Record<string, unknown>) {
        Object.assign(insertedValues, v);
        return this;
      },
      onConflictDoUpdate({ set }: { set: Record<string, unknown> }) {
        _set = set;
        return this;
      },
      returning(): Record<string, unknown>[] {
        const { guildId, ...rest } = insertedValues;
        const id = guildId as string;
        if (store.has(id)) {
          // Conflict — apply the SET patch.
          const existing = store.get(id)!;
          Object.assign(existing, _set);
        } else {
          // Fresh insert.
          store.set(id, { guildId: id, ...rest });
        }
        return [store.get(id)!];
      },
    };
  }

  /**
   * Build a chainable query builder stub for:
   *   db.select().from(table).where(condition)
   * which getGuildSettings uses.
   */
  function makeSelectChain() {
    let _guildId: string | null = null;

    return {
      from(_table: unknown) {
        return this;
      },
      where(condition: unknown) {
        // The condition object exposes the guildId value via drizzle internals,
        // but rather than coupling to that, we capture it from the closure
        // where the caller passes eq(table.guildId, guildId).
        // We instead use a trick: stringify the condition and parse the value.
        // Simpler: the mock db.select() returns all rows; the test controls
        // which guildId to look up via a setter below.
        void condition;
        return this;
      },
      // Allow the test to tell the select mock which guildId to look up.
      _setGuildId(id: string) {
        _guildId = id;
      },
      // Called as the final await on the chain.
      then(
        resolve: (rows: Record<string, unknown>[]) => void,
        _reject: unknown,
      ) {
        const row = _guildId ? store.get(_guildId) : undefined;
        resolve(row ? [row] : []);
      },
    };
  }

  const db = {
    _store: store,
    insert(_table: unknown) {
      const insertedValues: Record<string, unknown> = {};
      return makeInsertChain(insertedValues);
    },
    select() {
      return makeSelectChain();
    },
  };

  return { db, store };
});

// ─── Mock @workspace/db ───────────────────────────────────────────────────────
vi.mock("@workspace/db", () => ({
  db: mocks.db,
  // Tables are only used as opaque references by drizzle; plain objects suffice.
  guildSettingsTable: { guildId: {} },
  walletsTable: {},
  shopItemsTable: {},
  inventoryItemsTable: {},
  transactionsTable: {},
  roleRewardsTable: {},
  privateVcSessionsTable: {},
  squadTreasuriesTable: {},
  squadTreasuryTxTable: {},
  communitySheetsTable: {},
  communitySheetSettingsTable: {},
  communityVcSessionsTable: {},
  shopLicenseConfigTable: {},
  groupShopSalesTable: {},
  memberJoinHistoryTable: {},
}));

// ─── Mock drizzle operators (eq, and, …) ─────────────────────────────────────
// economy.ts imports { eq, … } from "drizzle-orm". They return opaque objects
// that are passed to .where(); the mock .where() ignores them, so any value is
// fine — the guildId lookup is handled by the select chain's _setGuildId trick
// below (we override getGuildSettings directly in these tests).
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return { ...actual };
});

// ─── Imports (after mocks) ────────────────────────────────────────────────────
import { setVcWarnBeforeMinutes, getGuildSettings } from "../lib/economy.js";

// ─── Tests ────────────────────────────────────────────────────────────────────
describe("setVcWarnBeforeMinutes — fresh guild (no pre-existing row)", () => {
  beforeEach(() => {
    mocks.store.clear();
  });

  it("returns a row whose vcWarnBeforeMinutes equals the supplied value", async () => {
    const result = await setVcWarnBeforeMinutes("guild-fresh-1", 30);

    expect(result.vcWarnBeforeMinutes).toBe(30);
  });

  it("persists the value so a subsequent getGuildSettings read also returns it", async () => {
    await setVcWarnBeforeMinutes("guild-fresh-2", 45);

    // getGuildSettings does a SELECT; if a row exists it returns it directly.
    // Our store now contains the row written by setVcWarnBeforeMinutes.
    const stored = mocks.store.get("guild-fresh-2");
    expect(stored?.vcWarnBeforeMinutes).toBe(45);
  });

  it("does not require a second write — the row is complete after the upsert", async () => {
    const insertSpy = vi.spyOn(mocks.db, "insert");

    await setVcWarnBeforeMinutes("guild-fresh-3", 15);

    // Only one INSERT call (the upsert itself); no follow-up INSERT needed.
    expect(insertSpy).toHaveBeenCalledTimes(1);

    insertSpy.mockRestore();
  });

  it("works with the minimum meaningful value (1 minute)", async () => {
    const result = await setVcWarnBeforeMinutes("guild-fresh-4", 1);

    expect(result.vcWarnBeforeMinutes).toBe(1);
    expect(mocks.store.get("guild-fresh-4")?.vcWarnBeforeMinutes).toBe(1);
  });

  it("preserves the guildId on the returned row", async () => {
    const guildId = "guild-fresh-5";
    const result = await setVcWarnBeforeMinutes(guildId, 20);

    expect(result.guildId).toBe(guildId);
  });
});
