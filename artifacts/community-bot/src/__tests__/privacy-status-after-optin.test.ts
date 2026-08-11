/**
 * Integration-level tests confirming that the `/privacy status` logic reports
 * "active" immediately after `handlePrivacyOptin` is called.
 *
 * Key scenario: both the global and per-guild opt-out rows are absent before
 * opt-in (clean slate / never set).  After the handler writes `optedOut=false`
 * into both tables, the status check functions must read back the updated rows
 * and return false — NOT treat an absent-then-written row as opted-out.
 *
 * The DB mock here is stateful: `insert/onConflictDoUpdate` actually writes to
 * in-memory Maps, and `select/from/where` reads from those Maps, so the two
 * operations are coupled just as they would be against a real database.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist stateful mock state ────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  // In-memory stores that survive across insert→select within a single test.
  const globalStore  = new Map<string, boolean>();          // userId → optedOut
  const privacyStore = new Map<string, boolean>();          // `${guildId}:${userId}` → optedOut

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

  const reset = () => {
    globalStore.clear();
    privacyStore.clear();
  };

  // ── Stateful insert ────────────────────────────────────────────────────────
  // When `setVcGlobalPrivacyOptOut` or `setVcPrivacyOptOut` runs, the
  // `onConflictDoUpdate` handler writes the `set.optedOut` value into the
  // corresponding in-memory map so subsequent selects see the updated state.
  const insert = vi.fn((table: unknown) => ({
    values: vi.fn((row: Record<string, unknown>) => ({
      onConflictDoUpdate: vi.fn(({ set }: { set: Record<string, unknown> }) => {
        if (table === tables.global) {
          globalStore.set(row["userId"] as string, set["optedOut"] as boolean);
        } else if (table === tables.privacy) {
          const key = `${row["guildId"]}:${row["userId"]}`;
          privacyStore.set(key, set["optedOut"] as boolean);
        }
        return Promise.resolve([]);
      }),
      returning: vi.fn().mockResolvedValue([]),
    })),
  }));

  // ── Stateful select ────────────────────────────────────────────────────────
  // The drizzle-orm mock (below) makes `eq(col, val)` return `{ op, col, val }`
  // and `and(...args)` return `{ op, args }`.  We parse those shapes here to
  // extract the lookup key and read from the in-memory Maps.
  const select = vi.fn(() => ({
    from: vi.fn((table: unknown) => ({
      where: vi.fn((condition: unknown): Promise<Record<string, unknown>[]> => {
        type EqCond  = { op: "eq";  col: string; val: unknown };
        type AndCond = { op: "and"; args: EqCond[] };
        type Cond    = EqCond | AndCond;

        const cond = condition as Cond;

        if (table === tables.global) {
          // isVcTrackingGloballyOptedOut: eq(global.userId, userId)
          const userId = (cond as EqCond).val as string;
          const optedOut = globalStore.get(userId);
          return Promise.resolve(
            optedOut !== undefined ? [{ userId, optedOut }] : [],
          );
        }

        if (table === tables.privacy) {
          // isVcTrackingGuildLocalOptedOut: and(eq(privacy.guildId, guildId), eq(privacy.userId, userId))
          const args = (cond as AndCond).args;
          const guildId = args.find((a) => (a.col as string).includes("guildId"))?.val as string ?? "";
          const userId  = args.find((a) => (a.col as string).includes("userId"))?.val  as string ?? "";
          const key = `${guildId}:${userId}`;
          const optedOut = privacyStore.get(key);
          return Promise.resolve(
            optedOut !== undefined ? [{ guildId, userId, optedOut }] : [],
          );
        }

        return Promise.resolve([]);
      }),
    })),
  }));

  const update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([]),
      })),
    })),
  }));

  // ── db.transaction mock ───────────────────────────────────────────────────
  // Passes the same stateful `insert` as the `tx` object so that writes inside
  // the transaction callback land in globalStore / privacyStore just like bare
  // db.insert calls do.  On success the callback's writes are already committed
  // (the stores are mutated in-place); on throw the callback throws naturally.
  const transaction = vi.fn(async (cb: (tx: { insert: typeof insert }) => Promise<void>) => {
    await cb({ insert });
  });

  return { insert, select, update, transaction, tables, globalStore, privacyStore, reset };
});

// ─── Mock @workspace/db ───────────────────────────────────────────────────────
vi.mock("@workspace/db", () => ({
  db: {
    insert:      mocks.insert,
    select:      mocks.select,
    update:      mocks.update,
    transaction: mocks.transaction,
    execute:     vi.fn().mockResolvedValue({ rows: [] }),
    delete:      vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })) })),
  },
  communityVcPrivacyGlobalTable:    mocks.tables.global,
  communityVcPrivacyTable:          mocks.tables.privacy,
  communityVcSessionsTable:         mocks.tables.sessions,
  communityEventSettingsTable:      mocks.tables.eventSettings,
  communityEventsTable:             mocks.tables.events,
  communityEventParticipantsTable:  mocks.tables.eventParticipants,
  communityTicketSettingsTable:     mocks.tables.ticketSettings,
  communityTicketsTable:            mocks.tables.tickets,
  communityTicketPanelsTable:       mocks.tables.ticketPanels,
  communityRankingSettingsTable:    mocks.tables.rankingSettings,
  communityRoleButtonsTable:        mocks.tables.roleButtons,
}));

// ─── Mock discord.js ─────────────────────────────────────────────────────────
// EmbedBuilder instances track their own _color and _fields so tests can
// inspect the exact embed handed to editReply without re-implementing the logic.
vi.mock("discord.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("discord.js")>();
  return {
    ...actual,
    EmbedBuilder: vi.fn().mockImplementation(() => {
      const self: {
        _color: number | undefined;
        _fields: { name: string; value: string; inline?: boolean }[];
        setTitle: ReturnType<typeof vi.fn>;
        setColor: ReturnType<typeof vi.fn>;
        setDescription: ReturnType<typeof vi.fn>;
        addFields: ReturnType<typeof vi.fn>;
        setFooter: ReturnType<typeof vi.fn>;
        setTimestamp: ReturnType<typeof vi.fn>;
        data: Record<string, unknown>;
      } = {
        _color: undefined,
        _fields: [],
        setTitle:       vi.fn().mockReturnThis(),
        setColor:       vi.fn((color: number) => { self._color = color; return self; }),
        setDescription: vi.fn().mockReturnThis(),
        addFields:      vi.fn((...fields: { name: string; value: string; inline?: boolean }[]) => {
          self._fields.push(...fields);
          return self;
        }),
        setFooter:      vi.fn().mockReturnThis(),
        setTimestamp:   vi.fn().mockReturnThis(),
        data: {},
      };
      return self;
    }),
    ActionRowBuilder: vi.fn().mockImplementation(() => ({
      addComponents: vi.fn().mockReturnThis(),
    })),
    ButtonBuilder: vi.fn().mockImplementation(() => ({
      setCustomId: vi.fn().mockReturnThis(),
      setLabel:    vi.fn().mockReturnThis(),
      setStyle:    vi.fn().mockReturnThis(),
      setDisabled: vi.fn().mockReturnThis(),
    })),
  };
});

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
  notInArray: (col: unknown, vals: unknown) => ({ op: "notInArray", col, vals }),
  asc:        (col: unknown) => ({ op: "asc", col }),
  desc:       (col: unknown) => ({ op: "desc", col }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: "sql", strings: Array.from(strings), values }),
    { raw: (v: unknown) => ({ op: "sql.raw", v }) },
  ),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────
import { handlePrivacyOptin, commands } from "../commands/index.js";
import {
  isVcTrackingGloballyOptedOut,
  isVcTrackingGuildLocalOptedOut,
  isVcTrackingOptedOut,
} from "../lib/community.js";

// ─── Interaction factories ────────────────────────────────────────────────────
function makeInteraction(opts: { userId?: string; guildId?: string } = {}) {
  const { userId = "user-001", guildId = "guild-001" } = opts;
  return {
    user:              { id: userId, tag: "TestUser#0001" },
    guildId,
    memberPermissions: null,
    deferReply:        vi.fn().mockResolvedValue(undefined),
    editReply:         vi.fn().mockResolvedValue(undefined),
    reply:             vi.fn().mockResolvedValue(undefined),
    options:           { getSubcommand: vi.fn().mockReturnValue("optin") },
  };
}

function makeStatusInteraction(opts: { userId?: string; guildId?: string } = {}) {
  const { userId = "user-001", guildId = "guild-001" } = opts;
  return {
    user:              { id: userId, tag: "TestUser#0001" },
    guildId,
    memberPermissions: null,
    deferReply:        vi.fn().mockResolvedValue(undefined),
    editReply:         vi.fn().mockResolvedValue(undefined),
    reply:             vi.fn().mockResolvedValue(undefined),
    options: {
      getSubcommand: vi.fn().mockReturnValue("status"),
      getBoolean:    vi.fn().mockReturnValue(null),
      getChannel:    vi.fn().mockReturnValue(null),
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("privacy status check after handlePrivacyOptin — stateful DB mock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset(); // wipe both in-memory stores before each test
  });

  // ── Core scenario: absent rows before opt-in ────────────────────────────────

  it("isVcTrackingGloballyOptedOut returns false immediately after opt-in (no prior row)", async () => {
    const userId  = "user-status-001";
    const guildId = "guild-status-001";

    await handlePrivacyOptin(makeInteraction({ userId, guildId }) as never);

    const result = await isVcTrackingGloballyOptedOut(userId);
    expect(result).toBe(false);
  });

  it("isVcTrackingGuildLocalOptedOut returns false immediately after opt-in (no prior row)", async () => {
    const userId  = "user-status-002";
    const guildId = "guild-status-002";

    await handlePrivacyOptin(makeInteraction({ userId, guildId }) as never);

    const result = await isVcTrackingGuildLocalOptedOut(guildId, userId);
    expect(result).toBe(false);
  });

  it("isVcTrackingOptedOut returns false immediately after opt-in (both rows absent initially)", async () => {
    const userId  = "user-status-003";
    const guildId = "guild-status-003";

    // Neither global nor per-guild row existed before opt-in
    await handlePrivacyOptin(makeInteraction({ userId, guildId }) as never);

    const result = await isVcTrackingOptedOut(guildId, userId);
    expect(result).toBe(false);
  });

  // ── Status embed content (via real privacyCommand.execute) ─────────────────

  it("privacyCommand.execute status sends 🟢 embed (color 0x57f287) after opt-in when both rows were absent", async () => {
    const userId  = "user-status-embed";
    const guildId = "guild-status-embed";

    // Opt in (both rows absent before)
    await handlePrivacyOptin(makeInteraction({ userId, guildId }) as never);

    // Run the real status execute path through the exported commands list
    const privacyCommand = commands.find((c) => c.data.name === "privacy");
    if (!privacyCommand) throw new Error("privacy command not found in commands array");

    const statusInteraction = makeStatusInteraction({ userId, guildId });
    await privacyCommand.execute(statusInteraction as never);

    // editReply must have been called with an embed
    expect(statusInteraction.editReply).toHaveBeenCalledOnce();
    const call = statusInteraction.editReply.mock.calls[0][0] as { embeds: { _color: number; _fields: { name: string; value: string }[] }[] };
    const embed = call.embeds[0];

    // Color must be green (not opted-out)
    expect(embed._color).toBe(0x57f287);

    // VCトラッキング field value must contain 🟢
    const trackingField = embed._fields.find((f) => f.name === "VCトラッキング");
    expect(trackingField).toBeDefined();
    expect(trackingField!.value).toMatch(/🟢/);
  });

  // ── Per-user / per-guild isolation ─────────────────────────────────────────

  it("status for user A does not affect status for user B in the same guild", async () => {
    const guildId = "guild-isolation";
    const userA   = "user-A";
    const userB   = "user-B";

    // Only opt in user A
    await handlePrivacyOptin(makeInteraction({ userId: userA, guildId }) as never);

    const [aGlobal, aGuild] = await Promise.all([
      isVcTrackingGloballyOptedOut(userA),
      isVcTrackingGuildLocalOptedOut(guildId, userA),
    ]);
    // User B's store entries are absent — treated as not opted-out
    const [bGlobal, bGuild] = await Promise.all([
      isVcTrackingGloballyOptedOut(userB),
      isVcTrackingGuildLocalOptedOut(guildId, userB),
    ]);

    expect(aGlobal).toBe(false);
    expect(aGuild).toBe(false);
    expect(bGlobal).toBe(false); // absent row → not opted out
    expect(bGuild).toBe(false);  // absent row → not opted out
  });

  it("a second opt-in for the same user is idempotent — status still shows active", async () => {
    const userId  = "user-idempotent";
    const guildId = "guild-idempotent";
    const interaction = () => makeInteraction({ userId, guildId }) as never;

    await handlePrivacyOptin(interaction());
    await handlePrivacyOptin(interaction()); // second call

    const result = await isVcTrackingOptedOut(guildId, userId);
    expect(result).toBe(false);
  });

  // ── Per-guild opt-out only (global row absent) → opt-in ───────────────────

  it("isVcTrackingGloballyOptedOut returns false after opt-in when only the per-guild row was opted-out (global row absent)", async () => {
    const userId  = "user-guild-only-001";
    const guildId = "guild-guild-only-001";

    // Seed per-guild opt-out; global store remains empty
    mocks.privacyStore.set(`${guildId}:${userId}`, true);

    // Sanity-check: guild is opted out, global is not set (absent → not opted out)
    expect(await isVcTrackingGuildLocalOptedOut(guildId, userId)).toBe(true);
    expect(await isVcTrackingGloballyOptedOut(userId)).toBe(false);

    // User runs /privacy optin
    await handlePrivacyOptin(makeInteraction({ userId, guildId }) as never);

    expect(await isVcTrackingGloballyOptedOut(userId)).toBe(false);
  });

  it("isVcTrackingGuildLocalOptedOut returns false after opt-in when only the per-guild row was opted-out (global row absent)", async () => {
    const userId  = "user-guild-only-002";
    const guildId = "guild-guild-only-002";

    // Seed per-guild opt-out; global store remains empty
    mocks.privacyStore.set(`${guildId}:${userId}`, true);

    expect(await isVcTrackingGuildLocalOptedOut(guildId, userId)).toBe(true);

    await handlePrivacyOptin(makeInteraction({ userId, guildId }) as never);

    expect(await isVcTrackingGuildLocalOptedOut(guildId, userId)).toBe(false);
  });

  it("privacyCommand.execute status sends 🟢 embed (color 0x57f287) after opt-in when only the per-guild opt-out was set (global row absent)", async () => {
    const userId  = "user-guild-only-embed";
    const guildId = "guild-guild-only-embed";

    // Per-guild opted out, global row absent — this is the key edge case
    mocks.privacyStore.set(`${guildId}:${userId}`, true);

    // Confirm initial state: guild opted out, global absent (not opted out)
    expect(await isVcTrackingGuildLocalOptedOut(guildId, userId)).toBe(true);
    expect(await isVcTrackingGloballyOptedOut(userId)).toBe(false);

    // User opts back in
    await handlePrivacyOptin(makeInteraction({ userId, guildId }) as never);

    // Now run the real /privacy status execute path
    const privacyCommand = commands.find((c) => c.data.name === "privacy");
    if (!privacyCommand) throw new Error("privacy command not found in commands array");

    const statusInteraction = makeStatusInteraction({ userId, guildId });
    await privacyCommand.execute(statusInteraction as never);

    // editReply must have been called with an embed
    expect(statusInteraction.editReply).toHaveBeenCalledOnce();
    const call = statusInteraction.editReply.mock.calls[0][0] as { embeds: { _color: number; _fields: { name: string; value: string }[] }[] };
    const embed = call.embeds[0];

    // Color must be green — effectivelyOptedOut must be false
    expect(embed._color).toBe(0x57f287);

    // VCトラッキング field value must contain 🟢
    const trackingField = embed._fields.find((f) => f.name === "VCトラッキング");
    expect(trackingField).toBeDefined();
    expect(trackingField!.value).toMatch(/🟢/);
  });

  // ── Opt-out → opt-in round-trip ────────────────────────────────────────────

  it("status is active after opt-in that follows an earlier opt-out write", async () => {
    const userId  = "user-roundtrip";
    const guildId = "guild-roundtrip";

    // Simulate a prior opt-out by writing directly to the in-memory stores
    mocks.globalStore.set(userId, true);
    mocks.privacyStore.set(`${guildId}:${userId}`, true);

    // Verify opted-out before the handler call
    expect(await isVcTrackingOptedOut(guildId, userId)).toBe(true);

    // Now the user runs /privacy optin
    await handlePrivacyOptin(makeInteraction({ userId, guildId }) as never);

    // Status must now be active
    const [globalOptedOut, guildOptedOut] = await Promise.all([
      isVcTrackingGloballyOptedOut(userId),
      isVcTrackingGuildLocalOptedOut(guildId, userId),
    ]);
    expect(globalOptedOut).toBe(false);
    expect(guildOptedOut).toBe(false);
    expect(await isVcTrackingOptedOut(guildId, userId)).toBe(false);
  });
});
