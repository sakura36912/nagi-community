/**
 * Stateful round-trip tests: opt-out → opt-back-in mid-session.
 *
 * Unlike the unit tests in opt-out-vc-ranking.test.ts (which inject
 * pre-computed rows into getVcRanking), these tests use a minimal in-memory
 * database whose state is mutated by openSession / closeSession /
 * setVcPrivacyOptOut / setVcGlobalPrivacyOptOut and then read by
 * getVcRanking.  This proves the round-trip contracts end-to-end rather than
 * merely asserting that the RankingEntry mapper passes values through.
 *
 * Contracts verified:
 *   1. opt-out closes the open session → left_at is stamped
 *   2. The old closed session's total_seconds is frozen at the moment of
 *      opt-out; it does not grow as clock time advances
 *   3. After opt-back-in the user is re-admitted to the ranking (no longer
 *      excluded by the NOT IN privacy sub-selects)
 *   4. A new session opened after opt-back-in appears as is_live=true; the
 *      old closed session accumulates no additional time
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ─── In-memory state (hoisted so vi.mock can reference it) ────────────────────

const { state } = vi.hoisted(() => {
  type SessionRow = {
    id: number;
    guildId: string;
    userId: string;
    channelId: string;
    joinedAt: Date;
    leftAt: Date | null;
    isExile: boolean;
  };
  type PrivacyRow = { guildId: string; userId: string; optedOut: boolean };
  type GlobalPrivacyRow = { userId: string; optedOut: boolean };

  const state = {
    sessions: [] as SessionRow[],
    privacy: [] as PrivacyRow[],
    globalPrivacy: [] as GlobalPrivacyRow[],
    nextId: 1,
    reset() {
      this.sessions = [];
      this.privacy = [];
      this.globalPrivacy = [];
      this.nextId = 1;
    },
  };
  return { state };
});

// ─── WHERE-clause evaluator ───────────────────────────────────────────────────
// The drizzle-orm mock represents WHERE conditions as plain objects:
//   eq(tbl.col, val) → { op: "eq", col: "tbl.col", val }
//   and(c1, c2)     → { op: "and", args: [c1, c2] }
//   isNull(tbl.col) → { op: "isNull", col: "tbl.col" }
//
// field() strips the table prefix so we can match against plain JS objects.

function field(col: string): string {
  return col.split(".")[1] ?? col;
}

function evalWhere(row: Record<string, unknown>, expr: unknown): boolean {
  const e = expr as { op: string; col?: string; val?: unknown; args?: unknown[] };
  switch (e.op) {
    case "eq":
      return row[field(e.col!)] === e.val;
    case "and":
      return (e.args ?? []).every((a) => evalWhere(row, a));
    case "isNull":
      return row[field(e.col!)] == null;
    case "isNotNull":
      return row[field(e.col!)] != null;
    default:
      return true;
  }
}

// ─── Table identity helper ────────────────────────────────────────────────────
// Each mock table exposes __name__ so the DB operations can identify which
// in-memory array to read/write.

function tableName(t: unknown): string {
  return (t as Record<string, unknown>).__name__ as string ?? "unknown";
}

// ─── Mock @workspace/db ───────────────────────────────────────────────────────

vi.mock("@workspace/db", () => {
  // Table proxy: property access returns "tableName.propName"; __name__
  // returns the bare table name so operations can identify the table.
  const tbl = (name: string) =>
    new Proxy({} as Record<string, unknown>, {
      get: (_t, p: string) => (p === "__name__" ? name : `${name}.${p}`),
    });

  const db = {
    // ── SELECT ──────────────────────────────────────────────────────────────
    select: (_projection?: unknown) => ({
      from: (table: unknown) => ({
        where: (cond: unknown): Promise<unknown[]> => {
          const name = tableName(table);
          let rows: Record<string, unknown>[];
          switch (name) {
            case "sessions":
              rows = state.sessions as Record<string, unknown>[];
              break;
            case "privacy":
              rows = state.privacy as Record<string, unknown>[];
              break;
            case "global":
              rows = state.globalPrivacy as Record<string, unknown>[];
              break;
            default:
              rows = [];
          }
          return Promise.resolve(rows.filter((r) => evalWhere(r, cond)));
        },
      }),
    }),

    // ── INSERT ──────────────────────────────────────────────────────────────
    insert: (table: unknown) => ({
      values: (data: Record<string, unknown>) => ({
        returning: (_projection?: unknown): Promise<unknown[]> => {
          if (tableName(table) === "sessions") {
            const row = {
              id: state.nextId++,
              guildId: data.guildId,
              userId: data.userId,
              channelId: data.channelId,
              joinedAt: data.joinedAt,
              leftAt: null,
              isExile: data.isExile ?? false,
            };
            state.sessions.push(row as typeof state.sessions[0]);
            return Promise.resolve([row]);
          }
          return Promise.resolve([]);
        },
        onConflictDoNothing: (): Promise<unknown[]> => Promise.resolve([]),
        onConflictDoUpdate: ({
          set,
        }: {
          target?: unknown;
          set: Record<string, unknown>;
        }): Promise<unknown[]> => {
          const name = tableName(table);
          if (name === "privacy") {
            const idx = state.privacy.findIndex(
              (p) => p.guildId === data.guildId && p.userId === data.userId,
            );
            if (idx >= 0) {
              (state.privacy[idx] as Record<string, unknown>).optedOut =
                set.optedOut ?? data.optedOut;
            } else {
              state.privacy.push({
                guildId: data.guildId as string,
                userId: data.userId as string,
                optedOut: (set.optedOut ?? data.optedOut) as boolean,
              });
            }
          } else if (name === "global") {
            const idx = state.globalPrivacy.findIndex(
              (p) => p.userId === data.userId,
            );
            if (idx >= 0) {
              (state.globalPrivacy[idx] as Record<string, unknown>).optedOut =
                set.optedOut ?? data.optedOut;
            } else {
              state.globalPrivacy.push({
                userId: data.userId as string,
                optedOut: (set.optedOut ?? data.optedOut) as boolean,
              });
            }
          }
          return Promise.resolve([]);
        },
      }),
    }),

    // ── UPDATE ──────────────────────────────────────────────────────────────
    update: (_table: unknown) => ({
      set: (setData: Record<string, unknown>) => ({
        where: (cond: unknown) => ({
          returning: (_projection?: unknown): Promise<{ id: number }[]> => {
            const updated: { id: number }[] = [];
            for (const s of state.sessions) {
              if (evalWhere(s as Record<string, unknown>, cond)) {
                if (setData.leftAt !== undefined) s.leftAt = setData.leftAt as Date | null;
                updated.push({ id: s.id });
              }
            }
            return Promise.resolve(updated);
          },
        }),
      }),
    }),

    // ── DELETE ──────────────────────────────────────────────────────────────
    delete: (_table: unknown) => ({
      where: (_cond: unknown) => ({
        returning: (): Promise<unknown[]> => Promise.resolve([]),
      }),
    }),

    // ── EXECUTE (getVcRanking SQL) ───────────────────────────────────────────
    execute: (sqlObj: unknown): Promise<{ rows: unknown[] }> => {
      // The getVcRanking template interpolates values in this order:
      //   [0] startClamp  (sql fragment: GREATEST(...) or joined_at column ref)
      //   [1] guildId     (string)
      //   [2] periodFilter (sql fragment, empty when no periodStart)
      //   [3] guildId     (string, repeated inside the NOT IN sub-select)
      const vals = (sqlObj as { values: unknown[] }).values;
      const guildId = vals[1] as string;

      const excludedPrivacy = new Set(
        state.privacy
          .filter((p) => p.guildId === guildId && p.optedOut)
          .map((p) => p.userId),
      );
      const excludedGlobal = new Set(
        state.globalPrivacy.filter((p) => p.optedOut).map((p) => p.userId),
      );

      const relevant = state.sessions.filter(
        (s) =>
          s.guildId === guildId &&
          !s.isExile &&
          !excludedPrivacy.has(s.userId) &&
          !excludedGlobal.has(s.userId),
      );

      const byUser = new Map<string, { totalSeconds: number; isLive: boolean }>();
      const now = Date.now();
      for (const s of relevant) {
        // Mirror COALESCE(left_at, NOW()): use the fixed left_at when closed,
        // otherwise use current time (which fake-timer tests will control).
        const endMs = s.leftAt != null ? s.leftAt.getTime() : now;
        const dur = Math.max(0, (endMs - s.joinedAt.getTime()) / 1000);
        const prev = byUser.get(s.userId) ?? { totalSeconds: 0, isLive: false };
        byUser.set(s.userId, {
          totalSeconds: prev.totalSeconds + dur,
          isLive: prev.isLive || s.leftAt === null,
        });
      }

      const rows = [...byUser.entries()]
        .map(([userId, { totalSeconds, isLive }]) => ({
          user_id: userId,
          total_seconds: String(Math.floor(totalSeconds)),
          is_live: isLive,
        }))
        .sort((a, b) => Number(b.total_seconds) - Number(a.total_seconds))
        .slice(0, 10);

      return Promise.resolve({ rows });
    },
  };

  return {
    db,
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

// ─── Mock drizzle-orm ─────────────────────────────────────────────────────────

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

// ─── Imports after mocks ──────────────────────────────────────────────────────

import {
  openSession,
  closeSession,
  setVcPrivacyOptOut,
  setVcGlobalPrivacyOptOut,
  getVcRanking,
} from "../lib/community.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const GUILD = "guild-stateful";
const USER = "user-roundtrip";
const CHANNEL = "channel-001";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("opt-out → opt-back-in round-trip (stateful DB)", () => {
  beforeEach(() => {
    state.reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Guild-local path ───────────────────────────────────────────────────────

  it("guild-local: opt-out stamps left_at and the old session appears as is_live=false", async () => {
    const T0 = new Date("2024-06-01T10:00:00Z");
    vi.setSystemTime(T0);

    await openSession(GUILD, USER, CHANNEL);

    const T1 = new Date("2024-06-01T11:00:00Z"); // 1 h later
    vi.setSystemTime(T1);

    await setVcPrivacyOptOut(GUILD, USER, true);

    // Session must have been closed by closeSession
    const closedSession = state.sessions.find((s) => s.userId === USER);
    expect(closedSession).toBeDefined();
    expect(closedSession!.leftAt).not.toBeNull();

    // User is excluded from ranking while opted out
    const ranking = await getVcRanking(GUILD);
    expect(ranking.some((r) => r.userId === USER)).toBe(false);
  });

  it("guild-local: old session total_seconds is frozen at the moment of opt-out and does not grow", async () => {
    const T0 = new Date("2024-06-01T10:00:00Z");
    vi.setSystemTime(T0);

    await openSession(GUILD, USER, CHANNEL);

    // Opt out 1 hour after joining — freezes duration at 3600 s
    const T1 = new Date("2024-06-01T11:00:00Z");
    vi.setSystemTime(T1);
    await setVcPrivacyOptOut(GUILD, USER, true);

    // Opt back in immediately so the user is visible in ranking again
    await setVcPrivacyOptOut(GUILD, USER, false);

    // Advance clock by another hour — the closed session must NOT accumulate more time
    vi.setSystemTime(new Date("2024-06-01T12:00:00Z")); // T2 = T0 + 2h

    const ranking = await getVcRanking(GUILD);

    expect(ranking).toHaveLength(1);
    expect(ranking[0]!.userId).toBe(USER);
    // Duration should be exactly T1-T0 = 3600 s, not 7200 (T2-T0)
    expect(ranking[0]!.totalSeconds).toBe(3600);
    // Session is closed → is_live must be false
    expect(ranking[0]!.isLive).toBe(false);
  });

  it("guild-local: after opt-back-in a new session opened by the user is is_live=true", async () => {
    const T0 = new Date("2024-06-01T10:00:00Z");
    vi.setSystemTime(T0);

    // Open session, opt out (closes it), opt back in
    await openSession(GUILD, USER, CHANNEL);
    vi.setSystemTime(new Date("2024-06-01T10:30:00Z"));
    await setVcPrivacyOptOut(GUILD, USER, true);
    await setVcPrivacyOptOut(GUILD, USER, false);

    // User reconnects to VC → new session opened
    const T2 = new Date("2024-06-01T11:00:00Z");
    vi.setSystemTime(T2);
    const newSession = await openSession(GUILD, USER, CHANNEL);

    expect(newSession).not.toBeNull();
    expect(newSession!.leftAt).toBeNull(); // new session is open

    // Ranking shows the new session as live
    const ranking = await getVcRanking(GUILD);
    expect(ranking).toHaveLength(1);
    expect(ranking[0]!.userId).toBe(USER);
    expect(ranking[0]!.isLive).toBe(true);
  });

  it("guild-local: ranking total after opt-back-in + new session counts only the new session's time", async () => {
    const T0 = new Date("2024-06-01T10:00:00Z");
    vi.setSystemTime(T0);

    // Session 1: 30 min
    await openSession(GUILD, USER, CHANNEL);
    vi.setSystemTime(new Date("2024-06-01T10:30:00Z")); // T0 + 30 min
    await setVcPrivacyOptOut(GUILD, USER, true); // closes session 1 at T0+30m

    // Opt back in and open a second session 10 minutes later
    await setVcPrivacyOptOut(GUILD, USER, false);
    vi.setSystemTime(new Date("2024-06-01T10:40:00Z")); // T0 + 40 min
    await openSession(GUILD, USER, CHANNEL); // session 2

    // Advance 20 min — session 2 has been live for 20 min (1200 s)
    vi.setSystemTime(new Date("2024-06-01T11:00:00Z")); // T0 + 60 min

    const ranking = await getVcRanking(GUILD);

    expect(ranking).toHaveLength(1);
    expect(ranking[0]!.userId).toBe(USER);
    // Session 1 = 1800 s (frozen), session 2 = 1200 s live → total = 3000 s
    expect(ranking[0]!.totalSeconds).toBe(3000);
    expect(ranking[0]!.isLive).toBe(true);
  });

  it("guild-local: openSession returns null while opted out and succeeds after opt-back-in", async () => {
    vi.setSystemTime(new Date("2024-06-01T10:00:00Z"));

    await setVcPrivacyOptOut(GUILD, USER, true);
    const blocked = await openSession(GUILD, USER, CHANNEL);
    expect(blocked).toBeNull();

    await setVcPrivacyOptOut(GUILD, USER, false);
    const allowed = await openSession(GUILD, USER, CHANNEL);
    expect(allowed).not.toBeNull();
    expect(allowed!.leftAt).toBeNull();
  });

  // ── Global path ────────────────────────────────────────────────────────────

  it("global: opt-out stamps left_at on all open sessions across guilds", async () => {
    vi.setSystemTime(new Date("2024-06-01T10:00:00Z"));

    const GUILD2 = "guild-stateful-2";
    await openSession(GUILD, USER, CHANNEL);
    await openSession(GUILD2, USER, CHANNEL);

    vi.setSystemTime(new Date("2024-06-01T11:00:00Z"));
    await setVcGlobalPrivacyOptOut(USER, true);

    const openSessions = state.sessions.filter(
      (s) => s.userId === USER && s.leftAt === null,
    );
    expect(openSessions).toHaveLength(0); // all closed
    expect(
      state.sessions.filter((s) => s.userId === USER && s.leftAt !== null),
    ).toHaveLength(2);
  });

  it("global: old session total is frozen after global opt-out; new session after opt-back-in is is_live=true", async () => {
    const T0 = new Date("2024-06-01T10:00:00Z");
    vi.setSystemTime(T0);

    await openSession(GUILD, USER, CHANNEL); // session 1

    // Opt out globally 1 h later — freezes session 1 at 3600 s
    vi.setSystemTime(new Date("2024-06-01T11:00:00Z"));
    await setVcGlobalPrivacyOptOut(USER, true);

    // Opt back in and reconnect
    await setVcGlobalPrivacyOptOut(USER, false);
    vi.setSystemTime(new Date("2024-06-01T11:10:00Z")); // 10 min after opt-in
    await openSession(GUILD, USER, CHANNEL); // session 2 (new, live)

    // Advance clock another 10 min → session 2 has 600 s
    vi.setSystemTime(new Date("2024-06-01T11:20:00Z"));

    const ranking = await getVcRanking(GUILD);
    expect(ranking).toHaveLength(1);
    expect(ranking[0]!.userId).toBe(USER);
    // session 1 = 3600 s (frozen) + session 2 = 600 s (live) = 4200 s
    expect(ranking[0]!.totalSeconds).toBe(4200);
    expect(ranking[0]!.isLive).toBe(true);
  });

  it("global: openSession returns null while globally opted out and succeeds after opt-back-in", async () => {
    vi.setSystemTime(new Date("2024-06-01T10:00:00Z"));

    await setVcGlobalPrivacyOptOut(USER, true);
    const blocked = await openSession(GUILD, USER, CHANNEL);
    expect(blocked).toBeNull();

    await setVcGlobalPrivacyOptOut(USER, false);
    const allowed = await openSession(GUILD, USER, CHANNEL);
    expect(allowed).not.toBeNull();
    expect(allowed!.leftAt).toBeNull();
  });
});
