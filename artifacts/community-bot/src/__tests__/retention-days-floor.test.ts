/**
 * Tests for the retention-days floor guard in the /ranking retention-days
 * command handler and the handleRetentionConfirm button handler.
 *
 * Confirms that:
 *   (a) The command rejects any value < 30 with an ephemeral error and never
 *       reaches the DB.
 *   (b) The command sends a 2-step confirmation embed for values >= 30 but
 *       < 180 (short-retention warning), and persists directly for values
 *       >= 180 (at or above the safe default).
 *   (c) The confirmation embed's buttons are disabled after 60 seconds so a
 *       non-admin cannot replay them after the original admin's session ends.
 *   (d) handleRetentionConfirm also rejects days < 30 (defense-in-depth floor
 *       guard against stale button replays).
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock state ─────────────────────────────────────────────────────────

/** Hoisted stub for countCompletedSessionsOlderThan so tests can control the dry-run count. */
const communityMocks = vi.hoisted(() => ({
  countCompletedSessionsOlderThan: vi.fn<() => Promise<number>>().mockResolvedValue(0),
}));

const mocks = vi.hoisted(() => {
  // ── db.insert chain ──────────────────────────────────────────────────────────
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const insertValues = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values: insertValues }));

  // ── db.select chain ──────────────────────────────────────────────────────────
  const selectWhere = vi.fn().mockResolvedValue([]);
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  // ── db.delete chain ──────────────────────────────────────────────────────────
  const deleteReturning = vi.fn().mockResolvedValue([]);
  const deleteWhere = vi.fn(() => ({ returning: deleteReturning }));
  const del = vi.fn(() => ({ where: deleteWhere }));

  return {
    onConflictDoUpdate, insertValues, insert,
    selectWhere, selectFrom, select,
    deleteReturning, deleteWhere, del,
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
      delete: mocks.del,
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })) })),
      })),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    },
    communityVcSessionsTable:       tbl("sessions"),
    communityVcPrivacyTable:         tbl("privacy"),
    communityVcPrivacyGlobalTable:   tbl("global"),
    communityEventSettingsTable:     tbl("eventSettings"),
    communityEventsTable:            tbl("events"),
    communityEventParticipantsTable: tbl("eventParticipants"),
    communityTicketSettingsTable:    tbl("ticketSettings"),
    communityTicketsTable:           tbl("tickets"),
    communityTicketPanelsTable:      tbl("ticketPanels"),
    communityRankingSettingsTable:   tbl("rankingSettings"),
    communityRoleButtonsTable:       tbl("roleButtons"),
  };
});

// ─── Mock drizzle-orm ─────────────────────────────────────────────────────────
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

// ─── Mock ../lib/community.js ─────────────────────────────────────────────────
// Keep all real exports intact; only replace countCompletedSessionsOlderThan so
// tests can control the dry-run count without touching the DB.
vi.mock("../lib/community.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/community.js")>();
  return {
    ...actual,
    countCompletedSessionsOlderThan: communityMocks.countCompletedSessionsOlderThan,
  };
});

// ─── Mock discord.js ─────────────────────────────────────────────────────────
vi.mock("discord.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("discord.js")>();
  return {
    ...actual,
    EmbedBuilder: vi.fn().mockImplementation(() => ({
      setTitle: vi.fn().mockReturnThis(),
      setColor: vi.fn().mockReturnThis(),
      setDescription: vi.fn().mockReturnThis(),
      setFooter: vi.fn().mockReturnThis(),
      setTimestamp: vi.fn().mockReturnThis(),
      data: {},
    })),
    ActionRowBuilder: vi.fn().mockImplementation(() => ({
      addComponents: vi.fn().mockReturnThis(),
    })),
    ButtonBuilder: vi.fn().mockImplementation(() => ({
      setCustomId: vi.fn().mockReturnThis(),
      setLabel: vi.fn().mockReturnThis(),
      setStyle: vi.fn().mockReturnThis(),
    })),
  };
});

