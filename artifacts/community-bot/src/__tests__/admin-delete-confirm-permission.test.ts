/**
 * Tests for the `handlePrivacyAdminDeleteConfirm` button handler.
 *
 * Confirms that the ManageGuild permission gate holds even when a non-admin
 * user replays the button interaction (e.g. by copying the customId).
 * A non-admin must receive an error reply and `deleteUserVcSessions` must
 * never be called.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock state ─────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  // delete chain: db.delete(table).where(...).returning({})
  const returning = vi.fn().mockResolvedValue([]);
  const where = vi.fn(() => ({ returning }));
  const del = vi.fn(() => ({ where }));

  return { returning, where, del };
});

// ─── Mock @workspace/db ───────────────────────────────────────────────────────
vi.mock("@workspace/db", () => {
  const tbl = (name: string) =>
    new Proxy({} as Record<string, string>, {
      get: (_t, p: string) => `${name}.${p}`,
    });

  return {
    db: {
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
  handlePrivacyAdminDeleteConfirm,
  COMM_PRIVACY_ADMIN_DELETE_CONFIRM_PREFIX,
} from "../commands/index.js";

// ─── Interaction factory ──────────────────────────────────────────────────────

function makeInteraction(opts: {
  userId?: string;
  userTag?: string;
  guildId?: string | null;
  targetUserId?: string;
  hasManageGuild?: boolean;
}) {
  const {
    userId = "admin-user",
    userTag = "Admin#0001",
    guildId = "guild-123",
    targetUserId = "target-user-456",
    hasManageGuild = true,
  } = opts;

  return {
    user: { id: userId, tag: userTag },
    guildId,
    customId: `${COMM_PRIVACY_ADMIN_DELETE_CONFIRM_PREFIX}${targetUserId}`,
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

describe("handlePrivacyAdminDeleteConfirm – permission gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replies with an error and does NOT delete when the member lacks ManageGuild", async () => {
    const interaction = makeInteraction({ hasManageGuild: false });
    await handlePrivacyAdminDeleteConfirm(interaction as never);

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
    await handlePrivacyAdminDeleteConfirm(interaction as never);

    const [[replyArg]] = interaction.reply.mock.calls as [[{ content: string; ephemeral: boolean }]];
    expect(replyArg.content).toMatch(/ManageGuild/i);
  });

  it("replies with an error and does NOT delete when guildId is absent (DM context)", async () => {
    const interaction = makeInteraction({ guildId: null, hasManageGuild: true });
    await handlePrivacyAdminDeleteConfirm(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it("defers, deletes, and edits reply when the member has ManageGuild", async () => {
    mocks.returning.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);

    const interaction = makeInteraction({ hasManageGuild: true, targetUserId: "user-789" });
    await handlePrivacyAdminDeleteConfirm(interaction as never);

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deferUpdate).toHaveBeenCalled();
    expect(mocks.del).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ components: [] }),
    );
  });

  it("calls deleteUserVcSessions with the correct guildId and targetUserId", async () => {
    mocks.returning.mockResolvedValueOnce([]);

    const interaction = makeInteraction({
      hasManageGuild: true,
      guildId: "guild-abc",
      targetUserId: "target-xyz",
    });
    await handlePrivacyAdminDeleteConfirm(interaction as never);

    // db.delete() must have been called (by deleteUserVcSessions)
    expect(mocks.del).toHaveBeenCalled();

    // The where() clause must include eq conditions for both guildId and userId
    const [whereArg] = mocks.where.mock.calls[0] as unknown as [{ op: string; args: { op: string; val: unknown }[] }];
    expect(whereArg.op).toBe("and");
    const eqVals = whereArg.args
      .filter((a) => a.op === "eq")
      .map((a) => a.val);
    expect(eqVals).toContain("guild-abc");
    expect(eqVals).toContain("target-xyz");
  });

  it("success embed footer credits the acting admin user", async () => {
    mocks.returning.mockResolvedValueOnce([{ id: 10 }]);

    const interaction = makeInteraction({
      hasManageGuild: true,
      userId: "admin-111",
      userTag: "Moderator#1234",
    });
    await handlePrivacyAdminDeleteConfirm(interaction as never);

    const [[replyArg]] = interaction.editReply.mock.calls as [[{ embeds: { data: { footer?: { text: string } } }[] }]];
    const footer = replyArg.embeds[0]?.data?.footer?.text ?? "";
    expect(footer).toContain("admin-111");
  });
});
