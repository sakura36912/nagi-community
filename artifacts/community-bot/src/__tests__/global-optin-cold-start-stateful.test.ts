/**
 * Stateful end-to-end tests: setVcGlobalPrivacyOptOut(userId, false) cold-start.
 *
 * A user who has never touched the global opt-out setting has no row in
 * communityVcPrivacyGlobalTable.  Calling setVcGlobalPrivacyOptOut(userId, false)
 * must:
 *   1. INSERT a row with optedOut=false (no conflict → INSERT branch of upsert).
 *   2. Leave that row readable so isVcTrackingGloballyOptedOut returns false.
 *   3. NOT invoke closeOpenSessionsForUser (the update path is opt-out=true only).
 *
 * The mock uses a genuine in-memory store: onConflictDoUpdate writes to it and
 * the subsequent select reads from the same store, so the test fails if the
 * upsert writes the wrong value or the select cannot find the row.
 *
 * Mock pattern follows artifacts/community-bot/src/__tests__/opted-out-false-row.test.ts.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoisted in-memory store ──────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  /** Global privacy store: userId → optedOut */
  const globalStore = new Map<string, boolean>();

  const reset = () => {
    globalStore.clear();
  };

  // Table proxies — identity is stable across the module lifetime
  const makeTable = (name: string) =>
    new Proxy({} as Record<string, string>, { get: (_t, p: string) => `${name}.${p}` });

  const tables = {
    global:            makeTable("global"),
    privacy:           makeTable("privacy"),
    sessions:          makeTable("sessions"),
    eventSettings:     makeTable("eventSettings"),
    events:            makeTable("events"),
    eventParticipants: makeTable("eventParticipants"),
    ticketSettings:    makeTable("ticketSettings"),
    tickets:           makeTable("tickets"),
    ticketPanels:      makeTable("ticketPanels"),
    rankingSettings:   makeTable("rankingSettings"),
    roleButtons:       makeTable("roleButtons"),
  };

  // Condition helper — extract a scalar value from drizzle-orm mock ops
  type Cond = { op: string; col?: unknown; val?: unknown; args?: Cond[] };
  function eqVal(cond: unknown, colPrefix: string): string | undefined {
    if (!cond || typeof cond !== "object") return undefined;
    const c = cond as Cond;
    if (c.op === "eq" && typeof c.col === "string" && c.col.startsWith(colPrefix))
      return c.val as string;
    if (c.op === "and" && Array.isArray(c.args)) {
      for (const a of c.args) {
        const v = eqVal(a, colPrefix);
        if (v !== undefined) return v;
      }
    }
    return undefined;
  }

  // ── Stateful select: reads from globalStore ───────────────────────────────
  const select = vi.fn(() => {
    let fromTable: unknown = null;
    return {
      from: vi.fn((table: unknown) => {
        fromTable = table;
        return {
          where: vi.fn((cond: unknown): Promise<unknown[]> => {
            if (fromTable === tables.global) {
              const userId = eqVal(cond, "global.userId");
              if (userId !== undefined) {
                const optedOut = globalStore.get(userId);
                // Return the row only if it was previously written
                return Promise.resolve(
                  optedOut !== undefined ? [{ userId, optedOut }] : [],
                );
              }
            }
            return Promise.resolve([]);
          }),
        };
      }),
    };
  });

  // ── Stateful insert: persists to globalStore via onConflictDoUpdate ───────
  const insert = vi.fn((table: unknown) => ({
    values: vi.fn((row: Record<string, unknown>) => ({
      onConflictDoUpdate: vi.fn(({ set }: { set: Record<string, unknown> }) => {
        const effectiveOptedOut =
          "optedOut" in set ? (set.optedOut as boolean) : (row.optedOut as boolean);

        if (table === tables.global) {
          globalStore.set(row.userId as string, effectiveOptedOut);
        }
        return Promise.resolve([]);
      }),
      returning: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
    })),
  }));

  // ── update (closeOpenSessionsForUser) — must NOT be called on opt-in ─────
  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([]),
      })),
    })),
  }));

  return { select, insert, update, reset, tables, globalStore };
});

// ─── Mock @workspace/db ───────────────────────────────────────────────────────
vi.mock("@workspace/db", () => ({
  db: {
    select: mocks.select,
    insert: mocks.insert,
    update: mocks.update,
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })),
    })),
  },
  communityVcPrivacyGlobalTable: mocks.tables.global,
  communityVcPrivacyTable:        mocks.tables.privacy,
  communityVcSessionsTable:       mocks.tables.sessions,
  communityEventSettingsTable:    mocks.tables.eventSettings,
  communityEventsTable:           mocks.tables.events,
  communityEventParticipantsTable:mocks.tables.eventParticipants,
  communityTicketSettingsTable:   mocks.tables.ticketSettings,
  communityTicketsTable:          mocks.tables.tickets,
  communityTicketPanelsTable:     mocks.tables.ticketPanels,
  communityRankingSettingsTable:  mocks.tables.rankingSettings,
  communityRoleButtonsTable:      mocks.tables.roleButtons,
}));

