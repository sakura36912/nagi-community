/**
 * Tests for getVcSessionRetentionDays and setVcSessionRetentionDays.
 *
 * Verifies:
 *   (a) getVcSessionRetentionDays returns the stored value after
 *       setVcSessionRetentionDays saves a custom number (not the 180-day default).
 *   (b) getVcSessionRetentionDays falls back to 180 when no row exists for the guild.
 *   (c) setVcSessionRetentionDays upserts via db.insert … onConflictDoUpdate.
 *   (d) Passing null to setVcSessionRetentionDays stores null (revert to default).
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock state ─────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  // ── db.select chain: db.select({...}).from(table).where(cond) → Promise<row[]>
  const selectWhere = vi.fn().mockResolvedValue([]);
  const selectFrom  = vi.fn(() => ({ where: selectWhere }));
  const select      = vi.fn(() => ({ from: selectFrom }));

  // ── db.insert chain: db.insert(table).values({...}).onConflictDoUpdate({...})
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
      // Stub out other methods used by community.ts at module load time
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

// ─── Import under test (resolved after mocks) ─────────────────────────────────
import {
  getVcSessionRetentionDays,
  setVcSessionRetentionDays,
} from "../lib/community.js";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("getVcSessionRetentionDays", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-wire the select chain after clearAllMocks resets return values
    mocks.selectFrom.mockReturnValue({ where: mocks.selectWhere });
    mocks.select.mockReturnValue({ from: mocks.selectFrom });
  });

  // (b) No row → default 180
  it("returns 180 when no ranking-settings row exists for the guild", async () => {
    mocks.selectWhere.mockResolvedValueOnce([]); // no row
    const days = await getVcSessionRetentionDays("guild-new");
    expect(days).toBe(180);
  });

  it("returns 180 when the row exists but vcSessionRetentionDays is null", async () => {
    mocks.selectWhere.mockResolvedValueOnce([{ vcSessionRetentionDays: null }]);
    const days = await getVcSessionRetentionDays("guild-1");
    expect(days).toBe(180);
  });

  // (a) Custom value is returned as-is
  it("returns the stored value (not 180) when a custom retention has been saved", async () => {
    mocks.selectWhere.mockResolvedValueOnce([{ vcSessionRetentionDays: 90 }]);
    const days = await getVcSessionRetentionDays("guild-1");
    expect(days).toBe(90);
  });

  it("returns the correct value for a retention window longer than the default", async () => {
    mocks.selectWhere.mockResolvedValueOnce([{ vcSessionRetentionDays: 365 }]);
    const days = await getVcSessionRetentionDays("guild-1");
    expect(days).toBe(365);
  });

  it("returns 1 when the admin has set an aggressive 1-day retention", async () => {
    mocks.selectWhere.mockResolvedValueOnce([{ vcSessionRetentionDays: 1 }]);
    const days = await getVcSessionRetentionDays("guild-1");
    expect(days).toBe(1);
  });

  it("queries the rankingSettings table with the supplied guildId", async () => {
    mocks.selectWhere.mockResolvedValueOnce([]);
    await getVcSessionRetentionDays("guild-xyz");

    // The from() call receives the rankingSettings table proxy
    const [tableArg] = mocks.selectFrom.mock.calls[0] as unknown as [Record<string, string>];
    expect(tableArg["guildId"]).toBe("rankingSettings.guildId");

    // The where() call includes an eq predicate targeting guild-xyz
    const [whereArg] = mocks.selectWhere.mock.calls[0] as unknown as [
      { op: string; col: string; val: string }
    ];
    expect(whereArg.op).toBe("eq");
    expect(whereArg.val).toBe("guild-xyz");
  });
});

describe("setVcSessionRetentionDays", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-wire insert chain
    mocks.insertValues.mockReturnValue({ onConflictDoUpdate: mocks.onConflictDoUpdate });
    mocks.insert.mockReturnValue({ values: mocks.insertValues });
  });

  it("calls db.insert on the rankingSettings table", async () => {
    await setVcSessionRetentionDays("guild-1", 90);

    const [tableArg] = mocks.insert.mock.calls[0] as unknown as [Record<string, string>];
    expect(tableArg["guildId"]).toBe("rankingSettings.guildId");
  });

  it("includes the guildId and the custom days value in the insert values", async () => {
    await setVcSessionRetentionDays("guild-1", 90);

    const [valuesArg] = mocks.insertValues.mock.calls[0] as unknown as [
      { guildId: string; vcSessionRetentionDays: number | null }
    ];
    expect(valuesArg.guildId).toBe("guild-1");
    expect(valuesArg.vcSessionRetentionDays).toBe(90);
  });

  it("calls onConflictDoUpdate so it upserts rather than errors on duplicate", async () => {
    await setVcSessionRetentionDays("guild-1", 90);
    expect(mocks.onConflictDoUpdate).toHaveBeenCalledTimes(1);
  });

  it("stores null when passed null (signals revert to system default)", async () => {
    await setVcSessionRetentionDays("guild-1", null);

    const [valuesArg] = mocks.insertValues.mock.calls[0] as unknown as [
      { guildId: string; vcSessionRetentionDays: number | null }
    ];
    expect(valuesArg.vcSessionRetentionDays).toBeNull();
  });

  it("includes the new vcSessionRetentionDays value in the onConflictDoUpdate set payload", async () => {
    await setVcSessionRetentionDays("guild-1", 42);

    const [conflictArg] = mocks.onConflictDoUpdate.mock.calls[0] as unknown as [
      { target: unknown; set: { vcSessionRetentionDays: number | null } }
    ];
    expect(conflictArg.set.vcSessionRetentionDays).toBe(42);
  });

  // (c) Placeholder safety: channelId=null and period="all" are in .values()
  it("uses channelId=null and period='all' as safe placeholder values in insert", async () => {
    await setVcSessionRetentionDays("guild-1", 90);

    const [valuesArg] = mocks.insertValues.mock.calls[0] as unknown as [
      { channelId: string | null; period: string }
    ];
    expect(valuesArg.channelId).toBeNull();
    expect(valuesArg.period).toBe("all");
  });

  it("does not include channelId or period in the onConflictDoUpdate set payload", async () => {
    await setVcSessionRetentionDays("guild-1", 90);

    const [conflictArg] = mocks.onConflictDoUpdate.mock.calls[0] as unknown as [
      { target: unknown; set: Record<string, unknown> }
    ];
    expect(conflictArg.set).not.toHaveProperty("channelId");
    expect(conflictArg.set).not.toHaveProperty("period");
  });

  it("when called with null, conflict set has vcSessionRetentionDays=null and omits channelId and period", async () => {
    await setVcSessionRetentionDays("guild-1", null);

    const [conflictArg] = mocks.onConflictDoUpdate.mock.calls[0] as unknown as [
      { target: unknown; set: Record<string, unknown> }
    ];
    expect(conflictArg.set.vcSessionRetentionDays).toBeNull();
    expect(conflictArg.set).not.toHaveProperty("channelId");
    expect(conflictArg.set).not.toHaveProperty("period");
  });

  // (a) Round-trip: after set(90), a subsequent get reads back 90 (not 180)
  it("round-trip: getVcSessionRetentionDays returns the value that was set, not the 180-day default", async () => {
    // First wire insert chain for the set call
    mocks.insertValues.mockReturnValue({ onConflictDoUpdate: mocks.onConflictDoUpdate });
    mocks.insert.mockReturnValue({ values: mocks.insertValues });
    await setVcSessionRetentionDays("guild-1", 90);

    // Now wire select chain for the get call
    mocks.selectFrom.mockReturnValue({ where: mocks.selectWhere });
    mocks.select.mockReturnValue({ from: mocks.selectFrom });
    mocks.selectWhere.mockResolvedValueOnce([{ vcSessionRetentionDays: 90 }]);

    const days = await getVcSessionRetentionDays("guild-1");
    expect(days).toBe(90);
    expect(days).not.toBe(180);
  });
});
