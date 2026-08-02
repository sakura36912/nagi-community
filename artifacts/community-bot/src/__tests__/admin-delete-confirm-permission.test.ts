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

  // select chain: db.select({...}).from(...).where(...) → [] (no audit channel)
  const selectWhere = vi.fn().mockResolvedValue([]);
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  return { returning, where, del, select, selectFrom, selectWhere };
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
      select: mocks.select,
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
  guild?: {
    name?: string;
    channels: {
      cache: { get: ReturnType<typeof vi.fn> };
      fetch?: ReturnType<typeof vi.fn>;
    };
  } | null;
}) {
  const {
    userId = "admin-user",
    userTag = "Admin#0001",
    guildId = "guild-123",
    targetUserId = "target-user-456",
    hasManageGuild = true,
    guild = null,
  } = opts;

  return {
    user: { id: userId, tag: userTag },
    guildId,
    guild,
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

// ─── Audit log tests ──────────────────────────────────────────────────────────

describe("handlePrivacyAdminDeleteConfirm – audit log", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends an audit embed with actor, target, and record count when a channel is configured", async () => {
    const AUDIT_CHANNEL_ID = "audit-channel-999";

    // db.delete returns 3 deleted rows
    mocks.returning.mockResolvedValueOnce([{ id: 1 }, { id: 2 }, { id: 3 }]);

    // db.select returns a row with the audit channel ID
    mocks.selectWhere.mockResolvedValueOnce([{ auditLogChannelId: AUDIT_CHANNEL_ID }]);

    const send = vi.fn().mockResolvedValue(undefined);
    const auditChannel = {
      isTextBased: () => true,
      send,
    };

    const interaction = makeInteraction({
      hasManageGuild: true,
      userId: "admin-111",
      userTag: "Moderator#1234",
      guildId: "guild-abc",
      targetUserId: "target-xyz",
      guild: {
        name: "Test Guild",
        channels: {
          cache: { get: vi.fn().mockReturnValue(auditChannel) },
          fetch: vi.fn().mockResolvedValue(null),
        },
      },
    });

    await handlePrivacyAdminDeleteConfirm(interaction as never);

    expect(send).toHaveBeenCalledOnce();

    const [[sendArg]] = send.mock.calls as [[{ embeds: { data: { fields?: { name: string; value: string }[]; footer?: { text: string } } }[] }]];
    const embedData = sendArg.embeds[0]?.data;
    const fields = embedData?.fields ?? [];

    // Actor field contains the admin's user ID
    const actorField = fields.find((f) => f.name === "操作者");
    expect(actorField?.value).toContain("admin-111");

    // Target field contains the target user ID
    const targetField = fields.find((f) => f.name === "対象ユーザー");
    expect(targetField?.value).toContain("target-xyz");

    // Record count field reflects the number of deleted rows
    const countField = fields.find((f) => f.name === "削除件数");
    expect(countField?.value).toContain("3");

    // Footer contains both the actor ID and the target ID
    const footer = embedData?.footer?.text ?? "";
    expect(footer).toContain("admin-111");
    expect(footer).toContain("target-xyz");
  });

  it("does NOT send any audit message when no audit channel is configured", async () => {
    // db.delete returns 1 deleted row
    mocks.returning.mockResolvedValueOnce([{ id: 1 }]);

    // db.select returns an empty array (no audit channel configured)
    mocks.selectWhere.mockResolvedValueOnce([]);

    const send = vi.fn().mockResolvedValue(undefined);
    const auditChannel = {
      isTextBased: () => true,
      send,
    };

    const interaction = makeInteraction({
      hasManageGuild: true,
      guild: {
        name: "Test Guild",
        channels: {
          cache: { get: vi.fn().mockReturnValue(auditChannel) },
          fetch: vi.fn().mockResolvedValue(null),
        },
      },
    });

    await handlePrivacyAdminDeleteConfirm(interaction as never);

    // The success reply still goes through
    expect(interaction.editReply).toHaveBeenCalled();

    // But no audit message is sent
    expect(send).not.toHaveBeenCalled();
  });

  it("swallows the audit channel send error so the deletion result is unaffected", async () => {
    const AUDIT_CHANNEL_ID = "audit-channel-err";

    // db.delete returns 2 deleted rows
    mocks.returning.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);

    // db.select returns a row with the audit channel ID
    mocks.selectWhere.mockResolvedValueOnce([{ auditLogChannelId: AUDIT_CHANNEL_ID }]);

    // Simulate a network/permission error when posting the audit embed
    const send = vi.fn().mockRejectedValue(new Error("Missing Permissions"));
    const auditChannel = {
      isTextBased: () => true,
      send,
    };

    const interaction = makeInteraction({
      hasManageGuild: true,
      userId: "admin-222",
      userTag: "Admin#9999",
      guildId: "guild-err",
      targetUserId: "target-err",
      guild: {
        name: "Error Guild",
        channels: {
          cache: { get: vi.fn().mockReturnValue(auditChannel) },
          fetch: vi.fn().mockResolvedValue(null),
        },
      },
    });

    // The handler must not throw even though send() rejects
    await expect(handlePrivacyAdminDeleteConfirm(interaction as never)).resolves.toBeUndefined();

    // editReply must have been called (deletion result was reported) before the audit attempt
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ components: [] }),
    );

    // The audit send was indeed attempted and did throw
    expect(send).toHaveBeenCalledOnce();
  });
});