// ─── Mock drizzle-orm ─────────────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  and:        (...args: unknown[]) => ({ op: "and", args }),
  eq:         (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  isNull:     (col: unknown) => ({ op: "isNull", col }),
  isNotNull:  (col: unknown) => ({ op: "isNotNull", col }),
  gt:         (col: unknown, val: unknown) => ({ op: "gt", col, val }),
  gte:        (col: unknown, val: unknown) => ({ op: "gte", col, val }),
  lt:         (col: unknown, val: unknown) => ({ op: "lt", col, val }),
  lte:        (col: unknown, val: unknown) => ({ op: "lte", col, val }),
  or:         (...args: unknown[]) => ({ op: "or", args }),
  asc:        (col: unknown) => ({ op: "asc", col }),
  desc:       (col: unknown) => ({ op: "desc", col }),
  notInArray: (col: unknown, vals: unknown[]) => ({ op: "notInArray", col, vals }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({
      op: "sql",
      strings: Array.from(strings),
      values,
    }),
    { raw: (v: unknown) => ({ op: "sql.raw", v }) },
  ),
}));

// ─── Import after mocks ───────────────────────────────────────────────────────
import { setVcGlobalPrivacyOptOut, isVcTrackingGloballyOptedOut } from "../lib/community.js";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("setVcGlobalPrivacyOptOut(false) cold-start: stateful read-back", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();
  });

  it("isVcTrackingGloballyOptedOut returns false after cold-start opt-in (no prior row)", async () => {
    // Precondition: no row in the global store
    expect(mocks.globalStore.has("user-cs-1")).toBe(false);

    // Cold-start opt-in — INSERT branch (no conflict)
    await setVcGlobalPrivacyOptOut("user-cs-1", false);

    // The upsert must have written optedOut=false to the store
    expect(mocks.globalStore.get("user-cs-1")).toBe(false);

    // The checker reads from the same store — must return false, not true
    const result = await isVcTrackingGloballyOptedOut("user-cs-1");
    expect(result).toBe(false);
  });

  it("db.select() returns the freshly upserted row with optedOut=false (not an absent/undefined row)", async () => {
    await setVcGlobalPrivacyOptOut("user-cs-2", false);

    // The store must contain a row (not be empty)
    expect(mocks.globalStore.has("user-cs-2")).toBe(true);

    // isVcTrackingGloballyOptedOut issues a select that will find the row;
    // optedOut=false must not be misread as true.
    const result = await isVcTrackingGloballyOptedOut("user-cs-2");
    expect(result).toBe(false);

    // Exactly one select call was issued (by isVcTrackingGloballyOptedOut)
    expect(mocks.select).toHaveBeenCalledTimes(1);
  });

  it("closeOpenSessionsForUser (db.update) is NOT called on the cold-start opt-in path", async () => {
    await setVcGlobalPrivacyOptOut("user-cs-3", false);

    // db.update() is only invoked by closeOpenSessionsForUser (opt-out=true path).
    // On the opt-in path it must never be called.
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("upserted optedOut=false is distinguishable from the no-row case (store entry exists)", async () => {
    // Before the call: no row
    expect(mocks.globalStore.has("user-cs-4")).toBe(false);

    await setVcGlobalPrivacyOptOut("user-cs-4", false);

    // After the call: row exists with optedOut=false
    // This confirms the upsert ran (INSERT branch took effect)
    expect(mocks.globalStore.has("user-cs-4")).toBe(true);
    expect(mocks.globalStore.get("user-cs-4")).toBe(false);

    // The checker also agrees
    const result = await isVcTrackingGloballyOptedOut("user-cs-4");
    expect(result).toBe(false);
  });

  it("a second call (update/conflict path) also leaves optedOut=false readable", async () => {
    // First call: INSERT (no prior row)
    await setVcGlobalPrivacyOptOut("user-cs-5", false);
    // Second call: UPDATE (row already exists — hits conflict branch)
    await setVcGlobalPrivacyOptOut("user-cs-5", false);

    // Store must still have optedOut=false after two upserts
    expect(mocks.globalStore.get("user-cs-5")).toBe(false);

    const result = await isVcTrackingGloballyOptedOut("user-cs-5");
    expect(result).toBe(false);
  });
});
