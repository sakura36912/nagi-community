/**
 * Tests for the `handlePrivacyAdminDeleteCancel` button handler.
 *
 * Confirms that the ManageGuild permission gate mirrors the confirm handler:
 * a non-admin replaying the cancel button must be blocked with an ephemeral
 * error, while a proper admin resolves cleanly.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock state ─────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  // select chain: db.select({...}).from(...).where(...) → [] (no audit channel)
  const selectWhere = vi.fn().mockResolvedValue([]);
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  // delete chain (should never be called for cancel)
  const returning = vi.fn().mockResolvedValue([]);
  const where = vi.fn(() => ({ returning }));
  const del = vi.fn(() => ({ where }));

  return { select, selectFrom, selectWhere, del, where, returning };
});

// ─── Mock @workspace/db ───────────────────────────────────────────────────────
vi.mock("@workspace/db", () => {
  const tbl = (name: string) =>
    new Proxy({} as Record<string, string>, {
      get: (_t, p: string) => `${name}.${p}`,
    });

  return {
    PET_RARITIES: ["normal", "rare", "epic", "legend", "mythic"],
    PET_RARITY_NAMES: { normal: "normal", rare: "rare", epic: "epic", legend: "legend", mythic: "mythic" },
    PET_SETTING_LABELS: { level_cap: "level cap" },
    PROFILE_FIELD_LABELS: { bounty: "bounty" },
    PROFILE_RANK_LABELS: { regular: "regular", vip: "vip", vip_plus: "vip+", special: "special" },
    db: {
      select: mocks.select,
      delete: mocks.del,
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

// ─── Mock drizzle-orm ────────────────────────────────────────────────────────
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
  handlePrivacyAdminDeleteCancel,
  COMM_PRIVACY_ADMIN_DELETE_CANCEL_PREFIX,
} from "../commands/index.js";

// ─── Interaction factory ──────────────────────────────────────────────────────

function makeInteraction(opts: {
  userId?: string;
  guildId?: string | null;
  targetUserId?: string;
  hasManageGuild?: boolean;
}) {
  const {
    userId = "admin-user",
    guildId = "guild-123",
    targetUserId = "target-user-456",
    hasManageGuild = true,
  } = opts;

  return {
    user: { id: userId, tag: "TestUser#0001" },
    guildId,
    customId: `${COMM_PRIVACY_ADMIN_DELETE_CANCEL_PREFIX}${targetUserId}`,
    member: {
      permissions: {
        has: vi.fn().mockReturnValue(hasManageGuild),
      },
    },
    reply: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("handlePrivacyAdminDeleteCancel – permission gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replies with an ephemeral error and does NOT defer when the member lacks ManageGuild", async () => {
    const interaction = makeInteraction({ hasManageGuild: false });
    await handlePrivacyAdminDeleteCancel(interaction as never);

    // Must reply with an ephemeral error
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    // Must NOT proceed to deferUpdate or editReply
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(interaction.editReply).not.toHaveBeenCalled();
    // Must NOT touch the database
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it("error reply message mentions the required permission", async () => {
    const interaction = makeInteraction({ hasManageGuild: false });
    await handlePrivacyAdminDeleteCancel(interaction as never);

    const [[replyArg]] = interaction.reply.mock.calls as [[{ content: string; ephemeral: boolean }]];
    expect(replyArg.content).toMatch(/ManageGuild/i);
  });

  it("replies with an ephemeral error and does NOT defer when guildId is absent (DM context)", async () => {
    const interaction = makeInteraction({ guildId: null, hasManageGuild: true });
    await handlePrivacyAdminDeleteCancel(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it("defers and edits reply when the member has ManageGuild (cancel is idempotent/safe)", async () => {
    const interaction = makeInteraction({ hasManageGuild: true });
    await handlePrivacyAdminDeleteCancel(interaction as never);

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ components: [] }),
    );
    // Cancel must never touch the database
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it("success reply embed title indicates the action was cancelled", async () => {
    const interaction = makeInteraction({ hasManageGuild: true });
    await handlePrivacyAdminDeleteCancel(interaction as never);

    const [[replyArg]] = interaction.editReply.mock.calls as [[{ embeds: { data: { title?: string } }[] }]];
    const title = replyArg.embeds[0]?.data?.title ?? "";
    expect(title).toMatch(/キャンセル/);
  });
});
