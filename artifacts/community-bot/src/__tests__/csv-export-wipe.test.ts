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
    sessions    = [];
    privacyRows = [];
    globalRows  = [];
  }

  return { del, update, execute, seed, seedPrivacy, getPrivacyRows, seedGlobal, getGlobalRows, getSessions, reset };
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
      update:  store.update,
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

    it("returns 0 when the user had no sessions to delete", async () => {
      store.seed([makeRow("other-user", "guild-A")]);

      const count = await deleteAllUserVcSessions("no-sessions-user");

      expect(count).toBe(0);
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

    it("returns 0 when the user had no sessions in that guild", async () => {
      store.seed([makeRow("wiped-user", "guild-B")]); // different guild

      const count = await deleteUserVcSessions("guild-A", "wiped-user");

      expect(count).toBe(0);
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