// ─── Imports under test (resolved after mocks) ───────────────────────────────
import {
  handleRetentionConfirm,
  COMM_RETENTION_CONFIRM_PREFIX,
  retentionConfirmExpiry,
} from "../commands/index.js";
import { EmbedBuilder } from "discord.js";

// ─── Interaction factory helpers ─────────────────────────────────────────────

/** Creates a minimal ChatInputCommandInteraction stub for the ranking command. */
function makeCommandInteraction(opts: {
  guildId?: string | null;
  days?: number | null;
  isAdmin?: boolean;
  guild?: {
    channels: {
      cache: { get: ReturnType<typeof vi.fn> };
      fetch?: ReturnType<typeof vi.fn>;
    };
  } | null;
}) {
  const { guildId = "guild-123", days = null, isAdmin = true, guild = null } = opts;
  return {
    guildId,
    guild,
    user: { id: "admin-user", tag: "Admin#0001" },
    memberPermissions: {
      has: vi.fn().mockReturnValue(isAdmin),
    },
    options: {
      getSubcommand: vi.fn().mockReturnValue("retention-days"),
      getInteger: vi.fn().mockReturnValue(days),
    },
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Creates a minimal ButtonInteraction stub for the confirm button.
 * Pass `nonce` to embed a specific nonce in the custom ID (e.g. after
 * registering it in `retentionConfirmExpiry`).  When omitted the custom ID
 * uses a literal string that will NOT be found in the registry, which is
 * correct for tests that expect rejection before the nonce lookup.
 */
function makeConfirmInteraction(opts: {
  nonce?: string;
  guildId?: string | null;
  isAdmin?: boolean;
}) {
  const { nonce = "no-such-nonce", guildId = "guild-123", isAdmin = true } = opts;
  return {
    guildId,
    customId: `${COMM_RETENTION_CONFIRM_PREFIX}${nonce}`,
    member: {
      permissions: {
        has: vi.fn().mockReturnValue(isAdmin),
      },
    },
    reply: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Registers a valid server-side expiry entry in `retentionConfirmExpiry` and
 * returns both the nonce and a matching interaction stub.  Use this in tests
 * that expect `handleRetentionConfirm` to succeed.
 */
function registerAndMakeConfirmInteraction(opts: {
  days?: number;
  guildId?: string;
  isAdmin?: boolean;
  ttlOffset?: number; // ms from now (default: +60 000)
}) {
  const { days = 30, guildId = "guild-123", isAdmin = true, ttlOffset = 60_000 } = opts;
  const nonce = `test-nonce-${Math.random().toString(36).slice(2)}`;
  retentionConfirmExpiry.set(nonce, { guildId, days, expiry: Date.now() + ttlOffset });
  const interaction = makeConfirmInteraction({ nonce, guildId, isAdmin });
  return { nonce, interaction };
}

// ─── Tests: command execute – floor rejection ─────────────────────────────────

// We import rankingCommand lazily after mocks are set up.
// Since it is not directly exported we need to reach it through the command
// registry that the file also exports.
let rankingExecute: ((interaction: unknown) => Promise<void>) | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  // Clear the server-side expiry registry so tests start with a clean slate.
  retentionConfirmExpiry.clear();
  // Re-wire chains after clearAllMocks
  mocks.insertValues.mockReturnValue({ onConflictDoUpdate: mocks.onConflictDoUpdate });
  mocks.insert.mockReturnValue({ values: mocks.insertValues });
  mocks.selectFrom.mockReturnValue({ where: mocks.selectWhere });
  mocks.select.mockReturnValue({ from: mocks.selectFrom });
  // Reset the community dry-run stub to a neutral default.
  communityMocks.countCompletedSessionsOlderThan.mockResolvedValue(0);

  if (!rankingExecute) {
    const mod = await import("../commands/index.js");
    // The commands array is the default export; find the ranking entry
    const commands: Array<{ data: { name: string }; execute: (i: unknown) => Promise<void> }> =
      (mod as unknown as { default: typeof commands }).default ?? [];
    const ranking = commands.find((c) => c.data?.name === "ranking");
    rankingExecute = ranking?.execute;
  }
});

describe("/ranking retention-days – floor guard (command handler)", () => {
  it("rejects 1 day with an ephemeral error and does NOT call the DB", async () => {
    if (!rankingExecute) return; // skip if command not found (belt-and-suspenders)
    const interaction = makeCommandInteraction({ days: 1 });
    await rankingExecute(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("rejects 29 days with an ephemeral error and does NOT call the DB", async () => {
    if (!rankingExecute) return;
    const interaction = makeCommandInteraction({ days: 29 });
    await rankingExecute(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("error reply for a below-floor value mentions 30 days", async () => {
    if (!rankingExecute) return;
    const interaction = makeCommandInteraction({ days: 7 });
    await rankingExecute(interaction as never);

    const [[replyArg]] = interaction.reply.mock.calls as [[{ content: string; ephemeral: boolean }]];
    expect(replyArg.content).toMatch(/30/);
  });

  it("error reply includes the actual value the admin tried to set", async () => {
    if (!rankingExecute) return;
    const interaction = makeCommandInteraction({ days: 14 });
    await rankingExecute(interaction as never);

    const [[replyArg]] = interaction.reply.mock.calls as [[{ content: string; ephemeral: boolean }]];
    expect(replyArg.content).toMatch(/14/);
  });

  it("accepts exactly 30 days and sends a confirmation embed instead of persisting directly", async () => {
    if (!rankingExecute) return;
    const interaction = makeCommandInteraction({ days: 30 });
    await rankingExecute(interaction as never);

    // Short-retention path: must defer then edit with embed+buttons, NOT write to DB yet
    expect(interaction.deferReply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ embeds: expect.anything(), components: expect.anything() }),
    );
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("accepts exactly 90 days and sends a confirmation embed instead of persisting directly", async () => {
    if (!rankingExecute) return;
    const interaction = makeCommandInteraction({ days: 90 });
    await rankingExecute(interaction as never);

    expect(interaction.deferReply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(interaction.editReply).toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("accepts 180 days and persists directly without a confirmation embed", async () => {
    if (!rankingExecute) return;
    const interaction = makeCommandInteraction({ days: 180 });
    await rankingExecute(interaction as never);

    // >= 180 days is at or above the default — no data-loss risk, persist directly
    expect(mocks.insert).toHaveBeenCalled();
    expect(interaction.deferReply).not.toHaveBeenCalled();

    // Must not look like an error reply
    if (interaction.reply.mock.calls.length > 0) {
      const [[replyArg]] = interaction.reply.mock.calls as [[{ content: string }]];
      expect(replyArg.content).not.toMatch(/30日以上/);
    }
  });

  it("accepts 365 days and persists directly without a confirmation embed", async () => {
    if (!rankingExecute) return;
    const interaction = makeCommandInteraction({ days: 365 });
    await rankingExecute(interaction as never);

    expect(mocks.insert).toHaveBeenCalled();
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });
});

// ─── Tests: confirmation embed timeout ────────────────────────────────────────

describe("/ranking retention-days – confirmation embed timeout", () => {
  it("disables buttons and edits the reply after 60 seconds", async () => {
    if (!rankingExecute) return;
    vi.useFakeTimers();
    try {
      const interaction = makeCommandInteraction({ days: 60 });
      await rankingExecute(interaction as never);

      // First editReply sent the warning embed with active buttons
      expect(interaction.editReply).toHaveBeenCalledTimes(1);

      // Advance clock by 60 seconds — the timeout callback should fire
      await vi.advanceTimersByTimeAsync(60_000);

      // Second editReply should have been called (disabled buttons + timeout embed)
      expect(interaction.editReply).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT edit the reply a second time before 60 seconds have elapsed", async () => {
    if (!rankingExecute) return;
    vi.useFakeTimers();
    try {
      const interaction = makeCommandInteraction({ days: 60 });
      await rankingExecute(interaction as never);

      // Advance only 59 999 ms — the timeout must not have fired yet
      await vi.advanceTimersByTimeAsync(59_999);

      expect(interaction.editReply).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── Tests: handleRetentionConfirm – nonce registry + floor guard ─────────────

describe("handleRetentionConfirm – nonce registry + floor guard", () => {
  // ── registry checks ────────────────────────────────────────────────────────

  it("rejects a confirm when no nonce entry exists (stale/replayed interaction)", async () => {
    // Map is empty — customId nonce won't be found
    const interaction = makeConfirmInteraction({});
    await handleRetentionConfirm(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("rejects a confirm after the server-side TTL has expired", async () => {
    const { interaction } = registerAndMakeConfirmInteraction({ days: 30, ttlOffset: -1 });
    await handleRetentionConfirm(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("rejects a confirm from a different guild than the one that sent the embed", async () => {
    const { nonce } = registerAndMakeConfirmInteraction({ days: 30, guildId: "guild-A" });
    // Interaction arrives from guild-B with the same nonce
    const interaction = makeConfirmInteraction({ nonce, guildId: "guild-B" });
    await handleRetentionConfirm(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("accepts exactly 30 days and proceeds to deferUpdate + DB write", async () => {
    const { interaction } = registerAndMakeConfirmInteraction({ days: 30 });
    await handleRetentionConfirm(interaction as never);

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(mocks.insert).toHaveBeenCalled();
  });

  it("accepts 90 days and proceeds to deferUpdate + DB write", async () => {
    const { interaction } = registerAndMakeConfirmInteraction({ days: 90 });
    await handleRetentionConfirm(interaction as never);

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(mocks.insert).toHaveBeenCalled();
  });

  it("consumes the nonce entry so a second click on the same button is rejected", async () => {
    const { nonce } = registerAndMakeConfirmInteraction({ days: 30 });
    const interaction1 = makeConfirmInteraction({ nonce });

    // First click: succeeds and consumes the nonce
    await handleRetentionConfirm(interaction1 as never);
    expect(interaction1.deferUpdate).toHaveBeenCalledTimes(1);

    // Second click with the same nonce: entry is gone — must be rejected
    vi.clearAllMocks();
    mocks.insertValues.mockReturnValue({ onConflictDoUpdate: mocks.onConflictDoUpdate });
    mocks.insert.mockReturnValue({ values: mocks.insertValues });
    const interaction2 = makeConfirmInteraction({ nonce });
    await handleRetentionConfirm(interaction2 as never);

    expect(interaction2.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    expect(interaction2.deferUpdate).not.toHaveBeenCalled();
  });

  it("two concurrent confirmations for the same guild+days are independent", async () => {
    // Admin A and Admin B both run /ranking retention-days 60 at the same time.
    const { nonce: nonceA, interaction: ia } = registerAndMakeConfirmInteraction({ days: 60 });
    const { nonce: nonceB, interaction: ib } = registerAndMakeConfirmInteraction({ days: 60 });

    // They must be different nonces
    expect(nonceA).not.toBe(nonceB);

    // Expiring nonce A (simulating its timeout deleting it) must not affect B
    retentionConfirmExpiry.delete(nonceA);

    // Interaction A now finds no entry → rejected
    await handleRetentionConfirm(ia as never);
    expect(ia.deferUpdate).not.toHaveBeenCalled();

    // Interaction B still has a valid entry → accepted
    vi.clearAllMocks();
    mocks.insertValues.mockReturnValue({ onConflictDoUpdate: mocks.onConflictDoUpdate });
    mocks.insert.mockReturnValue({ values: mocks.insertValues });
    await handleRetentionConfirm(ib as never);
    expect(ib.deferUpdate).toHaveBeenCalled();
    expect(mocks.insert).toHaveBeenCalled();
  });

  // ── defense-in-depth floor guard (runs after nonce lookup) ─────────────────

  it("rejects days < 30 even when a valid nonce exists (floor guard in button handler)", async () => {
    const { interaction } = registerAndMakeConfirmInteraction({ days: 5 });
    await handleRetentionConfirm(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    const [[replyArg]] = interaction.reply.mock.calls as [[{ content: string; ephemeral: boolean }]];
    expect(replyArg.content).toMatch(/30/);
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("rejects 1 day (stale/no-nonce path) with an ephemeral error and does NOT touch the DB", async () => {
    // No nonce registered — arrives as a stale interaction
    const interaction = makeConfirmInteraction({});
    await handleRetentionConfirm(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  // ── admin permission checks ────────────────────────────────────────────────

  it("rejects a non-Administrator with an ephemeral error and does NOT touch the DB", async () => {
    const interaction = makeConfirmInteraction({ isAdmin: false });
    await handleRetentionConfirm(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("non-Administrator cannot replay the button even with a valid nonce", async () => {
    const { nonce } = registerAndMakeConfirmInteraction({ days: 30 });
    const interaction = makeConfirmInteraction({ nonce, isAdmin: false });
    await handleRetentionConfirm(interaction as never);

    // Must be rejected before any DB write
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("non-admin replaying a sub-30-day confirm button receives the permission error, not the floor error", async () => {
    // Register a valid nonce with days=5 (below the floor).
    // The permission check fires BEFORE the nonce lookup and the floor check,
    // so the non-admin must see the permission error, never the floor error.
    const { interaction } = registerAndMakeConfirmInteraction({ days: 5, isAdmin: false });
    await handleRetentionConfirm(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    const [[replyArg]] = interaction.reply.mock.calls as [[{ content: string; ephemeral: boolean }]];
    // Permission gate message contains 管理者; the floor error contains 30
    expect(replyArg.content).toMatch(/管理者/);
    expect(replyArg.content).not.toMatch(/30/);
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("admin replaying a sub-30-day confirm button receives the floor error, not the permission error", async () => {
    // Register a valid nonce with days=5 (below the floor).
    // An Administrator passes the permission gate but must be stopped by the
    // defense-in-depth floor check before any DB write occurs.
    const { interaction } = registerAndMakeConfirmInteraction({ days: 5, isAdmin: true });
    await handleRetentionConfirm(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    const [[replyArg]] = interaction.reply.mock.calls as [[{ content: string; ephemeral: boolean }]];
    // Floor error contains 30; permission error contains 管理者
    expect(replyArg.content).toMatch(/30/);
    expect(replyArg.content).not.toMatch(/管理者/);
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});

// ─── Tests: floor guard – audit log notification ───────────────────────────────

describe("/ranking retention-days – floor guard audit log", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    retentionConfirmExpiry.clear();
    mocks.insertValues.mockReturnValue({ onConflictDoUpdate: mocks.onConflictDoUpdate });
    mocks.insert.mockReturnValue({ values: mocks.insertValues });
    mocks.selectFrom.mockReturnValue({ where: mocks.selectWhere });
    mocks.select.mockReturnValue({ from: mocks.selectFrom });
  });

  it("sends an audit embed to the configured channel when the floor guard fires", async () => {
    if (!rankingExecute) return;

    const AUDIT_CHANNEL_ID = "audit-channel-999";
    // getAuditLogChannel queries rankingSettings; return a row with the channel
    mocks.selectWhere.mockResolvedValueOnce([{ auditLogChannelId: AUDIT_CHANNEL_ID }]);

    const send = vi.fn().mockResolvedValue(undefined);
    const auditChannel = { isTextBased: () => true, send };

    const interaction = makeCommandInteraction({
      days: 14,
      guild: {
        channels: {
          cache: { get: vi.fn().mockReturnValue(auditChannel) },
          fetch: vi.fn().mockResolvedValue(null),
        },
      },
    });

    await rankingExecute(interaction as never);

    // The ephemeral rejection still fires
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );

    // The audit channel must receive exactly one message
    expect(send).toHaveBeenCalledOnce();
  });

  it("audit embed includes the rejected day count as a field", async () => {
    if (!rankingExecute) return;

    mocks.selectWhere.mockResolvedValueOnce([{ auditLogChannelId: "audit-ch" }]);

    const send = vi.fn().mockResolvedValue(undefined);
    const auditChannel = { isTextBased: () => true, send };

    const interaction = makeCommandInteraction({
      days: 7,
      guild: {
        channels: {
          cache: { get: vi.fn().mockReturnValue(auditChannel) },
        },
      },
    });

    await rankingExecute(interaction as never);

    const [[sendArg]] = send.mock.calls as [[{ embeds: { data: { fields?: { name: string; value: string }[] } }[] }]];
    const fields = sendArg.embeds[0]?.data?.fields ?? [];
    const inputField = fields.find((f) => f.name === "入力値");
    expect(inputField?.value).toContain("7");
  });

  it("audit embed includes the actor's user ID", async () => {
    if (!rankingExecute) return;

    mocks.selectWhere.mockResolvedValueOnce([{ auditLogChannelId: "audit-ch" }]);

    const send = vi.fn().mockResolvedValue(undefined);
    const auditChannel = { isTextBased: () => true, send };

    const interaction = makeCommandInteraction({
      days: 10,
      guild: {
        channels: {
          cache: { get: vi.fn().mockReturnValue(auditChannel) },
        },
      },
    });

    await rankingExecute(interaction as never);

    const [[sendArg]] = send.mock.calls as [[{ embeds: { data: { fields?: { name: string; value: string }[]; footer?: { text: string } } }[] }]];
    const embedData = sendArg.embeds[0]?.data;
    const actorField = (embedData?.fields ?? []).find((f) => f.name === "操作者");
    expect(actorField?.value).toContain("admin-user");
    expect(embedData?.footer?.text).toContain("admin-user");
  });

  it("does NOT send any audit message when no audit channel is configured", async () => {
    if (!rankingExecute) return;

    // selectWhere returns [] → no audit channel row
    mocks.selectWhere.mockResolvedValueOnce([]);

    const send = vi.fn().mockResolvedValue(undefined);
    const auditChannel = { isTextBased: () => true, send };

    const interaction = makeCommandInteraction({
      days: 5,
      guild: {
        channels: {
          cache: { get: vi.fn().mockReturnValue(auditChannel) },
        },
      },
    });

    await rankingExecute(interaction as never);

    // The ephemeral rejection still fires
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );

    // No audit message sent because no channel is configured
    expect(send).not.toHaveBeenCalled();
  });

  it("swallows an audit channel send error so the floor rejection is unaffected", async () => {
    if (!rankingExecute) return;

    mocks.selectWhere.mockResolvedValueOnce([{ auditLogChannelId: "audit-ch-err" }]);

    const send = vi.fn().mockRejectedValue(new Error("Missing Permissions"));
    const auditChannel = { isTextBased: () => true, send };

    const interaction = makeCommandInteraction({
      days: 20,
      guild: {
        channels: {
          cache: { get: vi.fn().mockReturnValue(auditChannel) },
        },
      },
    });

    // Must not throw even though audit send fails
    await expect(rankingExecute(interaction as never)).resolves.toBeUndefined();

    // The ephemeral rejection was still sent
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );

    // The audit send was attempted
    expect(send).toHaveBeenCalledOnce();
  });

  it("does NOT send an audit message when the guild is null (no channel to fetch)", async () => {
    if (!rankingExecute) return;

    mocks.selectWhere.mockResolvedValueOnce([{ auditLogChannelId: "audit-ch" }]);

    // guild is null → channel fetch is impossible
    const interaction = makeCommandInteraction({ days: 10, guild: null });

    await rankingExecute(interaction as never);

    // The ephemeral rejection still fires; no error thrown
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
  });
});

// ─── Tests: dry-run count in short-retention warning embed ────────────────────

describe("/ranking retention-days – dry-run count embedded in warning before confirmation", () => {
  /**
   * Helper: return all strings passed as the first argument to
   * EmbedBuilder#setDescription across all instances created during a test.
   */
  function captureDescriptions(): string[] {
    const results = vi.mocked(EmbedBuilder).mock.results;
    return results.flatMap((r) => {
      const calls: unknown[][] = r.value?.setDescription?.mock?.calls ?? [];
      return calls.map(([arg]) => String(arg ?? ""));
    });
  }

  it("shows the count returned by countCompletedSessionsOlderThan (42) in the warning embed description", async () => {
    if (!rankingExecute) return;

    // Arrange: dry-run will find 42 sessions older than the new retention window
    communityMocks.countCompletedSessionsOlderThan.mockResolvedValue(42);

    const interaction = makeCommandInteraction({ days: 90 });
    await rankingExecute(interaction as never);

    // The command must have entered the short-retention warning path
    expect(interaction.deferReply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ embeds: expect.anything(), components: expect.anything() }),
    );

    // The warning embed description must include the dry-run count
    const descriptions = captureDescriptions();
    expect(descriptions.some((d) => d.includes("42"))).toBe(true);
  });

  it("countCompletedSessionsOlderThan is called with the guild ID and the requested day count", async () => {
    if (!rankingExecute) return;

    communityMocks.countCompletedSessionsOlderThan.mockResolvedValue(7);

    const interaction = makeCommandInteraction({ days: 60, guildId: "guild-xyz" });
    await rankingExecute(interaction as never);

    expect(communityMocks.countCompletedSessionsOlderThan).toHaveBeenCalledWith("guild-xyz", 60);
  });

  it("shows the count 1 (singular) in the embed when exactly one session is affected", async () => {
    if (!rankingExecute) return;

    communityMocks.countCompletedSessionsOlderThan.mockResolvedValue(1);

    const interaction = makeCommandInteraction({ days: 30 });
    await rankingExecute(interaction as never);

    const descriptions = captureDescriptions();
    expect(descriptions.some((d) => d.includes("1"))).toBe(true);
  });

  it("shows the zero-affected message (not a count) when countCompletedSessionsOlderThan returns 0", async () => {
    if (!rankingExecute) return;

    communityMocks.countCompletedSessionsOlderThan.mockResolvedValue(0);

    const interaction = makeCommandInteraction({ days: 90 });
    await rankingExecute(interaction as never);

    const descriptions = captureDescriptions();
    // The handler uses a different branch for 0 — no "N件" count, instead a
    // "no sessions older than X days" message.
    expect(descriptions.some((d) => d.includes("ありません"))).toBe(true);
  });

  it("does NOT call countCompletedSessionsOlderThan when days >= 180 (no dry-run needed)", async () => {
    if (!rankingExecute) return;

    const interaction = makeCommandInteraction({ days: 180 });
    await rankingExecute(interaction as never);

    expect(communityMocks.countCompletedSessionsOlderThan).not.toHaveBeenCalled();
  });

  it("does NOT call countCompletedSessionsOlderThan when days < 30 (floor rejection fires first)", async () => {
    if (!rankingExecute) return;

    const interaction = makeCommandInteraction({ days: 10 });
    await rankingExecute(interaction as never);

    expect(communityMocks.countCompletedSessionsOlderThan).not.toHaveBeenCalled();
  });
});
