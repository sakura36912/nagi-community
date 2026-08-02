/**
 * Tests for setLeaveLogChannel, setAuditLogChannel, and setTrackedVcCategoryId.
 *
 * All three write a single column into communityRankingSettingsTable using the
 * INSERT-with-placeholder / onConflictDoUpdate pattern.  The risk this suite
 * guards against is a regression where a brand-new guild row is created with
 * the target column left null (i.e. the placeholder values shadow the real
 * value on first use).
 *
 * Each describe block verifies:
 *   (a) First-use: the target column IS written correctly when no row exists yet.
 *   (b) The INSERT always uses onConflictDoUpdate (upsert, not error-on-conflict).
 *   (c) Placeholder values: channelId=null and period="all" are present in the
 *       INSERT .values() so the row can be created, but the onConflictDoUpdate
 *       set payload only touches the target column — not channelId or period.
 *   (d) Null is accepted (clears / disables the channel).
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock state ─────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  // ── db.select chain: db.select({…}).from(table).where(cond) → Promise<row[]>
  const selectWhere = vi.fn().mockResolvedValue([]);
  const selectFrom  = vi.fn(() => ({ where: selectWhere }));
  const select      = vi.fn(() => ({ from: selectFrom }));

  // ── db.insert chain: db.insert(table).values({…}).onConflictDoUpdate({…})
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const insertValues       = vi.fn(() => ({ onConflictDoUpdate }));
  const insert             = vi.fn(() => ({ values: insertValues }));

  return { select, selectFrom, selectWhere, insert, insertValues, onConflictDoUpdate };
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
      delete: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })) })) })),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    },
    communityVcSessionsTable:        tbl("sessions"),
    communityVcPrivacyTable:          tbl("privacy"),
    communityVcPrivacyGlobalTable:    tbl("global"),
    communityEventSettingsTable:      tbl("eventSettings"),
    communityEventsTable:             tbl("events"),
    communityEventParticipantsTable:  tbl("eventParticipants"),
    communityTicketSettingsTable:     tbl("ticketSettings"),
    communityTicketsTable:            tbl("tickets"),
    communityTicketPanelsTable:       tbl("ticketPanels"),
    communityRankingSettingsTable:    tbl("rankingSettings"),
    communityRoleButtonsTable:        tbl("roleButtons"),
  };
});

// ─── Mock drizzle-orm SQL operators ───────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  and:       (...args: unknown[]) => ({ op: "and", args }),
  eq:        (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  isNull:    (col: unknown) => ({ op: "isNull", col }),
  isNotNull: (col: unknown) => ({ op: "isNotNull", col }),
  lt:        (col: unknown, val: unknown) => ({ op: "lt", col, val }),
  lte:       (col: unknown, val: unknown) => ({ op: "lte", col, val }),
  gt:        (col: unknown, val: unknown) => ({ op: "gt", col, val }),
  gte:       (col: unknown, val: unknown) => ({ op: "gte", col, val }),
  or:        (...args: unknown[]) => ({ op: "or", args }),
  asc:       (col: unknown) => ({ op: "asc", col }),
  desc:      (col: unknown) => ({ op: "desc", col }),
  notInArray:(col: unknown, vals: unknown) => ({ op: "notInArray", col, vals }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: "sql", strings, values }),
    { raw: (v: unknown) => ({ op: "sql.raw", v }) },
  ),
}));

// ─── Import under test ────────────────────────────────────────────────────────
import {
  setLeaveLogChannel,
  setAuditLogChannel,
  setTrackedVcCategoryId,
  getLeaveLogChannel,
  getAuditLogChannel,
  getTrackedVcCategoryId,
} from "../lib/community.js";

// ─── Shared helper ────────────────────────────────────────────────────────────
function rewireInsertChain() {
  mocks.insertValues.mockReturnValue({ onConflictDoUpdate: mocks.onConflictDoUpdate });
  mocks.insert.mockReturnValue({ values: mocks.insertValues });
}

function rewireSelectChain() {
  mocks.selectFrom.mockReturnValue({ where: mocks.selectWhere });
  mocks.select.mockReturnValue({ from: mocks.selectFrom });
}

// ─── setLeaveLogChannel ───────────────────────────────────────────────────────

describe("setLeaveLogChannel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rewireInsertChain();
  });

  // (a) First-use: target column is written with the supplied channel id
  it("writes leaveLogChannelId into the insert values on first use (brand-new guild)", async () => {
    await setLeaveLogChannel("guild-new", "channel-leave-1");

    const [valuesArg] = mocks.insertValues.mock.calls[0] as unknown as [
      { guildId: string; leaveLogChannelId: string | null }
    ];
    expect(valuesArg.guildId).toBe("guild-new");
    expect(valuesArg.leaveLogChannelId).toBe("channel-leave-1");
  });

  // (b) Always calls onConflictDoUpdate (upsert path)
  it("calls onConflictDoUpdate so the insert upserts rather than errors on duplicate", async () => {
    await setLeaveLogChannel("guild-1", "channel-leave-2");
    expect(mocks.onConflictDoUpdate).toHaveBeenCalledTimes(1);
  });

  // (c) Placeholder safety: channelId=null and period="all" are in .values()
  //     but the conflict set payload does NOT touch them
  it("uses channelId=null and period='all' as safe placeholder values in insert", async () => {
    await setLeaveLogChannel("guild-1", "channel-leave-3");

    const [valuesArg] = mocks.insertValues.mock.calls[0] as unknown as [
      { channelId: string | null; period: string }
    ];
    expect(valuesArg.channelId).toBeNull();
    expect(valuesArg.period).toBe("all");
  });

  it("does not include channelId or period in the onConflictDoUpdate set payload", async () => {
    await setLeaveLogChannel("guild-1", "channel-leave-3");

    const [conflictArg] = mocks.onConflictDoUpdate.mock.calls[0] as unknown as [
      { set: Record<string, unknown> }
    ];
    expect(conflictArg.set).not.toHaveProperty("channelId");
    expect(conflictArg.set).not.toHaveProperty("period");
  });

  it("includes the new leaveLogChannelId in the onConflictDoUpdate set payload", async () => {
    await setLeaveLogChannel("guild-1", "channel-leave-4");

    const [conflictArg] = mocks.onConflictDoUpdate.mock.calls[0] as unknown as [
      { set: { leaveLogChannelId: string | null } }
    ];
    expect(conflictArg.set.leaveLogChannelId).toBe("channel-leave-4");
  });

  // (d) Null clears the channel
  it("stores null when called with null (disables leave-log)", async () => {
    await setLeaveLogChannel("guild-1", null);

    const [valuesArg] = mocks.insertValues.mock.calls[0] as unknown as [
      { leaveLogChannelId: string | null }
    ];
    expect(valuesArg.leaveLogChannelId).toBeNull();
  });

  // Round-trip: getter reads back what was written
  it("round-trip: getLeaveLogChannel returns the value written by setLeaveLogChannel", async () => {
    await setLeaveLogChannel("guild-rt", "channel-leave-rt");

    rewireSelectChain();
    mocks.selectWhere.mockResolvedValueOnce([{ leaveLogChannelId: "channel-leave-rt" }]);

    const result = await getLeaveLogChannel("guild-rt");
    expect(result).toBe("channel-leave-rt");
  });

  it("round-trip: getLeaveLogChannel returns null for a brand-new guild (no row yet)", async () => {
    rewireSelectChain();
    mocks.selectWhere.mockResolvedValueOnce([]);

    const result = await getLeaveLogChannel("guild-no-row");
    expect(result).toBeNull();
  });
});

// ─── setAuditLogChannel ───────────────────────────────────────────────────────

describe("setAuditLogChannel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rewireInsertChain();
  });

  // (a) First-use: target column is written
  it("writes auditLogChannelId into the insert values on first use (brand-new guild)", async () => {
    await setAuditLogChannel("guild-new", "channel-audit-1");

    const [valuesArg] = mocks.insertValues.mock.calls[0] as unknown as [
      { guildId: string; auditLogChannelId: string | null }
    ];
    expect(valuesArg.guildId).toBe("guild-new");
    expect(valuesArg.auditLogChannelId).toBe("channel-audit-1");
  });

  // (b) Always upserts
  it("calls onConflictDoUpdate so the insert upserts rather than errors on duplicate", async () => {
    await setAuditLogChannel("guild-1", "channel-audit-2");
    expect(mocks.onConflictDoUpdate).toHaveBeenCalledTimes(1);
  });

  // (c) Placeholder safety
  it("uses channelId=null and period='all' as safe placeholder values in insert", async () => {
    await setAuditLogChannel("guild-1", "channel-audit-3");

    const [valuesArg] = mocks.insertValues.mock.calls[0] as unknown as [
      { channelId: string | null; period: string }
    ];
    expect(valuesArg.channelId).toBeNull();
    expect(valuesArg.period).toBe("all");
  });

  it("does not include channelId or period in the onConflictDoUpdate set payload", async () => {
    await setAuditLogChannel("guild-1", "channel-audit-3");

    const [conflictArg] = mocks.onConflictDoUpdate.mock.calls[0] as unknown as [
      { set: Record<string, unknown> }
    ];
    expect(conflictArg.set).not.toHaveProperty("channelId");
    expect(conflictArg.set).not.toHaveProperty("period");
  });

  it("includes the new auditLogChannelId in the onConflictDoUpdate set payload", async () => {
    await setAuditLogChannel("guild-1", "channel-audit-4");

    const [conflictArg] = mocks.onConflictDoUpdate.mock.calls[0] as unknown as [
      { set: { auditLogChannelId: string | null } }
    ];
    expect(conflictArg.set.auditLogChannelId).toBe("channel-audit-4");
  });

  // (d) Null clears the channel
  it("stores null when called with null (disables audit-log)", async () => {
    await setAuditLogChannel("guild-1", null);

    const [valuesArg] = mocks.insertValues.mock.calls[0] as unknown as [
      { auditLogChannelId: string | null }
    ];
    expect(valuesArg.auditLogChannelId).toBeNull();
  });

  // Round-trip
  it("round-trip: getAuditLogChannel returns the value written by setAuditLogChannel", async () => {
    await setAuditLogChannel("guild-rt", "channel-audit-rt");

    rewireSelectChain();
    mocks.selectWhere.mockResolvedValueOnce([{ auditLogChannelId: "channel-audit-rt" }]);

    const result = await getAuditLogChannel("guild-rt");
    expect(result).toBe("channel-audit-rt");
  });

  it("round-trip: getAuditLogChannel returns null for a brand-new guild (no row yet)", async () => {
    rewireSelectChain();
    mocks.selectWhere.mockResolvedValueOnce([]);

    const result = await getAuditLogChannel("guild-no-row");
    expect(result).toBeNull();
  });
});

// ─── setTrackedVcCategoryId ───────────────────────────────────────────────────

describe("setTrackedVcCategoryId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rewireInsertChain();
  });

  // (a) First-use: target column is written
  it("writes trackedVcCategoryId into the insert values on first use (brand-new guild)", async () => {
    await setTrackedVcCategoryId("guild-new", "cat-1");

    const [valuesArg] = mocks.insertValues.mock.calls[0] as unknown as [
      { guildId: string; trackedVcCategoryId: string | null }
    ];
    expect(valuesArg.guildId).toBe("guild-new");
    expect(valuesArg.trackedVcCategoryId).toBe("cat-1");
  });

  // (b) Always upserts
  it("calls onConflictDoUpdate so the insert upserts rather than errors on duplicate", async () => {
    await setTrackedVcCategoryId("guild-1", "cat-2");
    expect(mocks.onConflictDoUpdate).toHaveBeenCalledTimes(1);
  });

  // (c) Placeholder safety
  it("uses channelId=null and period='all' as safe placeholder values in insert", async () => {
    await setTrackedVcCategoryId("guild-1", "cat-3");

    const [valuesArg] = mocks.insertValues.mock.calls[0] as unknown as [
      { channelId: string | null; period: string }
    ];
    expect(valuesArg.channelId).toBeNull();
    expect(valuesArg.period).toBe("all");
  });

  it("does not include channelId or period in the onConflictDoUpdate set payload", async () => {
    await setTrackedVcCategoryId("guild-1", "cat-3");

    const [conflictArg] = mocks.onConflictDoUpdate.mock.calls[0] as unknown as [
      { set: Record<string, unknown> }
    ];
    expect(conflictArg.set).not.toHaveProperty("channelId");
    expect(conflictArg.set).not.toHaveProperty("period");
  });

  it("includes the new trackedVcCategoryId in the onConflictDoUpdate set payload", async () => {
    await setTrackedVcCategoryId("guild-1", "cat-4");

    const [conflictArg] = mocks.onConflictDoUpdate.mock.calls[0] as unknown as [
      { set: { trackedVcCategoryId: string | null } }
    ];
    expect(conflictArg.set.trackedVcCategoryId).toBe("cat-4");
  });

  // (d) Null clears the category (disables category filtering)
  it("stores null when called with null (removes the VC category filter)", async () => {
    await setTrackedVcCategoryId("guild-1", null);

    const [valuesArg] = mocks.insertValues.mock.calls[0] as unknown as [
      { trackedVcCategoryId: string | null }
    ];
    expect(valuesArg.trackedVcCategoryId).toBeNull();
  });

  // Round-trip
  it("round-trip: getTrackedVcCategoryId returns the value written by setTrackedVcCategoryId", async () => {
    await setTrackedVcCategoryId("guild-rt", "cat-rt");

    rewireSelectChain();
    mocks.selectWhere.mockResolvedValueOnce([{ trackedVcCategoryId: "cat-rt" }]);

    const result = await getTrackedVcCategoryId("guild-rt");
    expect(result).toBe("cat-rt");
  });

  it("round-trip: getTrackedVcCategoryId returns null for a brand-new guild (no row yet)", async () => {
    rewireSelectChain();
    mocks.selectWhere.mockResolvedValueOnce([]);

    const result = await getTrackedVcCategoryId("guild-no-row");
    expect(result).toBeNull();
  });
});
