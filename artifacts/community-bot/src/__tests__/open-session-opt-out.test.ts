/**
 * Tests that openSession honours opt-out flags and returns null (making no
 * DB insert) when a user has opted out of VC tracking.
 *
 * Covers:
 *   - globally opted-out user  → openSession returns null, no insert
 *   - per-guild opted-out user → openSession returns null for that guild only
 *   - non-opted-out user       → openSession proceeds and inserts a row
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock state ─────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  // ── select chain: db.select().from(table).where(cond) → Promise<row[]> ─────
  // Each call to selectWhere represents one .where() invocation. Tests that
  // exercise isVcTrackingOptedOut will get two consecutive calls (global +
  // guild), so we use mockResolvedValueOnce to control each independently.
  const selectWhere = vi.fn().mockResolvedValue([]);
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  // ── insert chain: db.insert(table).values({}).returning() ─────────────────
  const insertReturning = vi.fn().mockResolvedValue([]);
  const insertValues = vi.fn(() => ({ returning: insertReturning }));
  const insert = vi.fn(() => ({ values: insertValues }));

  return { select, selectFrom, selectWhere, insert, insertValues, insertReturning };
});

// ─── Mock @workspace/db ───────────────────────────────────────────────────────
vi.mock("@workspace/db", () => {
  const tbl = (name: string) =>
    new Proxy({} as Record<string, string>, {
      get: (_t, p: string) => `${name}.${p}`,
    });

  return {
    db: {
      select: mocks.select,
      insert: mocks.insert,
    },
    communityVcSessionsTable: tbl("sessions"),
    communityVcPrivacyGlobalTable: tbl("global"),
    communityVcPrivacyTable: tbl("privacy"),
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
  gt: (col: unknown, val: unknown) => ({ op: "gt", col, val }),
  lt: (col: unknown, val: unknown) => ({ op: "lt", col, val }),
  or: (...args: unknown[]) => ({ op: "or", args }),
  asc: (col: unknown) => ({ op: "asc", col }),
  desc: (col: unknown) => ({ op: "desc", col }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({
      op: "sql",
      strings,
      values,
    }),
    { raw: (v: unknown) => ({ op: "sql.raw", v }) },
  ),
}));

// ─── Import under test (resolved after mocks) ────────────────────────────────
import { openSession } from "../lib/community.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Set up the two select().where() calls that isVcTrackingOptedOut makes in
 * parallel: first resolves for the global table, second for the guild table.
 */
function mockOptOut(globalOptedOut: boolean, guildOptedOut: boolean) {
  // isVcTrackingOptedOut runs Promise.all([globalQuery, guildQuery]).
  // Both queries share the same selectWhere mock — they are resolved in the
  // order the mock was queued.
  mocks.selectWhere
    .mockResolvedValueOnce(globalOptedOut ? [{ optedOut: true }] : [])
    .mockResolvedValueOnce(guildOptedOut ? [{ optedOut: true }] : []);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("openSession – opt-out guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Global opt-out ─────────────────────────────────────────────────────────

  it("returns null when the user has the global opt-out flag set", async () => {
    mockOptOut(true, false);

    const result = await openSession("guild-1", "user-global-out", "channel-1");

    expect(result).toBeNull();
  });

  it("makes NO DB insert when the global opt-out flag is set", async () => {
    mockOptOut(true, false);

    await openSession("guild-1", "user-global-no-insert", "channel-1");

    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("returns null even when only the global flag is set (guild flag absent)", async () => {
    // global = opted out, guild row = not present at all
    mockOptOut(true, false);

    const result = await openSession("guild-2", "user-global-only", "channel-2");

    expect(result).toBeNull();
  });

  // ── Per-guild opt-out ──────────────────────────────────────────────────────

  it("returns null when the user has a per-guild opt-out for that guild", async () => {
    // global = not opted out, guild = opted out
    mockOptOut(false, true);

    const result = await openSession("guild-3", "user-guild-out", "channel-3");

    expect(result).toBeNull();
  });

  it("makes NO DB insert when the per-guild opt-out flag is set", async () => {
    mockOptOut(false, true);

    await openSession("guild-3", "user-guild-no-insert", "channel-3");

    expect(mocks.insert).not.toHaveBeenCalled();
  });

  // ── Not opted out – baseline ───────────────────────────────────────────────

  it("proceeds to insert a session row when the user has not opted out", async () => {
    // Neither global nor guild opt-out set
    mockOptOut(false, false);

    const fakeSession = { id: 99, guildId: "guild-4", userId: "user-ok", channelId: "ch-4", joinedAt: new Date(), leftAt: null };
    mocks.insertReturning.mockResolvedValueOnce([fakeSession]);

    const result = await openSession("guild-4", "user-ok", "ch-4");

    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ id: 99 });
  });

  // ── isVcTrackingOptedOut query structure ───────────────────────────────────

  it("queries the global privacy table with the correct userId", async () => {
    mockOptOut(false, false);
    mocks.insertReturning.mockResolvedValueOnce([
      { id: 1, guildId: "g", userId: "u", channelId: "c", joinedAt: new Date(), leftAt: null },
    ]);

    await openSession("guild-5", "user-query-check", "channel-5");

    // select() must have been called (at least twice: global + guild)
    expect(mocks.select).toHaveBeenCalled();
    // The first where() call should carry an eq referencing "global.userId"
    const firstWhereArg = mocks.selectWhere.mock.calls[0]?.[0] as {
      op: string;
      col: string;
      val: string;
    };
    expect(firstWhereArg.op).toBe("eq");
    expect(firstWhereArg.col).toBe("global.userId");
    expect(firstWhereArg.val).toBe("user-query-check");
  });

  it("queries the per-guild privacy table with guildId AND userId", async () => {
    mockOptOut(false, false);
    mocks.insertReturning.mockResolvedValueOnce([
      { id: 2, guildId: "g", userId: "u", channelId: "c", joinedAt: new Date(), leftAt: null },
    ]);

    await openSession("guild-6", "user-guild-query", "channel-6");

    // Second where() call is the guild-level query (AND of guildId + userId)
    const secondWhereArg = mocks.selectWhere.mock.calls[1]?.[0] as {
      op: string;
      args: { op: string; col: string; val: string }[];
    };
    expect(secondWhereArg.op).toBe("and");
    const eqArgs = secondWhereArg.args.filter((a) => a.op === "eq");
    expect(eqArgs.length).toBeGreaterThanOrEqual(2);
    const cols = eqArgs.map((a) => a.col);
    expect(cols).toContain("privacy.guildId");
    expect(cols).toContain("privacy.userId");
  });
});
