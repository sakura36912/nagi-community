/**
 * Tests for the `handleRetentionConfirm` button handler.
 *
 * Confirms that:
 *  - A non-admin replaying the confirm button is blocked with an ephemeral
 *    error and the nonce entry is NOT consumed from retentionConfirmExpiry.
 *  - A missing guildId (DM context) is similarly rejected without touching
 *    the nonce.
 *  - A real admin interaction consumes the nonce and proceeds normally.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock state ─────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  const selectWhere = vi.fn().mockResolvedValue([]);
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  const returning = vi.fn().mockResolvedValue([]);
  const where = vi.fn(() => ({ returning }));
  const del = vi.fn(() => ({ where }));

  const updateSet = vi.fn().mockResolvedValue([]);
  const updateWhere = vi.fn().mockResolvedValue([]);
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));

  const onConflictDoUpdate = vi.fn().mockResolvedValue([]);
  const onConflictDoNothing = vi.fn().mockResolvedValue([]);
  const values = vi.fn(() => ({ onConflictDoUpdate, onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));

  return { select, selectFrom, selectWhere, del, where, returning, update, set, updateWhere, updateSet, insert, values, onConflictDoUpdate, onConflictDoNothing };
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
      delete: mocks.del,
      update: mocks.update,
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
  notInArray: (col: unknown, vals: unknown) => ({ op: "notInArray", col, vals }),
  asc: (col: unknown) => ({ op: "asc", col }),
  desc: (col: unknown) => ({ op: "desc", col }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: "sql", strings, values }),
    { raw: (v: unknown) => ({ op: "sql.raw", v }) },
  ),
}));

// ─── Import after mocks ───────────────────────────────────────────────────────
import {
  handleRetentionConfirm,
  handleRetentionCancel,
  retentionConfirmExpiry,
  COMM_RETENTION_CONFIRM_PREFIX,
  COMM_RETENTION_CANCEL_PREFIX,
} from "../commands/index.js";

// ─── Interaction factory ──────────────────────────────────────────────────────

function makeInteraction(opts: {
  userId?: string;
  guildId?: string | null;
  nonce?: string;
  isAdministrator?: boolean;
}) {
  const {
    userId = "admin-user",
    guildId = "guild-123",
    nonce = "test-nonce-confirm",
    isAdministrator = true,
  } = opts;

  return {
    user: { id: userId, tag: "TestUser#0001" },
    guildId,
    customId: `${COMM_RETENTION_CONFIRM_PREFIX}${nonce}`,
    member: {
      permissions: {
        has: vi.fn().mockReturnValue(isAdministrator),
      },
    },
    reply: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("handleRetentionConfirm – permission gate and nonce preservation", () => {
  const NONCE = "test-nonce-confirm";
  const GUILD_ID = "guild-123";

  beforeEach(() => {
    vi.clearAllMocks();
    // Seed the registry with a fresh, non-expired entry before each test.
    retentionConfirmExpiry.set(NONCE, {
      guildId: GUILD_ID,
      days: 90,
      expiry: Date.now() + 60_000,
    });
  });

  it("replies with an ephemeral error when the member lacks Administrator", async () => {
    const interaction = makeInteraction({ isAdministrator: false, nonce: NONCE, guildId: GUILD_ID });
    await handleRetentionConfirm(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
  });

  it("error reply message mentions 管理者 (administrator) when permission is denied", async () => {
    const interaction = makeInteraction({ isAdministrator: false, nonce: NONCE, guildId: GUILD_ID });
    await handleRetentionConfirm(interaction as never);

    const [[replyArg]] = interaction.reply.mock.calls as [[{ content: string; ephemeral: boolean }]];
    expect(replyArg.content).toMatch(/管理者/);
  });

  it("does NOT consume the nonce when the member lacks Administrator", async () => {
    const interaction = makeInteraction({ isAdministrator: false, nonce: NONCE, guildId: GUILD_ID });
    await handleRetentionConfirm(interaction as never);

    // The registry entry must still be present so a real admin can still confirm.
    expect(retentionConfirmExpiry.has(NONCE)).toBe(true);
  });

  it("does NOT proceed to deferUpdate when the member lacks Administrator", async () => {
    const interaction = makeInteraction({ isAdministrator: false, nonce: NONCE, guildId: GUILD_ID });
    await handleRetentionConfirm(interaction as never);

    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it("does NOT touch the database when the member lacks Administrator", async () => {
    const interaction = makeInteraction({ isAdministrator: false, nonce: NONCE, guildId: GUILD_ID });
    await handleRetentionConfirm(interaction as never);

    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it("replies with an ephemeral error and does NOT consume the nonce when guildId is absent (DM context)", async () => {
    const interaction = makeInteraction({ guildId: null, isAdministrator: true, nonce: NONCE });
    await handleRetentionConfirm(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    // Nonce must remain intact — the DM guard fires before any nonce access.
    expect(retentionConfirmExpiry.has(NONCE)).toBe(true);
  });

  it("consumes the nonce when an admin confirms successfully", async () => {
    const interaction = makeInteraction({ isAdministrator: true, nonce: NONCE, guildId: GUILD_ID });
    await handleRetentionConfirm(interaction as never);

    // After a successful confirm the entry must be gone.
    expect(retentionConfirmExpiry.has(NONCE)).toBe(false);
  });

  it("defers and edits reply when an admin confirms successfully", async () => {
    const interaction = makeInteraction({ isAdministrator: true, nonce: NONCE, guildId: GUILD_ID });
    await handleRetentionConfirm(interaction as never);

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ components: [] }),
    );
  });

  it("success reply embed title indicates the change was applied", async () => {
    const interaction = makeInteraction({ isAdministrator: true, nonce: NONCE, guildId: GUILD_ID });
    await handleRetentionConfirm(interaction as never);

    const [[replyArg]] = interaction.editReply.mock.calls as [[{ embeds: { data: { title?: string } }[] }]];
    const title = replyArg.embeds[0]?.data?.title ?? "";
    expect(title).toMatch(/保持期間/);
  });

  it("nonce remains intact when the same nonce is replayed by a non-admin after a first non-admin attempt", async () => {
    // Two consecutive non-admin replays — registry must remain populated.
    const interaction1 = makeInteraction({ isAdministrator: false, nonce: NONCE, guildId: GUILD_ID });
    await handleRetentionConfirm(interaction1 as never);
    expect(retentionConfirmExpiry.has(NONCE)).toBe(true);

    const interaction2 = makeInteraction({ isAdministrator: false, nonce: NONCE, guildId: GUILD_ID });
    await handleRetentionConfirm(interaction2 as never);
    expect(retentionConfirmExpiry.has(NONCE)).toBe(true);
  });
});

// ─── Expired nonce tests ──────────────────────────────────────────────────────

describe("handleRetentionConfirm – expired nonce", () => {
  const NONCE = "test-nonce-expired";
  const GUILD_ID = "guild-123";

  beforeEach(() => {
    vi.clearAllMocks();
    // Seed the registry with an already-expired entry (expiry 1 ms in the past).
    retentionConfirmExpiry.set(NONCE, {
      guildId: GUILD_ID,
      days: 60,
      expiry: Date.now() - 1,
    });
  });

  it("replies with an ephemeral error when the nonce has expired, even for a valid admin", async () => {
    const interaction = makeInteraction({ isAdministrator: true, nonce: NONCE, guildId: GUILD_ID });
    await handleRetentionConfirm(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
  });

  it("timeout reply content contains the expiry notice (有効期限)", async () => {
    const interaction = makeInteraction({ isAdministrator: true, nonce: NONCE, guildId: GUILD_ID });
    await handleRetentionConfirm(interaction as never);

    const [[replyArg]] = interaction.reply.mock.calls as [[{ content: string; ephemeral: boolean }]];
    expect(replyArg.content).toMatch(/有効期限/);
  });

  it("removes the stale entry from the registry after an expired-nonce call", async () => {
    const interaction = makeInteraction({ isAdministrator: true, nonce: NONCE, guildId: GUILD_ID });
    await handleRetentionConfirm(interaction as never);

    // The stale entry must be cleaned up so memory is not leaked.
    expect(retentionConfirmExpiry.has(NONCE)).toBe(false);
  });

  it("does NOT proceed to deferUpdate or editReply when the nonce has expired", async () => {
    const interaction = makeInteraction({ isAdministrator: true, nonce: NONCE, guildId: GUILD_ID });
    await handleRetentionConfirm(interaction as never);

    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it("does NOT write to the database when the nonce has expired", async () => {
    const interaction = makeInteraction({ isAdministrator: true, nonce: NONCE, guildId: GUILD_ID });
    await handleRetentionConfirm(interaction as never);

    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.del).not.toHaveBeenCalled();
  });
});

// ─── Cross-guild replay tests ─────────────────────────────────────────────────

describe("handleRetentionConfirm – cross-guild nonce isolation", () => {
  const NONCE    = "test-nonce-cross-guild";
  const GUILD_A  = "guild-aaa";
  const GUILD_B  = "guild-bbb";

  beforeEach(() => {
    vi.clearAllMocks();
    // Seed a valid, non-expired nonce that belongs to guild A.
    retentionConfirmExpiry.set(NONCE, {
      guildId: GUILD_A,
      days: 90,
      expiry: Date.now() + 60_000,
    });
  });

  it("replies with an ephemeral error when guild B presents guild A's nonce", async () => {
    const interaction = makeInteraction({ isAdministrator: true, nonce: NONCE, guildId: GUILD_B });
    await handleRetentionConfirm(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
  });

  it("ephemeral error content mentions the expiry notice (有効期限) for the cross-guild case", async () => {
    const interaction = makeInteraction({ isAdministrator: true, nonce: NONCE, guildId: GUILD_B });
    await handleRetentionConfirm(interaction as never);

    const [[replyArg]] = interaction.reply.mock.calls as [[{ content: string; ephemeral: boolean }]];
    expect(replyArg.content).toMatch(/有効期限/);
  });

  it("does NOT remove the nonce entry from the registry after a cross-guild attempt", async () => {
    const interaction = makeInteraction({ isAdministrator: true, nonce: NONCE, guildId: GUILD_B });
    await handleRetentionConfirm(interaction as never);

    // A guild-ID mismatch must NOT consume the nonce — the legitimate guild-A
    // admin must still be able to confirm after guild B's replay is rejected.
    expect(retentionConfirmExpiry.has(NONCE)).toBe(true);
  });

  it("does NOT proceed to deferUpdate or editReply on a cross-guild replay", async () => {
    const interaction = makeInteraction({ isAdministrator: true, nonce: NONCE, guildId: GUILD_B });
    await handleRetentionConfirm(interaction as never);

    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it("does NOT write to the database on a cross-guild replay", async () => {
    const interaction = makeInteraction({ isAdministrator: true, nonce: NONCE, guildId: GUILD_B });
    await handleRetentionConfirm(interaction as never);

    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it("guild A can still confirm successfully after guild B's cross-guild replay is rejected", async () => {
    // Step 1: guild B presents guild A's nonce — rejected, nonce must survive.
    const guildBInteraction = makeInteraction({ isAdministrator: true, nonce: NONCE, guildId: GUILD_B });
    await handleRetentionConfirm(guildBInteraction as never);
    expect(retentionConfirmExpiry.has(NONCE)).toBe(true);

    // Step 2: guild A's legitimate admin confirms — must succeed.
    const guildAInteraction = makeInteraction({ isAdministrator: true, nonce: NONCE, guildId: GUILD_A });
    await handleRetentionConfirm(guildAInteraction as never);

    expect(guildAInteraction.reply).not.toHaveBeenCalled();
    expect(guildAInteraction.deferUpdate).toHaveBeenCalled();
    expect(guildAInteraction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ components: [] }),
    );
  });

  it("guild A's successful confirm consumes the nonce after guild B's rejected replay", async () => {
    const guildBInteraction = makeInteraction({ isAdministrator: true, nonce: NONCE, guildId: GUILD_B });
    await handleRetentionConfirm(guildBInteraction as never);

    const guildAInteraction = makeInteraction({ isAdministrator: true, nonce: NONCE, guildId: GUILD_A });
    await handleRetentionConfirm(guildAInteraction as never);

    // The nonce must be gone after the legitimate guild-A confirmation.
    expect(retentionConfirmExpiry.has(NONCE)).toBe(false);
  });

  it("guild A's success embed title indicates the change was applied after guild B's rejected replay", async () => {
    const guildBInteraction = makeInteraction({ isAdministrator: true, nonce: NONCE, guildId: GUILD_B });
    await handleRetentionConfirm(guildBInteraction as never);

    const guildAInteraction = makeInteraction({ isAdministrator: true, nonce: NONCE, guildId: GUILD_A });
    await handleRetentionConfirm(guildAInteraction as never);

    const [[replyArg]] = guildAInteraction.editReply.mock.calls as [[{ embeds: { data: { title?: string } }[] }]];
    const title = replyArg.embeds[0]?.data?.title ?? "";
    expect(title).toMatch(/保持期間/);
  });
});

// ─── Cancel interaction factory ───────────────────────────────────────────────

function makeCancelInteraction(opts: {
  userId?: string;
  guildId?: string | null;
  nonce?: string;
  isAdministrator?: boolean;
}) {
  const {
    userId = "admin-user",
    guildId = "guild-123",
    nonce = "test-nonce-cancel",
    isAdministrator = true,
  } = opts;

  return {
    user: { id: userId, tag: "TestUser#0001" },
    guildId,
    customId: `${COMM_RETENTION_CANCEL_PREFIX}${nonce}`,
    member: {
      permissions: {
        has: vi.fn().mockReturnValue(isAdministrator),
      },
    },
    reply: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
}

// ─── Unregistered nonce tests ─────────────────────────────────────────────────

describe("handleRetentionConfirm – nonce never registered", () => {
  const UNREGISTERED_NONCE = "nonce-that-was-never-seeded";
  const GUILD_ID = "guild-123";

  beforeEach(() => {
    vi.clearAllMocks();
    // Intentionally do NOT seed retentionConfirmExpiry with UNREGISTERED_NONCE.
    // This simulates a replayed or fabricated customId whose nonce never existed.
  });

  it("replies with an ephemeral error when the nonce was never registered", async () => {
    const interaction = makeInteraction({ isAdministrator: true, nonce: UNREGISTERED_NONCE, guildId: GUILD_ID });
    await handleRetentionConfirm(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
  });

  it("ephemeral error content contains the expiry notice (有効期限) for an unregistered nonce", async () => {
    const interaction = makeInteraction({ isAdministrator: true, nonce: UNREGISTERED_NONCE, guildId: GUILD_ID });
    await handleRetentionConfirm(interaction as never);

    const [[replyArg]] = interaction.reply.mock.calls as [[{ content: string; ephemeral: boolean }]];
    expect(replyArg.content).toMatch(/有効期限/);
  });

  it("does NOT call deferUpdate or editReply when the nonce was never registered", async () => {
    const interaction = makeInteraction({ isAdministrator: true, nonce: UNREGISTERED_NONCE, guildId: GUILD_ID });
    await handleRetentionConfirm(interaction as never);

    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(interaction.editReply).not.toHaveBeenCalled();
  });

  it("does NOT write to the database when the nonce was never registered", async () => {
    const interaction = makeInteraction({ isAdministrator: true, nonce: UNREGISTERED_NONCE, guildId: GUILD_ID });
    await handleRetentionConfirm(interaction as never);

    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.del).not.toHaveBeenCalled();
  });
});

// ─── Cancel-then-confirm cross-button invalidation tests ──────────────────────

describe("handleRetentionCancel → handleRetentionConfirm cross-button invalidation", () => {
  const NONCE    = "test-nonce-cancel-then-confirm";
  const GUILD_ID = "guild-123";

  beforeEach(() => {
    vi.clearAllMocks();
    // Seed a valid, non-expired nonce before each test.
    retentionConfirmExpiry.set(NONCE, {
      guildId: GUILD_ID,
      days: 90,
      expiry: Date.now() + 60_000,
    });
  });

  it("handleRetentionCancel removes the nonce from the registry", async () => {
    const cancelInteraction = makeCancelInteraction({ isAdministrator: true, nonce: NONCE, guildId: GUILD_ID });
    await handleRetentionCancel(cancelInteraction as never);

    expect(retentionConfirmExpiry.has(NONCE)).toBe(false);
  });

  it("handleRetentionCancel defers and edits reply on success", async () => {
    const cancelInteraction = makeCancelInteraction({ isAdministrator: true, nonce: NONCE, guildId: GUILD_ID });
    await handleRetentionCancel(cancelInteraction as never);

    expect(cancelInteraction.deferUpdate).toHaveBeenCalled();
    expect(cancelInteraction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ components: [] }),
    );
  });

  it("handleRetentionConfirm returns an ephemeral error when called after handleRetentionCancel", async () => {
    // Step 1: cancel consumes the nonce.
    const cancelInteraction = makeCancelInteraction({ isAdministrator: true, nonce: NONCE, guildId: GUILD_ID });
    await handleRetentionCancel(cancelInteraction as never);

    // Step 2: confirm now sees no entry for the same nonce.
    const confirmInteraction = makeInteraction({ isAdministrator: true, nonce: NONCE, guildId: GUILD_ID });
    await handleRetentionConfirm(confirmInteraction as never);

    expect(confirmInteraction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
  });

  it("ephemeral error from confirm-after-cancel mentions the expiry notice (有効期限)", async () => {
    const cancelInteraction = makeCancelInteraction({ isAdministrator: true, nonce: NONCE, guildId: GUILD_ID });
    await handleRetentionCancel(cancelInteraction as never);

    const confirmInteraction = makeInteraction({ isAdministrator: true, nonce: NONCE, guildId: GUILD_ID });
    await handleRetentionConfirm(confirmInteraction as never);

    const [[replyArg]] = confirmInteraction.reply.mock.calls as [[{ content: string; ephemeral: boolean }]];
    expect(replyArg.content).toMatch(/有効期限/);
  });

  it("confirm-after-cancel does NOT call deferUpdate or editReply on the confirm interaction", async () => {
    const cancelInteraction = makeCancelInteraction({ isAdministrator: true, nonce: NONCE, guildId: GUILD_ID });
    await handleRetentionCancel(cancelInteraction as never);

    const confirmInteraction = makeInteraction({ isAdministrator: true, nonce: NONCE, guildId: GUILD_ID });
    await handleRetentionConfirm(confirmInteraction as never);

    expect(confirmInteraction.deferUpdate).not.toHaveBeenCalled();
    expect(confirmInteraction.editReply).not.toHaveBeenCalled();
  });

  it("confirm-after-cancel does NOT write to the database", async () => {
    const cancelInteraction = makeCancelInteraction({ isAdministrator: true, nonce: NONCE, guildId: GUILD_ID });
    await handleRetentionCancel(cancelInteraction as never);

    const confirmInteraction = makeInteraction({ isAdministrator: true, nonce: NONCE, guildId: GUILD_ID });
    await handleRetentionConfirm(confirmInteraction as never);

    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.del).not.toHaveBeenCalled();
  });
});
