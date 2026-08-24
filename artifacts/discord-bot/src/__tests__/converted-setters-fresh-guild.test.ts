/**
 * Tests for the setters that were converted to use upsertGuildSetting:
 *   setVcCategoryId, setLeaveLogChannelId, setBanLogChannelId,
 *   setRewardInterval, setRewardDayOfMonth
 *
 * Each test exercises the setter against a fresh guild (no pre-existing row)
 * and confirms:
 *   1. The returned row contains the expected value.
 *   2. The value is persisted in the store (visible to a follow-up read).
 *   3. When a row already exists, calling a different setter does not
 *      accidentally reset the column set by the first call.
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
      onConflictDoNothing() {
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

  const db = {
    _store: store,
    insert(_table: unknown) {
      const insertedValues: Record<string, unknown> = {};
      return makeInsertChain(insertedValues);
    },
    select() {
      return {
        from(_table: unknown) {
          return this;
        },
        where(_condition: unknown) {
          return this;
        },
        then(
          resolve: (rows: Record<string, unknown>[]) => void,
          _reject: unknown,
        ) {
          resolve([]);
        },
      };
    },
  };

  return { db, store };
});

// ─── Mock @workspace/db ───────────────────────────────────────────────────────
vi.mock("@workspace/db", () => ({
  db: mocks.db,
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

// ─── Mock drizzle operators ───────────────────────────────────────────────────
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return { ...actual };
});

// ─── Imports (after mocks) ────────────────────────────────────────────────────
import {
  setVcCategoryId,
  setLeaveLogChannelId,
  setBanLogChannelId,
  setRewardInterval,
  setRewardDayOfMonth,
  isDueCalendarDay,
  getJstDateParts,
  getJstDateKey,
  getExcludedUserIds,
} from "../lib/economy.js";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("setVcCategoryId — fresh guild (no pre-existing row)", () => {
  beforeEach(() => {
    mocks.store.clear();
  });

  it("returns a row whose vcCategoryId equals the supplied value", async () => {
    const result = await setVcCategoryId("guild-vc-cat-1", "cat-channel-1");
    expect(result.vcCategoryId).toBe("cat-channel-1");
  });

  it("persists the value so the store reflects it after the call", async () => {
    await setVcCategoryId("guild-vc-cat-2", "cat-channel-2");
    expect(mocks.store.get("guild-vc-cat-2")?.vcCategoryId).toBe("cat-channel-2");
  });

  it("preserves the guildId on the returned row", async () => {
    const result = await setVcCategoryId("guild-vc-cat-3", "cat-channel-3");
    expect(result.guildId).toBe("guild-vc-cat-3");
  });

  it("accepts null (clears the category)", async () => {
    // Pre-seed a row with a value.
    mocks.store.set("guild-vc-cat-4", { guildId: "guild-vc-cat-4", vcCategoryId: "old-cat" });
    const result = await setVcCategoryId("guild-vc-cat-4", null);
    expect(result.vcCategoryId).toBeNull();
  });

  it("does not reset other columns when the row already exists", async () => {
    // Pre-seed a row that already has leaveLogChannelId set.
    mocks.store.set("guild-vc-cat-5", {
      guildId: "guild-vc-cat-5",
      leaveLogChannelId: "leave-ch-99",
      vcCategoryId: null,
    });
    const result = await setVcCategoryId("guild-vc-cat-5", "new-cat");
    expect(result.vcCategoryId).toBe("new-cat");
    // leaveLogChannelId must be untouched.
    expect(mocks.store.get("guild-vc-cat-5")?.leaveLogChannelId).toBe("leave-ch-99");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("setLeaveLogChannelId — fresh guild (no pre-existing row)", () => {
  beforeEach(() => {
    mocks.store.clear();
  });

  it("returns a row whose leaveLogChannelId equals the supplied value", async () => {
    const result = await setLeaveLogChannelId("guild-leave-1", "leave-ch-1");
    expect(result.leaveLogChannelId).toBe("leave-ch-1");
  });

  it("persists the value so the store reflects it after the call", async () => {
    await setLeaveLogChannelId("guild-leave-2", "leave-ch-2");
    expect(mocks.store.get("guild-leave-2")?.leaveLogChannelId).toBe("leave-ch-2");
  });

  it("preserves the guildId on the returned row", async () => {
    const result = await setLeaveLogChannelId("guild-leave-3", "leave-ch-3");
    expect(result.guildId).toBe("guild-leave-3");
  });

  it("accepts null (clears the channel)", async () => {
    mocks.store.set("guild-leave-4", { guildId: "guild-leave-4", leaveLogChannelId: "old-ch" });
    const result = await setLeaveLogChannelId("guild-leave-4", null);
    expect(result.leaveLogChannelId).toBeNull();
  });

  it("does not reset other columns when the row already exists", async () => {
    mocks.store.set("guild-leave-5", {
      guildId: "guild-leave-5",
      banLogChannelId: "ban-ch-77",
      leaveLogChannelId: null,
    });
    const result = await setLeaveLogChannelId("guild-leave-5", "new-leave-ch");
    expect(result.leaveLogChannelId).toBe("new-leave-ch");
    expect(mocks.store.get("guild-leave-5")?.banLogChannelId).toBe("ban-ch-77");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("setBanLogChannelId — fresh guild (no pre-existing row)", () => {
  beforeEach(() => {
    mocks.store.clear();
  });

  it("returns a row whose banLogChannelId equals the supplied value", async () => {
    const result = await setBanLogChannelId("guild-ban-1", "ban-ch-1");
    expect(result.banLogChannelId).toBe("ban-ch-1");
  });

  it("persists the value so the store reflects it after the call", async () => {
    await setBanLogChannelId("guild-ban-2", "ban-ch-2");
    expect(mocks.store.get("guild-ban-2")?.banLogChannelId).toBe("ban-ch-2");
  });

  it("preserves the guildId on the returned row", async () => {
    const result = await setBanLogChannelId("guild-ban-3", "ban-ch-3");
    expect(result.guildId).toBe("guild-ban-3");
  });

  it("accepts null (clears the channel)", async () => {
    mocks.store.set("guild-ban-4", { guildId: "guild-ban-4", banLogChannelId: "old-ban" });
    const result = await setBanLogChannelId("guild-ban-4", null);
    expect(result.banLogChannelId).toBeNull();
  });

  it("does not reset other columns when the row already exists", async () => {
    mocks.store.set("guild-ban-5", {
      guildId: "guild-ban-5",
      leaveLogChannelId: "leave-ch-55",
      banLogChannelId: null,
    });
    const result = await setBanLogChannelId("guild-ban-5", "new-ban-ch");
    expect(result.banLogChannelId).toBe("new-ban-ch");
    expect(mocks.store.get("guild-ban-5")?.leaveLogChannelId).toBe("leave-ch-55");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("setRewardInterval — fresh guild (no pre-existing row)", () => {
  beforeEach(() => {
    mocks.store.clear();
  });

  it("returns a row whose rewardIntervalMinutes equals the supplied value", async () => {
    const result = await setRewardInterval("guild-interval-1", 60);
    expect(result.rewardIntervalMinutes).toBe(60);
  });

  it("persists the value so the store reflects it after the call", async () => {
    await setRewardInterval("guild-interval-2", 120);
    expect(mocks.store.get("guild-interval-2")?.rewardIntervalMinutes).toBe(120);
  });

  it("preserves the guildId on the returned row", async () => {
    const result = await setRewardInterval("guild-interval-3", 30);
    expect(result.guildId).toBe("guild-interval-3");
  });

  it("clears rewardDayOfMonth when switching to interval mode", async () => {
    // Pre-seed a row that has calendar-day mode active.
    mocks.store.set("guild-interval-4", {
      guildId: "guild-interval-4",
      rewardDayOfMonth: 15,
      rewardIntervalMinutes: 43200,
    });
    const result = await setRewardInterval("guild-interval-4", 480);
    expect(result.rewardIntervalMinutes).toBe(480);
    // setRewardInterval passes rewardDayOfMonth: null in the patch.
    expect(result.rewardDayOfMonth).toBeNull();
  });

  it("does not reset other columns when the row already exists", async () => {
    mocks.store.set("guild-interval-5", {
      guildId: "guild-interval-5",
      vcCategoryId: "vc-cat-interval",
      rewardIntervalMinutes: 43200,
    });
    const result = await setRewardInterval("guild-interval-5", 240);
    expect(result.rewardIntervalMinutes).toBe(240);
    expect(mocks.store.get("guild-interval-5")?.vcCategoryId).toBe("vc-cat-interval");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("setRewardDayOfMonth — fresh guild (no pre-existing row)", () => {
  beforeEach(() => {
    mocks.store.clear();
  });

  it("returns a row whose rewardDayOfMonth equals the supplied value", async () => {
    const result = await setRewardDayOfMonth("guild-day-1", 15);
    expect(result.rewardDayOfMonth).toBe(15);
  });

  it("persists the value so the store reflects it after the call", async () => {
    await setRewardDayOfMonth("guild-day-2", 1);
    expect(mocks.store.get("guild-day-2")?.rewardDayOfMonth).toBe(1);
  });

  it("preserves the guildId on the returned row", async () => {
    const result = await setRewardDayOfMonth("guild-day-3", 28);
    expect(result.guildId).toBe("guild-day-3");
  });

  it("works with the maximum meaningful day value (31)", async () => {
    const result = await setRewardDayOfMonth("guild-day-4", 31);
    expect(result.rewardDayOfMonth).toBe(31);
  });

  it("does not reset other columns when the row already exists", async () => {
    mocks.store.set("guild-day-5", {
      guildId: "guild-day-5",
      banLogChannelId: "ban-ch-day5",
      rewardDayOfMonth: null,
    });
    const result = await setRewardDayOfMonth("guild-day-5", 10);
    expect(result.rewardDayOfMonth).toBe(10);
    expect(mocks.store.get("guild-day-5")?.banLogChannelId).toBe("ban-ch-day5");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("setRewardInterval / setRewardDayOfMonth — mutual exclusion", () => {
  beforeEach(() => {
    mocks.store.clear();
  });

  it("setRewardDayOfMonth then setRewardInterval: rewardDayOfMonth is null after the switch", async () => {
    // Start in calendar-day mode.
    await setRewardDayOfMonth("guild-mutex-1", 15);
    expect(mocks.store.get("guild-mutex-1")?.rewardDayOfMonth).toBe(15);

    // Switch to interval mode — must clear the calendar-day column.
    const result = await setRewardInterval("guild-mutex-1", 480);
    expect(result.rewardIntervalMinutes).toBe(480);
    expect(result.rewardDayOfMonth).toBeNull();
    expect(mocks.store.get("guild-mutex-1")?.rewardDayOfMonth).toBeNull();
  });

  it("setRewardInterval then setRewardDayOfMonth: isDueCalendarDay returns true (calendar mode supersedes interval)", async () => {
    // Start in interval mode.
    await setRewardInterval("guild-mutex-2", 10080);

    // Switch to calendar-day mode — rewardDayOfMonth now takes priority.
    const today = new Date();
    const todayDay = getJstDateParts(today).day;
    const result = await setRewardDayOfMonth("guild-mutex-2", todayDay);
    expect(result.rewardDayOfMonth).toBe(todayDay);

    // isDueCalendarDay must recognise calendar mode is active and today matches.
    // No lastRewardAt set → first payout of the month → should be due.
    const settings = { ...result, lastRewardAt: null } as Parameters<typeof isDueCalendarDay>[0];
    expect(isDueCalendarDay(settings, today)).toBe(true);
  });

  it("after switching to interval mode isDueCalendarDay returns false regardless of the day", async () => {
    // Seed a row that was in calendar-day mode.
    await setRewardDayOfMonth("guild-mutex-3", 1);

    // Switch to interval mode.
    const result = await setRewardInterval("guild-mutex-3", 60);

    // rewardDayOfMonth must be cleared, so isDueCalendarDay must return false.
    const settings = { ...result, lastRewardAt: null } as Parameters<typeof isDueCalendarDay>[0];
    // Force "today" to day 1 — even if it matches, the cleared column must win.
    const firstOfMonth = new Date();
    firstOfMonth.setDate(1);
    expect(isDueCalendarDay(settings, firstOfMonth)).toBe(false);
  });

  it("setRewardInterval then setRewardDayOfMonth: interval is superseded at the application level — isDueCalendarDay governs payouts", async () => {
    // Start in interval mode.
    await setRewardInterval("guild-mutex-4", 1440);
    expect(mocks.store.get("guild-mutex-4")?.rewardIntervalMinutes).toBe(1440);

    // Switch to calendar-day mode.
    // rewardIntervalMinutes is NOT NULL in the schema, so it cannot be cleared here;
    // mutual exclusion is enforced at the application level by isDueCalendarDay.
    const result = await setRewardDayOfMonth("guild-mutex-4", 20);
    expect(result.rewardDayOfMonth).toBe(20);

    // Calendar mode is now authoritative: when rewardDayOfMonth is set,
    // isDueCalendarDay returns true on the matching day and the scheduler must
    // consult it *before* any interval-mode logic.
    const today = new Date();
    const todayDay = getJstDateParts(today).day;
    const settingsOnPayDay = { ...result, rewardDayOfMonth: todayDay, lastRewardAt: null } as Parameters<typeof isDueCalendarDay>[0];
    expect(isDueCalendarDay(settingsOnPayDay, today)).toBe(true);

    // Conversely, a row with rewardDayOfMonth null falls through to interval mode.
    const settingsIntervalOnly = { ...result, rewardDayOfMonth: null, lastRewardAt: null } as Parameters<typeof isDueCalendarDay>[0];
    expect(isDueCalendarDay(settingsIntervalOnly, today)).toBe(false);
  });
});

describe("calendar-day rewards use Japan Standard Time", () => {
  it("becomes due at 00:00 JST, not 00:00 UTC", () => {
    const settings = {
      rewardDayOfMonth: 25,
      lastRewardAt: null,
    } as Parameters<typeof isDueCalendarDay>[0];

    expect(isDueCalendarDay(settings, new Date("2026-08-24T14:59:59.000Z"))).toBe(false);
    expect(isDueCalendarDay(settings, new Date("2026-08-24T15:00:00.000Z"))).toBe(true);
    expect(getJstDateKey(new Date("2026-08-24T15:00:00.000Z"))).toBe("2026-08-25");
  });

  it("uses the Japan month when preventing duplicate monthly payouts", () => {
    const settings = {
      rewardDayOfMonth: 1,
      lastRewardAt: new Date("2026-08-31T15:00:00.000Z"),
    } as Parameters<typeof isDueCalendarDay>[0];

    // lastRewardAt is 2026-09-01 00:00 JST, so this is already paid in
    // the same Japan calendar month even though the UTC dates differ.
    expect(isDueCalendarDay(settings, new Date("2026-09-01T00:00:00.000Z"))).toBe(false);
  });
});

describe("sub垢 members are excluded from role rewards", () => {
  it("collects users who have any excluded role", () => {
    const members = new Map([
      ["member-with-sub", ["staff", "sub-role"]],
      ["member-without-sub", ["staff"]],
      ["member-with-other", ["other"]],
    ]);

    expect(getExcludedUserIds(members, new Set(["sub-role"]))).toEqual(
      new Set(["member-with-sub"]),
    );
  });

  it("does not exclude anyone when no matching role exists", () => {
    const members = new Map([
      ["member-a", ["staff"]],
      ["member-b", ["other"]],
    ]);

    expect(getExcludedUserIds(members, new Set())).toEqual(new Set());
  });
});
