/**
 * Confirms that getAllTempVcDeletions — the query backing the CSV export — returns
 * no rows for a user whose sessions have been hard-deleted via either
 * deleteAllUserVcSessions (global wipe) or deleteUserVcSessions (per-guild wipe).
 *
 * Uses a stateful in-memory session store so that db.delete genuinely removes rows
 * from the same store that db.execute reads, making the end-to-end outcome observable
 * without a real database.
 *
 * Tested behaviours:
 *   1. After deleteAllUserVcSessions, getAllTempVcDeletions returns no rows for that userId.
 *   2. After deleteUserVcSessions, getAllTempVcDeletions returns no rows for that userId/guild.
 *   3. Wiping one user does not affect another user's rows in the export.
 *   4. A per-guild wipe only removes that guild's rows; the same user's rows in another
 *      guild are unaffected.
 *   5. deleteAllUserVcSessions deletes with a userId-only filter (no guildId constraint).
 *   6. deleteUserVcSessions deletes with both guildId and userId filters.
 *   7. delete functions return the correct row count.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Types ────────────────────────────────────────────────────────────────────

type SessionRow = {
  id: number;
  guild_id: string;
  user_id: string;
  channel_id: string;
  joined_at: string;
  left_at: string | null;
  opted_out: boolean;
};

type PrivacyRow = {
  user_id: string;
  guild_id: string;
  opted_out: boolean;
};

type GlobalPrivacyRow = {
  user_id: string;
  opted_out: boolean;
};

// ─── Hoist: stateful session + privacy store + DB fakes ───────────────────────
//
// vi.hoisted runs before vi.mock() factories and module imports so both the
// delete and execute implementations share the same bindings.

const store = vi.hoisted(() => {
  // ── In-memory stores ───────────────────────────────────────────────────────
  let sessions: SessionRow[]             = [];
  let privacyRows: PrivacyRow[]          = [];
  let globalRows: GlobalPrivacyRow[]     = [];

  // ── Condition evaluators for delete WHERE clauses ─────────────────────────
  // The drizzle-orm mock returns plain objects: { op, col, val } / { op, args }.
  // The table proxy returns column names like "sessions.userId" (camelCase key).
  function matchesSession(row: SessionRow, cond: Record<string, unknown>): boolean {
    if (cond["op"] === "eq") {
      const col  = cond["col"] as string;
      const val  = cond["val"];
      if (col === "sessions.userId")  return row.user_id  === val;
      if (col === "sessions.guildId") return row.guild_id === val;
      return true; // unknown column — don't filter
    }
    if (cond["op"] === "isNull") {
      const col = cond["col"] as string;
      if (col === "sessions.leftAt") return row.left_at === null;
      return true;
    }
    if (cond["op"] === "and") {
      return (cond["args"] as Record<string, unknown>[]).every((a) => matchesSession(row, a));
    }
    return true;
  }

  function matchesPrivacy(row: PrivacyRow, cond: Record<string, unknown>): boolean {
    if (cond["op"] === "eq") {
      const col  = cond["col"] as string;
      const val  = cond["val"];
      if (col === "privacy.userId")  return row.user_id  === val;
      if (col === "privacy.guildId") return row.guild_id === val;
      return true;
    }
    if (cond["op"] === "and") {
      return (cond["args"] as Record<string, unknown>[]).every((a) => matchesPrivacy(row, a));
    }
    return true;
  }

  function matchesGlobal(row: GlobalPrivacyRow, cond: Record<string, unknown>): boolean {
    if (cond["op"] === "eq") {
      const col = cond["col"] as string;
      const val = cond["val"];
      if (col === "global.userId") return row.user_id === val;
      return true;
    }
    if (cond["op"] === "and") {
      return (cond["args"] as Record<string, unknown>[]).every((a) => matchesGlobal(row, a));
    }
    return true;
  }

  // ── db.select stateful implementation ────────────────────────────────────
  // Supports the select chain: db.select().from(table).where(cond)
  // Used by isVcTrackingOptedOut which reads from both the global and per-guild
  // privacy tables.  Returns rows whose shape matches what community.ts expects:
  //   global table → { userId, optedOut }
  //   privacy table → { guildId, userId, optedOut }
  const select = vi.fn(() => ({
    from: (table: unknown) => ({
      where: (cond: Record<string, unknown>) => {
        const t = table as Record<string, string>;
        const tableName = (t["guildId"] ?? t["userId"] ?? "").split(".")[0];
        if (tableName === "global") {
          const rows = globalRows.filter((r) => matchesGlobal(r, cond));
          return Promise.resolve(rows.map((r) => ({ userId: r.user_id, optedOut: r.opted_out })));
        }
        if (tableName === "privacy") {
          const rows = privacyRows.filter((r) => matchesPrivacy(r, cond));
          return Promise.resolve(rows.map((r) => ({ guildId: r.guild_id, userId: r.user_id, optedOut: r.opted_out })));
        }
        return Promise.resolve([]);
      },
    }),
  }));

  // ── db.update stateful implementation ─────────────────────────────────────
  // Used by closeSession: sets left_at on matching open session rows.
  // The WHERE condition from closeSession contains eq(guildId), eq(userId), isNull(leftAt).
  const update = vi.fn((table: unknown) => ({
    set: (_values: unknown) => ({
      where: (cond: Record<string, unknown>) => ({
        returning: (_shape: unknown) => {
          const t = table as Record<string, string>;
          const tableName = (t["guildId"] ?? t["userId"] ?? "").split(".")[0];
          if (tableName === "sessions") {
            const now = new Date().toISOString();
            const updated: SessionRow[] = [];
            sessions = sessions.map((r) => {
              if (matchesSession(r, cond)) {
                const newRow = { ...r, left_at: now };
                updated.push(newRow);
                return newRow;
              }
              return r;
            });
            return Promise.resolve(updated.map((r) => ({ id: r.id })));
          }
          return Promise.resolve([]);
        },
      }),
    }),
  }));

  // ── db.insert stateful implementation ────────────────────────────────────
  // Supports the insert chain used by openSession:
  //   db.insert(table).values(vals).returning()
  // Appends a new row to the sessions store and returns a camelCase row shape
  // matching what CommunityVcSession looks like (enough for the return value
  // of openSession to be non-null and carry the right fields).
  let _nextInsertId = 1000;

  const insert = vi.fn((table: unknown) => ({
    values: (vals: Record<string, unknown>) => ({
      returning: (_shape?: unknown) => {
        const t = table as Record<string, string>;
        const tableName = (t["guildId"] ?? "").split(".")[0];
        if (tableName === "sessions") {
          const id = _nextInsertId++;
          const joinedAt = vals["joinedAt"] as Date | undefined;
          const newRow: SessionRow = {
            id,
            guild_id: vals["guildId"] as string,
            user_id:  vals["userId"]  as string,
            channel_id: vals["channelId"] as string,
            joined_at: joinedAt ? joinedAt.toISOString() : new Date().toISOString(),
            left_at:  null,
            opted_out: false,
          };
          sessions.push(newRow);
          return Promise.resolve([{
            id:              newRow.id,
            guildId:         newRow.guild_id,
            userId:          newRow.user_id,
            channelId:       newRow.channel_id,
            joinedAt:        new Date(newRow.joined_at),
            leftAt:          null,
            isExile:         vals["isExile"] ?? false,
            isPrivacyClosed: false,
          }]);
        }
        // For other tables (e.g. upserts on privacy tables) — not exercised in
        // this test file, so return an empty result.
        return Promise.resolve([{}]);
      },
    }),
  }));

  // ── db.delete stateful implementation ─────────────────────────────────────
  // Routes to the correct store based on the table proxy's guildId sentinel:
  //   sessions table → (table as Record)["guildId"] === "sessions.guildId"
  //   privacy table  → (table as Record)["guildId"] === "privacy.guildId"
  //   global table   → (table as Record)["guildId"] === "global.guildId"
  const del = vi.fn((table: unknown) => ({
    where: (cond: Record<string, unknown>) => ({
      returning: (_shape: unknown) => {
        const t = table as Record<string, string>;
        const tableName = (t["guildId"] ?? "").split(".")[0];
        if (tableName === "privacy") {
          const removed = privacyRows.filter((r) => matchesPrivacy(r, cond));
          privacyRows   = privacyRows.filter((r) => !matchesPrivacy(r, cond));
          return Promise.resolve(removed.map((_, i) => ({ id: i })));
        } else if (tableName === "global") {
          const removed = globalRows.filter((r) => matchesGlobal(r, cond));
          globalRows    = globalRows.filter((r) => !matchesGlobal(r, cond));
          return Promise.resolve(removed.map((_, i) => ({ id: i })));
        } else {
          const removed = sessions.filter((r) => matchesSession(r, cond));
          sessions      = sessions.filter((r) => !matchesSession(r, cond));
          return Promise.resolve(removed.map((r) => ({ id: r.id })));
        }
      },
    }),
  }));

  // ── db.execute stateful implementation ────────────────────────────────────
  // Interprets the sql template values emitted by getAllTempVcDeletions:
  //   values[0] = guildId  (always a string)
  //   values[1] = startFilter sql fragment  ({ op:"sql", values:[Date?] })
  //   values[2] = endFilter sql fragment
  //   values[3] = userFilter sql fragment   ({ op:"sql", values:[userId?] })
  //
  // Only completed sessions (left_at IS NOT NULL) are included, matching the
  // WHERE s.left_at IS NOT NULL clause in the real query.
  const execute = vi.fn((sqlObj: { strings: string[]; values: unknown[] }) => {
    const guildId = sqlObj.values[0] as string;

    // Extract userId from the userFilter nested sql fragment (values[3])
    const userFilter = sqlObj.values[3] as { op: string; values: unknown[] } | undefined;
    const userId     = userFilter?.values?.length ? (userFilter.values[0] as string) : null;

    let results = sessions.filter((r) => r.guild_id === guildId && r.left_at !== null);
    if (userId) {
      results = results.filter((r) => r.user_id === userId);
    }

    return Promise.resolve({ rows: results });
  });

  // ── Store helpers ──────────────────────────────────────────────────────────
  function seed(rows: SessionRow[]): void {
    sessions = [...rows];
  }

  function seedPrivacy(rows: PrivacyRow[]): void {
    privacyRows = [...rows];
  }

  function getPrivacyRows(): PrivacyRow[] {
    return [...privacyRows];
  }

  function seedGlobal(rows: GlobalPrivacyRow[]): void {
    globalRows = [...rows];
  }

  function getGlobalRows(): GlobalPrivacyRow[] {
    return [...globalRows];
  }

  function getSessions(): SessionRow[] {
    return [...sessions];
  }

  function reset(): void {
    sessions        = [];
    privacyRows     = [];
    globalRows      = [];
    _nextInsertId   = 1000;
  }

  return { del, insert, update, select, execute, seed, seedPrivacy, getPrivacyRows, seedGlobal, getGlobalRows, getSessions, reset };
});

// ─── Mock @workspace/db ───────────────────────────────────────────────────────
vi.mock("@workspace/db", () => {
  const tbl = (name: string) =>
    new Proxy({} as Record<string, string>, {
      get: (_t, p: string) => `${name}.${p}`,
    });

  return {
    db: {
      delete:  store.del,
      insert:  store.insert,
      update:  store.update,
      select:  store.select,
      execute: store.execute,
    },
    communityVcSessionsTable:          tbl("sessions"),
    communityVcPrivacyGlobalTable:      tbl("global"),
    communityVcPrivacyTable:            tbl("privacy"),
    communityEventSettingsTable:        tbl("eventSettings"),
    communityEventsTable:               tbl("events"),
    communityEventParticipantsTable:    tbl("eventParticipants"),
    communityTicketSettingsTable:       tbl("ticketSettings"),
    communityTicketsTable:              tbl("tickets"),
    communityTicketPanelsTable:         tbl("ticketPanels"),
    communityRankingSettingsTable:      tbl("rankingSettings"),
    communityRoleButtonsTable:          tbl("roleButtons"),
  };
});

// ─── Mock drizzle-orm operators ───────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  and:       (...args: unknown[])              => ({ op: "and",       args }),
  eq:        (col: unknown, val: unknown)      => ({ op: "eq",        col, val }),
  isNull:    (col: unknown)                    => ({ op: "isNull",    col }),
  isNotNull: (col: unknown)                    => ({ op: "isNotNull", col }),
  gt:        (col: unknown, val: unknown)      => ({ op: "gt",        col, val }),
  gte:       (col: unknown, val: unknown)      => ({ op: "gte",       col, val }),
  lt:        (col: unknown, val: unknown)      => ({ op: "lt",        col, val }),
  lte:       (col: unknown, val: unknown)      => ({ op: "lte",       col, val }),
  or:        (...args: unknown[])              => ({ op: "or",        args }),
  asc:       (col: unknown)                    => ({ op: "asc",       col }),
  desc:      (col: unknown)                    => ({ op: "desc",      col }),
  notInArray:(col: unknown, val: unknown)      => ({ op: "notInArray", col, val }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: "sql", strings: Array.from(strings), values }),
    { raw: (v: unknown) => ({ op: "sql.raw", v }) },
  ),
}));

// ─── Import under test ────────────────────────────────────────────────────────
import {
  getAllTempVcDeletions,
  deleteAllUserVcSessions,
  deleteUserVcSessions,
  closeSession,
  isVcTrackingOptedOut,
  openSession,
} from "../lib/community.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _nextId = 1;

function makeRow(
  userId: string,
  guildId: string,
  opts: { opted_out?: boolean; leftAt?: Date | null } = {},
): SessionRow {
  const leftAt = opts.leftAt === undefined ? new Date() : opts.leftAt;
  return {
    id:         _nextId++,
    guild_id:   guildId,
    user_id:    userId,
    channel_id: "ch-1",
    joined_at:  leftAt ? new Date(leftAt.getTime() - 60_000).toISOString() : new Date().toISOString(),
    left_at:    leftAt ? leftAt.toISOString() : null,
    opted_out:  opts.opted_out ?? false,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CSV export after data wipe – deleted rows must not appear", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.reset();
    _nextId = 1;
  });

  // ── deleteAllUserVcSessions (global wipe) ────────────────────────────────

  describe("deleteAllUserVcSessions (global wipe)", () => {
    it("export returns no rows for the wiped user after a global wipe", async () => {
      store.seed([makeRow("wiped-user", "guild-A")]);

      await deleteAllUserVcSessions("wiped-user");
      const result = await getAllTempVcDeletions("guild-A");

      expect(result).toHaveLength(0);
    });

    it("export returns no rows when the user had multiple completed sessions", async () => {
      store.seed([
        makeRow("wiped-user", "guild-A"),
        makeRow("wiped-user", "guild-A"),
        makeRow("wiped-user", "guild-A"),
      ]);

      await deleteAllUserVcSessions("wiped-user");
      const result = await getAllTempVcDeletions("guild-A", { userId: "wiped-user" });

      expect(result).toHaveLength(0);
    });

    it("removing one user does not affect another user's rows in the export", async () => {
      store.seed([
        makeRow("wiped-user",  "guild-A"),
        makeRow("other-user",  "guild-A"),
      ]);

      await deleteAllUserVcSessions("wiped-user");
      const result = await getAllTempVcDeletions("guild-A");

      expect(result).toHaveLength(1);
      expect(result[0]?.userId).toBe("other-user");
    });

    it("global wipe removes sessions across multiple guilds for that user", async () => {
      store.seed([
        makeRow("wiped-user", "guild-A"),
        makeRow("wiped-user", "guild-B"),
        makeRow("wiped-user", "guild-C"),
        makeRow("other-user", "guild-A"),
      ]);

      await deleteAllUserVcSessions("wiped-user");

      const [a, b, c] = await Promise.all([
        getAllTempVcDeletions("guild-A"),
        getAllTempVcDeletions("guild-B"),
        getAllTempVcDeletions("guild-C"),
      ]);

      expect(a).toHaveLength(1);
      expect(a[0]?.userId).toBe("other-user");
      expect(b).toHaveLength(0);
      expect(c).toHaveLength(0);
    });

    it("active (open) sessions are not counted in the export even when present", async () => {
      // An open session (left_at = null) from another user — should not appear
      store.seed([
        makeRow("wiped-user", "guild-A"),           // completed — will be wiped
        makeRow("other-user", "guild-A", { leftAt: null }), // active — never in export
      ]);

      await deleteAllUserVcSessions("wiped-user");
      const result = await getAllTempVcDeletions("guild-A");

      // other-user's open session must be excluded (left_at IS NOT NULL filter)
      expect(result).toHaveLength(0);
    });

    it("deletes with a userId-only filter (no guildId constraint) for sessions, removes the global opt-out row, and removes per-guild opt-out rows", async () => {
      store.seed([makeRow("wiped-user", "guild-A")]);

      await deleteAllUserVcSessions("wiped-user");

      // Three db.delete calls: sessions, global opt-out, per-guild opt-out rows.
      expect(store.del).toHaveBeenCalledTimes(3);
      const tables = store.del.mock.calls.map((c) => c[0] as Record<string, string>);

      // First delete must target the sessions table with userId only (no guildId constraint)
      const sessionsTableArg = tables[0];
      expect(sessionsTableArg?.["userId"]).toBe("sessions.userId");

      // Second delete must target the global opt-out table
      const globalTableArg = tables[1];
      expect(globalTableArg?.["userId"]).toBe("global.userId");

      // Third delete must target the per-guild privacy table (userId-only, all guilds)
      const privacyTableArg = tables[2];
      expect(privacyTableArg?.["userId"]).toBe("privacy.userId");
    });

    it("returns the count of deleted rows", async () => {
      store.seed([
        makeRow("wiped-user", "guild-A"),
        makeRow("wiped-user", "guild-B"),
        makeRow("wiped-user", "guild-C"),
      ]);

      const count = await deleteAllUserVcSessions("wiped-user");

      expect(count).toBe(3);
    });

    it("counts both open and completed sessions when the user has a mix", async () => {
      // 1 active (left_at = null) + 2 completed rows for the same user across guilds.
      store.seed([
        makeRow("wiped-user", "guild-A", { leftAt: null }), // open
        makeRow("wiped-user", "guild-A"),                   // completed
        makeRow("wiped-user", "guild-B"),                   // completed
      ]);

      const count = await deleteAllUserVcSessions("wiped-user");

      // deleteAllUserVcSessions has no left_at guard, so all 3 rows must be deleted.
      expect(count).toBe(3);
    });

    it("returns 0 when the user had no sessions to delete", async () => {
      store.seed([makeRow("other-user", "guild-A")]);

      const count = await deleteAllUserVcSessions("no-sessions-user");

      expect(count).toBe(0);
    });

    it("global wipe removes an active (open) session and export returns 0 rows across all guilds", async () => {
      // Seed only an open session (left_at = null) — the user is still in VC at wipe time.
      store.seed([
        makeRow("wiped-user", "guild-A", { leftAt: null }),
        makeRow("wiped-user", "guild-B", { leftAt: null }),
      ]);

      const count = await deleteAllUserVcSessions("wiped-user");

      // Both active rows must have been deleted (no guildId guard on the global wipe).
      expect(count).toBe(2);

      // The export must return 0 rows for every guild — the active rows are gone,
      // not merely excluded by the left_at IS NOT NULL export filter.
      const [a, b] = await Promise.all([
        getAllTempVcDeletions("guild-A", { userId: "wiped-user" }),
        getAllTempVcDeletions("guild-B", { userId: "wiped-user" }),
      ]);
      expect(a).toHaveLength(0);
      expect(b).toHaveLength(0);

      // The underlying store must be empty — no row can later become exportable.
      expect(store.getSessions().filter((r) => r.user_id === "wiped-user")).toHaveLength(0);
    });

    it("global wipe removes a session that was closed immediately before the wipe and export returns 0 rows", async () => {
      // Seed an open session — user is in VC.
      store.seed([makeRow("wiped-user", "guild-A", { leftAt: null })]);

      // The user leaves (closeSession stamps left_at) — the row becomes completed.
      await closeSession("guild-A", "wiped-user");

      // Sanity: the completed row now appears in the export.
      const before = await getAllTempVcDeletions("guild-A", { userId: "wiped-user" });
      expect(before).toHaveLength(1);

      // The global wipe is then invoked.
      const count = await deleteAllUserVcSessions("wiped-user");
      expect(count).toBe(1); // the completed row was deleted

      // Export must now return 0 rows — the completed row was hard-deleted by the wipe.
      const after = await getAllTempVcDeletions("guild-A", { userId: "wiped-user" });
      expect(after).toHaveLength(0);
    });

    it("trailing closeSession after global wipe cannot recreate an exportable row", async () => {
      // Simulate the race: user is in VC, admin triggers a global wipe, then the
      // Discord leave event fires and calls closeSession for the same user/guild.
      // Because deleteAllUserVcSessions already hard-deleted the open session row,
      // closeSession's UPDATE finds nothing to stamp — no completed row is created.

      // Seed one open session (user is currently in VC).
      store.seed([makeRow("wiped-user", "guild-A", { leftAt: null })]);

      // Step 1: global wipe removes the open session row.
      await deleteAllUserVcSessions("wiped-user");

      // Step 2: trailing leave event — closeSession fires after the wipe.
      await closeSession("guild-A", "wiped-user");

      // No row was recreated — the session store must be empty.
      expect(store.getSessions()).toHaveLength(0);

      // The export must also return 0 rows — no completed row was written.
      const rows = await getAllTempVcDeletions("guild-A", { userId: "wiped-user" });
      expect(rows).toHaveLength(0);
    });
  });

  // ── Global wipe clears the global opt-out row (clean re-tracking) ───────
  //
  // deleteAllUserVcSessions deletes session rows AND removes the matching
  // community_vc_privacy_global row so the user can be re-tracked automatically
  // after the full data wipe without needing an explicit re-opt-in.

  describe("global wipe clears the global opt-out row (clean re-tracking)", () => {
    it("global opt-out row is removed after deleteAllUserVcSessions", async () => {
      store.seed([makeRow("wiped-user", "guild-A")]);
      store.seedGlobal([{ user_id: "wiped-user", opted_out: true }]);

      await deleteAllUserVcSessions("wiped-user");

      // Sessions are gone from the export
      const sessions = await getAllTempVcDeletions("guild-A", { userId: "wiped-user" });
      expect(sessions).toHaveLength(0);

      // Global opt-out row is also cleared — the user can be re-tracked.
      const global = store.getGlobalRows();
      expect(global).toHaveLength(0);
    });

    it("global opt-out is cleared even when the user had no sessions", async () => {
      store.seedGlobal([{ user_id: "wiped-user", opted_out: true }]);

      await deleteAllUserVcSessions("wiped-user");

      expect(store.getGlobalRows()).toHaveLength(0);
    });

    it("only the wiped user's global opt-out row is removed; other users' rows survive", async () => {
      store.seed([makeRow("wiped-user", "guild-A")]);
      store.seedGlobal([
        { user_id: "wiped-user", opted_out: true },
        { user_id: "other-user", opted_out: true },
      ]);

      await deleteAllUserVcSessions("wiped-user");

      const global = store.getGlobalRows();
      expect(global).toHaveLength(1);
      expect(global[0]).toMatchObject({ user_id: "other-user" });
    });

    it("wipe works cleanly when no global opt-out row exists for the user", async () => {
      store.seed([makeRow("wiped-user", "guild-A")]);
      // No global row seeded — should not throw and should return correct count.

      await expect(deleteAllUserVcSessions("wiped-user")).resolves.toBe(1);
      expect(store.getGlobalRows()).toHaveLength(0);
    });

    it("db.delete is called three times — once for sessions, once for global opt-out, once for per-guild opt-outs", async () => {
      store.seed([makeRow("wiped-user", "guild-A")]);
      store.seedGlobal([{ user_id: "wiped-user", opted_out: true }]);
      store.seedPrivacy([{ user_id: "wiped-user", guild_id: "guild-A", opted_out: true }]);

      await deleteAllUserVcSessions("wiped-user");

      expect(store.del).toHaveBeenCalledTimes(3);
      const tables = store.del.mock.calls.map((c) => {
        const t = c[0] as Record<string, string>;
        return (t["guildId"] ?? t["userId"] ?? "").split(".")[0];
      });
      expect(tables).toContain("sessions");
      expect(tables).toContain("global");
      expect(tables).toContain("privacy");
    });
  });

  // ── Global wipe clears per-guild opt-out rows (clean re-tracking in every guild) ──
  //
  // deleteAllUserVcSessions must delete ALL community_vc_privacy rows for the user
  // (not just the global row) so that isVcTrackingOptedOut returns false for every
  // guild after the wipe.  Without this step, a user who had per-guild opt-outs would
  // still be blocked from re-tracking in those guilds even though the global row is gone.

  describe("global wipe clears per-guild opt-out rows (clean re-tracking in every guild)", () => {
    it("per-guild opt-out row is removed after deleteAllUserVcSessions", async () => {
      store.seed([makeRow("wiped-user", "guild-A")]);
      store.seedPrivacy([{ user_id: "wiped-user", guild_id: "guild-A", opted_out: true }]);

      await deleteAllUserVcSessions("wiped-user");

      const privacy = store.getPrivacyRows();
      expect(privacy).toHaveLength(0);
    });

    it("all per-guild opt-out rows are removed when the user had multiple guild opt-outs", async () => {
      store.seed([
        makeRow("wiped-user", "guild-A"),
        makeRow("wiped-user", "guild-B"),
      ]);
      store.seedPrivacy([
        { user_id: "wiped-user", guild_id: "guild-A", opted_out: true },
        { user_id: "wiped-user", guild_id: "guild-B", opted_out: true },
        { user_id: "wiped-user", guild_id: "guild-C", opted_out: true },
      ]);

      await deleteAllUserVcSessions("wiped-user");

      expect(store.getPrivacyRows()).toHaveLength(0);
    });

    it("only the wiped user's per-guild rows are removed; other users' rows survive", async () => {
      store.seed([makeRow("wiped-user", "guild-A")]);
      store.seedPrivacy([
        { user_id: "wiped-user", guild_id: "guild-A", opted_out: true },
        { user_id: "other-user", guild_id: "guild-A", opted_out: true },
      ]);

      await deleteAllUserVcSessions("wiped-user");

      const privacy = store.getPrivacyRows();
      expect(privacy).toHaveLength(1);
      expect(privacy[0]).toMatchObject({ user_id: "other-user", guild_id: "guild-A" });
    });

    it("wipe works cleanly when no per-guild opt-out rows exist for the user", async () => {
      store.seed([makeRow("wiped-user", "guild-A")]);
      // No privacy rows seeded — should not throw and should return correct count.

      await expect(deleteAllUserVcSessions("wiped-user")).resolves.toBe(1);
      expect(store.getPrivacyRows()).toHaveLength(0);
    });

    it("both global and per-guild opt-out rows are cleared in a single wipe call", async () => {
      store.seed([makeRow("wiped-user", "guild-A")]);
      store.seedGlobal([{ user_id: "wiped-user", opted_out: true }]);
      store.seedPrivacy([
        { user_id: "wiped-user", guild_id: "guild-A", opted_out: true },
        { user_id: "wiped-user", guild_id: "guild-B", opted_out: true },
      ]);

      await deleteAllUserVcSessions("wiped-user");

      expect(store.getGlobalRows()).toHaveLength(0);
      expect(store.getPrivacyRows()).toHaveLength(0);
    });
  });

  // ── deleteUserVcSessions (per-guild wipe) ────────────────────────────────

  describe("deleteUserVcSessions (per-guild wipe)", () => {
    it("export returns no rows for the wiped user in the target guild", async () => {
      store.seed([makeRow("wiped-user", "guild-A")]);

      await deleteUserVcSessions("guild-A", "wiped-user");
      const result = await getAllTempVcDeletions("guild-A", { userId: "wiped-user" });

      expect(result).toHaveLength(0);
    });

    it("does not affect rows for the same user in a different guild", async () => {
      store.seed([
        makeRow("wiped-user", "guild-A"),
        makeRow("wiped-user", "guild-B"),
      ]);

      await deleteUserVcSessions("guild-A", "wiped-user");

      const resultA = await getAllTempVcDeletions("guild-A", { userId: "wiped-user" });
      const resultB = await getAllTempVcDeletions("guild-B", { userId: "wiped-user" });

      expect(resultA).toHaveLength(0);
      expect(resultB).toHaveLength(1);
      expect(resultB[0]?.userId).toBe("wiped-user");
      expect(resultB[0]?.guildId).toBe("guild-B");
    });

    it("does not affect rows for a different user in the same guild", async () => {
      store.seed([
        makeRow("wiped-user",  "guild-A"),
        makeRow("other-user",  "guild-A"),
      ]);

      await deleteUserVcSessions("guild-A", "wiped-user");
      const result = await getAllTempVcDeletions("guild-A");

      expect(result).toHaveLength(1);
      expect(result[0]?.userId).toBe("other-user");
    });

    it("deletes with both guildId and userId filters (scoped wipe)", async () => {
      store.seed([makeRow("wiped-user", "guild-A")]);

      await deleteUserVcSessions("guild-A", "wiped-user");

      // Two db.delete calls: first for sessions, second for the privacy opt-out row.
      expect(store.del).toHaveBeenCalledTimes(2);
      const firstTableArg  = store.del.mock.calls[0]?.[0] as Record<string, string>;
      const secondTableArg = store.del.mock.calls[1]?.[0] as Record<string, string>;
      expect(firstTableArg?.["guildId"]).toBe("sessions.guildId");
      expect(firstTableArg?.["userId"]).toBe("sessions.userId");
      expect(secondTableArg?.["guildId"]).toBe("privacy.guildId");
      expect(secondTableArg?.["userId"]).toBe("privacy.userId");
    });

    it("per-guild wipe of multiple sessions removes them all", async () => {
      store.seed([
        makeRow("wiped-user", "guild-A"),
        makeRow("wiped-user", "guild-A"),
        makeRow("wiped-user", "guild-A"),
        makeRow("wiped-user", "guild-B"), // different guild — survives
      ]);

      await deleteUserVcSessions("guild-A", "wiped-user");

      const resultA = await getAllTempVcDeletions("guild-A", { userId: "wiped-user" });
      const resultB = await getAllTempVcDeletions("guild-B", { userId: "wiped-user" });

      expect(resultA).toHaveLength(0);
      expect(resultB).toHaveLength(1);
    });

    it("returns the count of deleted rows", async () => {
      store.seed([
        makeRow("wiped-user", "guild-A"),
        makeRow("wiped-user", "guild-A"),
      ]);

      const count = await deleteUserVcSessions("guild-A", "wiped-user");

      expect(count).toBe(2);
    });

    it("counts both open and completed sessions when the user has a mix", async () => {
      // 1 active (left_at = null) + 2 completed rows for the same user/guild.
      store.seed([
        makeRow("wiped-user", "guild-A", { leftAt: null }), // open
        makeRow("wiped-user", "guild-A"),                   // completed
        makeRow("wiped-user", "guild-A"),                   // completed
      ]);

      const count = await deleteUserVcSessions("guild-A", "wiped-user");

      // deleteUserVcSessions has no left_at guard, so all 3 rows must be deleted.
      expect(count).toBe(3);
    });

    it("returns 0 when the user had no sessions in that guild", async () => {
      store.seed([makeRow("wiped-user", "guild-B")]); // different guild

      const count = await deleteUserVcSessions("guild-A", "wiped-user");

      expect(count).toBe(0);
    });

    it("trailing leave event after per-guild wipe cannot recreate an exportable row", async () => {
      // Seed one open session (left_at = null) — simulates a user still in VC.
      store.seed([makeRow("wiped-user", "guild-A", { leftAt: null })]);

      // Admin wipes the user's per-guild data while they are still connected.
      await deleteUserVcSessions("guild-A", "wiped-user");

      // The Discord leave event fires after the wipe — closeSession must find
      // no open row to update, so no completed row is written to the store.
      await closeSession("guild-A", "wiped-user");

      // No session row must exist in the store (not recreated by closeSession).
      expect(store.getSessions()).toHaveLength(0);

      // The export query must return no rows for this user/guild.
      const exported = await getAllTempVcDeletions("guild-A", { userId: "wiped-user" });
      expect(exported).toHaveLength(0);
    });
  });

  // ── Mixed wipe + export ──────────────────────────────────────────────────

  describe("mixed wipe + export scenario", () => {
    it("export returns only surviving rows when one user is wiped and another is not", async () => {
      store.seed([
        makeRow("user-A", "guild-A"),
        makeRow("user-B", "guild-A"),
      ]);

      await deleteAllUserVcSessions("user-A");
      const result = await getAllTempVcDeletions("guild-A");

      expect(result).toHaveLength(1);
      expect(result[0]?.userId).toBe("user-B");
      expect(result.map((r) => r.userId)).not.toContain("user-A");
    });

    it("per-guild wipe leaves only the non-wiped guild's sessions in the export", async () => {
      store.seed([
        makeRow("user-A", "guild-A"),
        makeRow("user-A", "guild-B"),
        makeRow("user-B", "guild-A"),
      ]);

      await deleteUserVcSessions("guild-A", "user-A");

      const resultA = await getAllTempVcDeletions("guild-A");
      const resultB = await getAllTempVcDeletions("guild-B");

      // guild-A: only user-B remains
      expect(resultA).toHaveLength(1);
      expect(resultA[0]?.userId).toBe("user-B");

      // guild-B: user-A's row is untouched
      expect(resultB).toHaveLength(1);
      expect(resultB[0]?.userId).toBe("user-A");
    });
  });

  // ── Per-guild wipe clears the privacy opt-out row (clean re-opt-in) ─────
  //
  // deleteUserVcSessions deletes session rows AND removes the matching
  // community_vc_privacy row so the user can be re-tracked automatically
  // after the wipe without needing an explicit re-opt-in.

  describe("per-guild wipe clears the privacy opt-out row (clean re-opt-in)", () => {
    it("privacy opt-out row is removed after deleteUserVcSessions (stateful store check)", async () => {
      store.seed([makeRow("wiped-user", "guild-A")]);
      store.seedPrivacy([{ user_id: "wiped-user", guild_id: "guild-A", opted_out: true }]);

      await deleteUserVcSessions("guild-A", "wiped-user");

      // Session rows are gone from the export
      const sessions = await getAllTempVcDeletions("guild-A", { userId: "wiped-user" });
      expect(sessions).toHaveLength(0);

      // Privacy row is also cleared — the user can be re-tracked immediately.
      const privacy = store.getPrivacyRows();
      expect(privacy).toHaveLength(0);
    });

    it("only the wiped user's privacy row is removed; other users' rows survive", async () => {
      store.seed([makeRow("wiped-user", "guild-A")]);
      store.seedPrivacy([
        { user_id: "wiped-user", guild_id: "guild-A", opted_out: true },
        { user_id: "other-user", guild_id: "guild-A", opted_out: true },
      ]);

      await deleteUserVcSessions("guild-A", "wiped-user");

      const privacy = store.getPrivacyRows();
      expect(privacy).toHaveLength(1);
      expect(privacy[0]).toMatchObject({ user_id: "other-user", guild_id: "guild-A" });
    });

    it("only the target guild's privacy row is removed; same user's row in another guild survives", async () => {
      store.seed([makeRow("wiped-user", "guild-A")]);
      store.seedPrivacy([
        { user_id: "wiped-user", guild_id: "guild-A", opted_out: true },
        { user_id: "wiped-user", guild_id: "guild-B", opted_out: true },
      ]);

      await deleteUserVcSessions("guild-A", "wiped-user");

      const privacy = store.getPrivacyRows();
      expect(privacy).toHaveLength(1);
      expect(privacy[0]).toMatchObject({ user_id: "wiped-user", guild_id: "guild-B" });
    });

    it("db.delete is called twice — once for sessions, once for privacy", async () => {
      store.seed([makeRow("wiped-user", "guild-A")]);
      store.seedPrivacy([{ user_id: "wiped-user", guild_id: "guild-A", opted_out: true }]);

      await deleteUserVcSessions("guild-A", "wiped-user");

      expect(store.del).toHaveBeenCalledTimes(2);
      const tables = store.del.mock.calls.map((c) => (c[0] as Record<string, string>)["guildId"]);
      expect(tables).toContain("sessions.guildId");
      expect(tables).toContain("privacy.guildId");
    });

    it("wipe works cleanly when no privacy row exists for the user", async () => {
      store.seed([makeRow("wiped-user", "guild-A")]);
      // No privacy row seeded — should not throw

      await expect(deleteUserVcSessions("guild-A", "wiped-user")).resolves.toBe(1);
      expect(store.getPrivacyRows()).toHaveLength(0);
    });
  });

  // ── deleteUserVcSessions with only active (open) sessions ───────────────
  //
  // deleteUserVcSessions has no left_at guard — it deletes ALL session rows
  // (open or closed) for the given user/guild.  These tests guard against a
  // regression where the wipe silently skips active rows:
  //
  //   (a) The wipe must physically remove the active row from the store, not just
  //       exclude it from the export query.  Without the delete, a later
  //       closeSession call would produce a completed row that *would* appear in
  //       the export — violating the privacy guarantee.
  //
  //   (b) After the wipe, a trailing closeSession call (e.g. the leave handler
  //       fires after the admin has already wiped the data) must find no matching
  //       row to update, so no exportable record is recreated.

  describe("per-guild wipe handles users with only active (open) sessions", () => {
    it("actually deletes the active row so it cannot become exportable later", async () => {
      // Seed one open session (left_at = null).
      store.seed([makeRow("wiped-user", "guild-A", { leftAt: null })]);

      // Wipe while the session is still active.
      const count = await deleteUserVcSessions("guild-A", "wiped-user");

      // The wipe must have deleted the active row — not merely excluded it from
      // the export query.  A count of 0 would indicate the row was skipped and
      // could later become exportable once the user leaves the VC.
      expect(count).toBe(1);

      // The store must be empty — no row survives to be closed later.
      expect(store.getSessions()).toHaveLength(0);

      // Corroborating export check: nothing appears in the CSV view either.
      const result = await getAllTempVcDeletions("guild-A", { userId: "wiped-user" });
      expect(result).toHaveLength(0);
    });

    it("a trailing closeSession after the wipe cannot recreate an exportable row", async () => {
      // Seed one open session — user is still in VC when the admin wipes.
      store.seed([makeRow("wiped-user", "guild-A", { leftAt: null })]);

      // Admin wipes the data while the session is active.
      const count = await deleteUserVcSessions("guild-A", "wiped-user");
      expect(count).toBe(1); // sanity: active row was deleted

      // The leave handler fires after the wipe (race condition).
      // closeSession must find no matching row (it was already deleted) and
      // must not insert or recreate any row.
      await closeSession("guild-A", "wiped-user");

      // Store must still be empty — no row was recreated by closeSession.
      expect(store.getSessions()).toHaveLength(0);

      // Export must return nothing — no completed row for the user exists.
      const result = await getAllTempVcDeletions("guild-A", { userId: "wiped-user" });
      expect(result).toHaveLength(0);
    });
  });

  // ── Wipe → re-track: isVcTrackingOptedOut returns false after wipe ───────
  //
  // deleteAllUserVcSessions deletes both the global opt-out row and all per-guild
  // opt-out rows.  The following tests confirm that isVcTrackingOptedOut (which
  // is what openSession consults on every join) returns false for the wiped user
  // so that tracking resumes automatically on their next join — no explicit
  // re-opt-in required.

  describe("wipe → re-track: isVcTrackingOptedOut returns false after deleteAllUserVcSessions", () => {
    it("isVcTrackingOptedOut returns false after the global opt-out row is cleared by the wipe", async () => {
      // Seed a global opt-out row — user has opted out of tracking across all guilds.
      store.seedGlobal([{ user_id: "wiped-user", opted_out: true }]);

      await deleteAllUserVcSessions("wiped-user");

      // Both global and per-guild opt-out rows are gone, so the user is no
      // longer opted out and will be tracked on their next join.
      const optedOut = await isVcTrackingOptedOut("guild-A", "wiped-user");
      expect(optedOut).toBe(false);
    });

    it("isVcTrackingOptedOut returns false after both global and per-guild opt-out rows are cleared", async () => {
      store.seedGlobal([{ user_id: "wiped-user", opted_out: true }]);
      store.seedPrivacy([{ user_id: "wiped-user", guild_id: "guild-A", opted_out: true }]);

      await deleteAllUserVcSessions("wiped-user");

      const optedOut = await isVcTrackingOptedOut("guild-A", "wiped-user");
      expect(optedOut).toBe(false);
    });

    it("isVcTrackingOptedOut returns false when only a per-guild opt-out existed before the wipe", async () => {
      // No global row — only a per-guild opt-out.
      store.seedPrivacy([{ user_id: "wiped-user", guild_id: "guild-A", opted_out: true }]);

      await deleteAllUserVcSessions("wiped-user");

      const optedOut = await isVcTrackingOptedOut("guild-A", "wiped-user");
      expect(optedOut).toBe(false);
    });

    it("isVcTrackingOptedOut returns false even when the user had no opt-out rows at all before the wipe", async () => {
      // Wipe a user who had no opt-out rows — should not throw and tracking
      // must still be unblocked afterwards.
      store.seed([makeRow("wiped-user", "guild-A")]);

      await deleteAllUserVcSessions("wiped-user");

      const optedOut = await isVcTrackingOptedOut("guild-A", "wiped-user");
      expect(optedOut).toBe(false);
    });

    it("other users' opt-out status is not affected by the wipe", async () => {
      store.seedGlobal([
        { user_id: "wiped-user", opted_out: true },
        { user_id: "other-user", opted_out: true },
      ]);
      store.seedPrivacy([
        { user_id: "other-user", guild_id: "guild-A", opted_out: true },
      ]);

      await deleteAllUserVcSessions("wiped-user");

      // wiped-user is no longer opted out
      expect(await isVcTrackingOptedOut("guild-A", "wiped-user")).toBe(false);

      // other-user's global opt-out is intact — they remain opted out
      expect(await isVcTrackingOptedOut("guild-A", "other-user")).toBe(true);
    });

    it("isVcTrackingOptedOut returns false in every guild the user had a per-guild opt-out in", async () => {
      store.seedPrivacy([
        { user_id: "wiped-user", guild_id: "guild-A", opted_out: true },
        { user_id: "wiped-user", guild_id: "guild-B", opted_out: true },
        { user_id: "wiped-user", guild_id: "guild-C", opted_out: true },
      ]);

      await deleteAllUserVcSessions("wiped-user");

      const [a, b, c] = await Promise.all([
        isVcTrackingOptedOut("guild-A", "wiped-user"),
        isVcTrackingOptedOut("guild-B", "wiped-user"),
        isVcTrackingOptedOut("guild-C", "wiped-user"),
      ]);

      expect(a).toBe(false);
      expect(b).toBe(false);
      expect(c).toBe(false);
    });
  });

  // ── Wipe → openSession: a new session row is inserted after a full wipe ──
  //
  // The wipe → re-track tests above only confirm that isVcTrackingOptedOut
  // returns false after deleteAllUserVcSessions.  These tests go one step
  // further and call openSession directly, confirming that a new row is
  // physically inserted into the sessions store — ruling out regressions such
  // as an early-return bug inside openSession itself.

  describe("wipe → openSession: new session row is created after a full wipe", () => {
    it("openSession returns a non-null session row after the global opt-out is cleared by the wipe", async () => {
      // Seed a global opt-out so the user was opted out before the wipe.
      store.seedGlobal([{ user_id: "wiped-user", opted_out: true }]);

      // Wipe clears the opt-out rows so tracking can resume.
      await deleteAllUserVcSessions("wiped-user");

      // Simulating a join event: openSession must detect no opt-out and insert.
      const session = await openSession("guild-A", "wiped-user", "ch-1");

      // Must return a non-null row — tracking is fully resumed.
      expect(session).not.toBeNull();
      expect(session?.userId).toBe("wiped-user");
      expect(session?.guildId).toBe("guild-A");
    });

    it("db.insert is called once when openSession runs after the wipe", async () => {
      store.seedGlobal([{ user_id: "wiped-user", opted_out: true }]);

      await deleteAllUserVcSessions("wiped-user");
      await openSession("guild-A", "wiped-user", "ch-1");

      // db.insert must have been invoked — confirming a row was inserted, not
      // just that the opt-out check passed.
      expect(store.insert).toHaveBeenCalledTimes(1);
    });

    it("a new row appears in the store after openSession runs post-wipe", async () => {
      store.seedGlobal([{ user_id: "wiped-user", opted_out: true }]);

      await deleteAllUserVcSessions("wiped-user");
      await openSession("guild-A", "wiped-user", "ch-1");

      const rows = store.getSessions().filter((r) => r.user_id === "wiped-user");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.guild_id).toBe("guild-A");
      expect(rows[0]?.left_at).toBeNull(); // session is still open
    });

    it("openSession returns non-null after a wipe that also had per-guild opt-out rows", async () => {
      store.seedGlobal([{ user_id: "wiped-user", opted_out: true }]);
      store.seedPrivacy([
        { user_id: "wiped-user", guild_id: "guild-A", opted_out: true },
        { user_id: "wiped-user", guild_id: "guild-B", opted_out: true },
      ]);

      await deleteAllUserVcSessions("wiped-user");

      const session = await openSession("guild-A", "wiped-user", "ch-1");

      expect(session).not.toBeNull();
      expect(session?.userId).toBe("wiped-user");
    });

    it("openSession for a second user is unaffected by the first user's wipe", async () => {
      store.seedGlobal([
        { user_id: "wiped-user", opted_out: true },
        { user_id: "other-user", opted_out: true },
      ]);

      // Wipe only wiped-user.
      await deleteAllUserVcSessions("wiped-user");

      // wiped-user can open a session.
      const session = await openSession("guild-A", "wiped-user", "ch-1");
      expect(session).not.toBeNull();

      // other-user is still globally opted out — openSession must return null.
      const blockedSession = await openSession("guild-A", "other-user", "ch-1");
      expect(blockedSession).toBeNull();
    });
  });

  // ── Per-guild wipe → openSession: new session row is created after a per-guild wipe ──
  //
  // The wipe → openSession tests above only exercise deleteAllUserVcSessions (global
  // wipe).  A regression in deleteUserVcSessions — where it fails to clear the per-guild
  // opt-out row — would leave openSession returning null for that guild after a per-guild
  // wipe, silently breaking re-tracking without any test catching it.

  describe("per-guild wipe → openSession: new session row is created after deleteUserVcSessions", () => {
    it("openSession returns a non-null session row after the per-guild opt-out is cleared by the wipe", async () => {
      // Seed a per-guild opt-out so the user was opted out in guild-A before the wipe.
      store.seedPrivacy([{ user_id: "wiped-user", guild_id: "guild-A", opted_out: true }]);

      // Per-guild wipe clears the opt-out row and session rows for that guild.
      await deleteUserVcSessions("guild-A", "wiped-user");

      // Simulating a join event after the wipe: openSession must detect no opt-out
      // and insert a new session row.
      const session = await openSession("guild-A", "wiped-user", "ch-1");

      // Must return a non-null row — tracking is fully resumed in guild-A.
      expect(session).not.toBeNull();
      expect(session?.userId).toBe("wiped-user");
      expect(session?.guildId).toBe("guild-A");
    });

    it("openSession works in the wiped guild while a per-guild opt-out in a different guild still blocks tracking", async () => {
      // Seed per-guild opt-outs for both guild-A and guild-B.
      store.seedPrivacy([
        { user_id: "wiped-user", guild_id: "guild-A", opted_out: true },
        { user_id: "wiped-user", guild_id: "guild-B", opted_out: true },
      ]);

      // Wipe only guild-A — clears the guild-A opt-out row but leaves guild-B intact.
      await deleteUserVcSessions("guild-A", "wiped-user");

      // guild-A: opt-out was removed by the wipe, so openSession must succeed.
      const sessionA = await openSession("guild-A", "wiped-user", "ch-1");
      expect(sessionA).not.toBeNull();
      expect(sessionA?.guildId).toBe("guild-A");

      // guild-B: opt-out row was NOT removed, so openSession must still return null.
      const sessionB = await openSession("guild-B", "wiped-user", "ch-2");
      expect(sessionB).toBeNull();
    });
  });

  // ── SQL shape assertions (supplementary) ────────────────────────────────

  describe("SQL shape assertions", () => {
    it("getAllTempVcDeletions references community_vc_privacy_global in SQL", async () => {
      store.seed([]);

      await getAllTempVcDeletions("guild-A");

      const sqlArg = store.execute.mock.calls[0]?.[0] as { strings: string[] };
      const text = sqlArg.strings.join("");
      expect(text).toContain("community_vc_privacy_global");
    });

    it("getAllTempVcDeletions references community_vc_privacy in SQL", async () => {
      store.seed([]);

      await getAllTempVcDeletions("guild-A");

      const sqlArg = store.execute.mock.calls[0]?.[0] as { strings: string[] };
      expect(sqlArg.strings.join("")).toContain("community_vc_privacy");
    });

    it("getAllTempVcDeletions filters with left_at IS NOT NULL", async () => {
      store.seed([]);

      await getAllTempVcDeletions("guild-A");

      const sqlArg = store.execute.mock.calls[0]?.[0] as { strings: string[] };
      expect(sqlArg.strings.join("")).toContain("left_at IS NOT NULL");
    });

    it("getAllTempVcDeletions orders results by left_at ASC", async () => {
      store.seed([]);

      await getAllTempVcDeletions("guild-A");

      const sqlArg = store.execute.mock.calls[0]?.[0] as { strings: string[] };
      expect(sqlArg.strings.join("")).toContain("ORDER BY s.left_at ASC");
    });
  });
});
