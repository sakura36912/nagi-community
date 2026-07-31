/**
 * Focused tests for the "opt-in when no row exists" round-trip.
 *
 * Scenario: a partial data migration (or admin wipe) removed the privacy row
 * entirely instead of setting optedOut=false. A subsequent opt-in call must:
 *   1. INSERT a fresh row with optedOut=false (via upsert)
 *   2. NOT close any session (setVcPrivacyOptOut returns false)
 *   3. NOT close any sessions (setVcGlobalPrivacyOptOut returns 0)
 *   4. Leave isVcTrackingOptedOut returning false immediately after
 *
 * This guards against the "user is permanently blocked" bug where an absent
 * row is misread as an opted-out row.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock state ─────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  // ── insert chain: db.insert(table).values({}).onConflictDoUpdate({}) ─────────
  const onConflictDoUpdate = vi.fn().mockResolvedValue([]);
  const insertValues = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values: insertValues }));

  // ── select chain: db.select().from(table).where(cond) → Promise<row[]> ───────
  const selectWhere = vi.fn().mockResolvedValue([]);
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  // ── update chain (used by closeSession / closeOpenSessionsForUser) ─────────
  const updateReturning = vi.fn().mockResolvedValue([]);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  return {
    onConflictDoUpdate,
    insertValues,
    insert,
    selectWhere,
    selectFrom,
    select,
    updateReturning,
    updateWhere,
    updateSet,
    update,
  };
});

// ─── Mock @workspace/db ───────────────────────────────────────────────────────
vi.mock("@workspace/db", () => {
  const tbl = (name: string) =>
    new Proxy({} as Record<string, string>, {
      get: (_t, p: string) => `${name}.${p}`,
    });

  return {
    db: {
      insert: mocks.insert,
      select: mocks.select,
      update: mocks.update,
    },
    communityVcPrivacyTable: tbl("privacy"),
    communityVcPrivacyGlobalTable: tbl("global"),
    communityVcSessionsTable: tbl("sessions"),
    communityEventSettingsTable: tbl("eventSettings"),
    communityEventsTable: tbl("events"),
    communityEventParticipantsTable: tbl("eventParticipants"),
    communityTicketSettingsTable: tbl("ticketSettings"),
    communityTicketsTable: tbl("tickets"),
    communityTicketPanelsTable: tbl("ticketPanels"),
    communityRankingSettingsTable: tbl("rankingSettings"),
    communityRoleButtonsTable: tbl("roleButtons"),
  };
});

// ─── Mock drizzle-orm operators ───────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ op: "and", args }),
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  isNull: (col: unknown) => ({ op: "isNull", col }),
  isNotNull: (col: unknown) => ({ op: "isNotNull", col }),
  gt: (col: unknown, val: unknown) => ({ op: "gt", col, val }),
  gte: (col: unknown, val: unknown) => ({ op: "gte", col, val }),
  lt: (col: unknown, val: unknown) => ({ op: "lt", col, val }),
  lte: (col: unknown, val: unknown) => ({ op: "lte", col, val }),
  or: (...args: unknown[]) => ({ op: "or", args }),
  asc: (col: unknown) => ({ op: "asc", col }),
  desc: (col: unknown) => ({ op: "desc", col }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: "sql", strings, values }),
    { raw: (v: unknown) => ({ op: "sql.raw", v }) },
  ),
}));

// ─── Import under test ────────────────────────────────────────────────────────
import {
  setVcPrivacyOptOut,
  setVcGlobalPrivacyOptOut,
  isVcTrackingOptedOut,
} from "../lib/community.js";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("setVcPrivacyOptOut — opt-in when row is absent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No open session to close
    mocks.selectWhere.mockResolvedValue([]);
  });

  it("performs an upsert (insert + onConflictDoUpdate) even when no row previously existed", async () => {
    await setVcPrivacyOptOut("guild-1", "user-1", false);

    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.insertValues).toHaveBeenCalledTimes(1);
    expect(mocks.onConflictDoUpdate).toHaveBeenCalledTimes(1);
  });

  it("inserts a row with optedOut=false when no prior row exists", async () => {
    await setVcPrivacyOptOut("guild-1", "user-1", false);

    const calls = mocks.insertValues.mock.calls as unknown as Array<[{ guildId: string; userId: string; optedOut: boolean }]>;
    const insertedValues = calls[0][0];
    expect(insertedValues.guildId).toBe("guild-1");
    expect(insertedValues.userId).toBe("user-1");
    expect(insertedValues.optedOut).toBe(false);
  });

  it("returns false (no session closed) when opting back in from an absent row", async () => {
    const result = await setVcPrivacyOptOut("guild-1", "user-1", false);
    expect(result).toBe(false);
  });

  it("does not attempt to close any session when optedOut is false", async () => {
    await setVcPrivacyOptOut("guild-1", "user-1", false);
    // closeSession uses db.select to find an open session — it should not be called
    // because optedOut=false skips that branch entirely.
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("upsert payload targets the correct conflict columns (guildId + userId)", async () => {
    await setVcPrivacyOptOut("guild-2", "user-2", false);

    const conflictArg = mocks.onConflictDoUpdate.mock.calls[0]?.[0] as {
      target: unknown[];
      set: { optedOut: boolean };
    };
    // The target array should reference both table columns
    expect(Array.isArray(conflictArg.target)).toBe(true);
    expect(conflictArg.target).toHaveLength(2);
    // The set payload must carry optedOut=false so an existing row is also corrected
    expect(conflictArg.set.optedOut).toBe(false);
  });
});

describe("setVcGlobalPrivacyOptOut — opt-in when row is absent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No open sessions to close
    mocks.selectWhere.mockResolvedValue([]);
  });

  it("performs an upsert (insert + onConflictDoUpdate) even when no row previously existed", async () => {
    await setVcGlobalPrivacyOptOut("user-global-1", false);

    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.insertValues).toHaveBeenCalledTimes(1);
    expect(mocks.onConflictDoUpdate).toHaveBeenCalledTimes(1);
  });

  it("inserts a row with optedOut=false when no prior global row exists", async () => {
    await setVcGlobalPrivacyOptOut("user-global-1", false);

    const calls = mocks.insertValues.mock.calls as unknown as Array<[{ userId: string; optedOut: boolean }]>;
    const insertedValues = calls[0][0];
    expect(insertedValues.userId).toBe("user-global-1");
    expect(insertedValues.optedOut).toBe(false);
  });

  it("returns 0 (no sessions closed) when opting back in from an absent row", async () => {
    const result = await setVcGlobalPrivacyOptOut("user-global-1", false);
    expect(result).toBe(0);
  });

  it("does not attempt to close any sessions when optedOut is false", async () => {
    await setVcGlobalPrivacyOptOut("user-global-1", false);
    // closeOpenSessionsForUser uses db.update — it should not be called
    // because optedOut=false skips that branch entirely.
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("upsert payload targets the correct conflict column (userId only)", async () => {
    await setVcGlobalPrivacyOptOut("user-global-2", false);

    const conflictArg = mocks.onConflictDoUpdate.mock.calls[0]?.[0] as {
      target: unknown;
      set: { optedOut: boolean };
    };
    // target is the userId column (single value, not an array)
    expect(conflictArg.target).toBe("global.userId");
    // The set payload must carry optedOut=false
    expect(conflictArg.set.optedOut).toBe(false);
  });
});

describe("isVcTrackingOptedOut — returns false immediately after opt-in upsert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns false after setVcPrivacyOptOut(optedOut=false) when the row was previously absent", async () => {
    // Step 1: opt in (row was absent → insert with optedOut=false)
    mocks.selectWhere.mockResolvedValue([]); // no open session during opt-in
    await setVcPrivacyOptOut("guild-3", "user-3", false);

    vi.clearAllMocks();

    // Step 2: isVcTrackingOptedOut consults global table (absent) then guild table
    // The newly inserted row has optedOut=false — simulate the DB returning it.
    mocks.selectWhere
      .mockResolvedValueOnce([]) // global table: absent
      .mockResolvedValueOnce([{ optedOut: false }]); // guild table: freshly inserted row

    const result = await isVcTrackingOptedOut("guild-3", "user-3");
    expect(result).toBe(false);
  });

  it("returns false after setVcGlobalPrivacyOptOut(optedOut=false) when the global row was previously absent", async () => {
    // Step 1: global opt-in (row was absent → insert with optedOut=false)
    mocks.selectWhere.mockResolvedValue([]); // no open sessions during opt-in
    await setVcGlobalPrivacyOptOut("user-global-3", false);

    vi.clearAllMocks();

    // Step 2: isVcTrackingOptedOut consults global table then guild table.
    // The newly inserted global row has optedOut=false.
    mocks.selectWhere
      .mockResolvedValueOnce([{ optedOut: false }]) // global table: freshly inserted row
      .mockResolvedValueOnce([]); // guild table: absent

    const result = await isVcTrackingOptedOut("guild-3", "user-global-3");
    expect(result).toBe(false);
  });

  it("returns false when both global and guild rows are absent (pre-upsert baseline)", async () => {
    // Absent rows must not be misread as opted-out
    mocks.selectWhere
      .mockResolvedValueOnce([]) // global: absent
      .mockResolvedValueOnce([]); // guild: absent

    const result = await isVcTrackingOptedOut("guild-4", "user-4");
    expect(result).toBe(false);
  });
});
