/**
 * Tests for the guild-ownership guard in the /event delete and /event edit
 * sub-command handlers.
 *
 * The guard fetches the event with getEvent(eventId) and compares its
 * guildId to the interaction's guildId.  If they differ (or the event is
 * missing) the handler must:
 *   - reply with the "not found" error message
 *   - NOT call deleteEvent / editEvent
 *
 * When the guildIds match the guard must pass through and the mutation
 * function must be called exactly once.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock state ─────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  const getEvent    = vi.fn();
  const deleteEvent = vi.fn().mockResolvedValue(undefined);
  const editEvent   = vi.fn().mockResolvedValue(undefined);
  // getParticipants is called by buildEventEmbed (only reached in passing case)
  const getParticipants = vi.fn().mockResolvedValue([]);

  return { getEvent, deleteEvent, editEvent, getParticipants };
});

// ─── Mock ../lib/community.js ─────────────────────────────────────────────────
//
// Fully replacing the module means @workspace/db and drizzle-orm are never
// loaded by community.js in this test, so we only need minimal stubs for the
// symbols that commands/index.ts imports at module-load time.
vi.mock("../lib/community.js", () => ({
  getEvent:            mocks.getEvent,
  deleteEvent:         mocks.deleteEvent,
  editEvent:           mocks.editEvent,
  getParticipants:     mocks.getParticipants,
  // stubs for symbols imported at module level (never called in these tests)
  addParticipant:           vi.fn(),
  createEvent:              vi.fn(),
  createRoleButton:         vi.fn(),
  deleteRoleButtonsByMessage: vi.fn(),
  deleteUserVcSessions:     vi.fn(),
  getActiveSession:         vi.fn(),
  getActiveSessionCount:    vi.fn(),
  getRoleButtonById:        vi.fn(),
  getRoleButtonsByMessage:  vi.fn(),
  getEventSettings:         vi.fn(),
  getUserVcRank:            vi.fn(),
  getVcRanking:             vi.fn(),
  getVcTimeInPeriod:        vi.fn(),
  isVcTrackingOptedOut:     vi.fn(),
  listRoleButtonPanels:     vi.fn(),
  listUpcomingEvents:       vi.fn(),
  setEventSettings:         vi.fn(),
  removeParticipant:        vi.fn(),
  setLeaveLogChannel:       vi.fn(),
  setRankingSettings:       vi.fn(),
  setVcSessionRetentionDays: vi.fn(),
  getVcSessionRetentionDays: vi.fn(),
  setStaffRole:             vi.fn(),
  setVcPrivacyOptOut:       vi.fn(),
  setVcGlobalPrivacyOptOut: vi.fn(),
  setVcPrivacyOptin:        vi.fn(),
  isVcTrackingGloballyOptedOut: vi.fn(),
  isVcTrackingGuildLocalOptedOut: vi.fn(),
  deleteAllUserVcSessions:  vi.fn(),
  updateEventMessageId:     vi.fn(),
  getAllTempVcDeletions:     vi.fn(),
  getAuditLogChannel:       vi.fn(),
  setAuditLogChannel:       vi.fn(),
  countCompletedSessionsOlderThan: vi.fn(),
  buildTempVcCsv:           vi.fn(),
  wipeGuildVcSessions:      vi.fn(),
  getTrackedVcCategoryId:   vi.fn(),
  setTrackedVcCategoryId:   vi.fn(),
  getTicketSettings:        vi.fn(),
  getTicketPanel:           vi.fn(),
  upsertTicketSettings:     vi.fn(),
  createTicket:             vi.fn(),
}));

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
    db: { select: vi.fn(), delete: vi.fn(), insert: vi.fn(), update: vi.fn() },
    communityVcSessionsTable:        tbl("sessions"),
    communityVcPrivacyGlobalTable:   tbl("global"),
    communityVcPrivacyTable:         tbl("privacy"),
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
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: "sql", strings, values }),
    { raw: (v: unknown) => ({ op: "sql.raw", v }) },
  ),
}));

// ─── Import after mocks ───────────────────────────────────────────────────────
import { commands } from "../commands/index.js";

// ─── Helper: locate event command ─────────────────────────────────────────────
function getEventCommand() {
  const cmd = commands.find((c) => c.data.name === "event");
  if (!cmd) throw new Error("event command not found in commands array");
  return cmd;
}

// ─── Interaction factory ──────────────────────────────────────────────────────
function makeInteraction(opts: {
  sub: "delete" | "edit";
  guildId?: string;
  eventId?: number;
  /** Extra options returned by getString (for edit sub-command) */
  extraStrings?: Record<string, string | null>;
}) {
  const {
    sub,
    guildId = "guild-A",
    eventId = 42,
    extraStrings = {},
  } = opts;

  return {
    guildId,
    options: {
      getSubcommand: vi.fn().mockReturnValue(sub),
      getInteger: vi.fn().mockReturnValue(eventId),
      getString: vi.fn((name: string) => extraStrings[name] ?? null),
      getChannel: vi.fn().mockReturnValue(null),
      getBoolean: vi.fn().mockReturnValue(null),
      getUser: vi.fn().mockReturnValue(null),
    },
    memberPermissions: { has: vi.fn().mockReturnValue(true) },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply:  vi.fn().mockResolvedValue(undefined),
    reply:      vi.fn().mockResolvedValue(undefined),
    guild: null, // not needed for guard tests
    user: { id: "user-1" },
  };
}

/** A minimal event record owned by guild-A. */
const eventInGuildA = {
  id: 42,
  guildId: "guild-A",
  title: "Test Event",
  description: null,
  channelId: "ch-1",
  messageId: null,
  scheduledAt: new Date("2026-01-01T10:00:00Z"),
};

/** A minimal event record owned by guild-B (the cross-guild case). */
const eventInGuildB = { ...eventInGuildA, guildId: "guild-B" };

// ─── /event delete ───────────────────────────────────────────────────────────

describe("/event delete – guild-ownership guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the 'not found' error when the event belongs to a different guild", async () => {
    mocks.getEvent.mockResolvedValue(eventInGuildB); // owned by guild-B
    const interaction = makeInteraction({ sub: "delete", guildId: "guild-A", eventId: 42 });

    await getEventCommand().execute(interaction as never);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("見つかりません"),
    );
  });

  it("does NOT call deleteEvent when the event belongs to a different guild", async () => {
    mocks.getEvent.mockResolvedValue(eventInGuildB);
    const interaction = makeInteraction({ sub: "delete", guildId: "guild-A", eventId: 42 });

    await getEventCommand().execute(interaction as never);

    expect(mocks.deleteEvent).not.toHaveBeenCalled();
  });

  it("returns the 'not found' error when getEvent returns undefined", async () => {
    mocks.getEvent.mockResolvedValue(undefined);
    const interaction = makeInteraction({ sub: "delete", guildId: "guild-A", eventId: 99 });

    await getEventCommand().execute(interaction as never);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("見つかりません"),
    );
    expect(mocks.deleteEvent).not.toHaveBeenCalled();
  });

  it("calls deleteEvent exactly once when guildIds match", async () => {
    mocks.getEvent.mockResolvedValue(eventInGuildA); // owned by guild-A
    const interaction = makeInteraction({ sub: "delete", guildId: "guild-A", eventId: 42 });

    await getEventCommand().execute(interaction as never);

    expect(mocks.deleteEvent).toHaveBeenCalledTimes(1);
    expect(mocks.deleteEvent).toHaveBeenCalledWith(42);
  });

  it("replies with a success message when guildIds match", async () => {
    mocks.getEvent.mockResolvedValue(eventInGuildA);
    const interaction = makeInteraction({ sub: "delete", guildId: "guild-A", eventId: 42 });

    await getEventCommand().execute(interaction as never);

    // editReply should NOT contain the error string
    const [[reply]] = interaction.editReply.mock.calls as [[string]];
    expect(reply).not.toContain("見つかりません");
    expect(reply).toContain("削除しました");
  });
});

// ─── /event edit ─────────────────────────────────────────────────────────────

describe("/event edit – guild-ownership guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the 'not found' error when the event belongs to a different guild", async () => {
    mocks.getEvent.mockResolvedValue(eventInGuildB); // owned by guild-B
    const interaction = makeInteraction({
      sub: "edit",
      guildId: "guild-A",
      eventId: 42,
      extraStrings: { title: "New Title" },
    });

    await getEventCommand().execute(interaction as never);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("見つかりません"),
    );
  });

  it("does NOT call editEvent when the event belongs to a different guild", async () => {
    mocks.getEvent.mockResolvedValue(eventInGuildB);
    const interaction = makeInteraction({
      sub: "edit",
      guildId: "guild-A",
      eventId: 42,
      extraStrings: { title: "New Title" },
    });

    await getEventCommand().execute(interaction as never);

    expect(mocks.editEvent).not.toHaveBeenCalled();
  });

  it("returns the 'not found' error when getEvent returns undefined", async () => {
    mocks.getEvent.mockResolvedValue(undefined);
    const interaction = makeInteraction({
      sub: "edit",
      guildId: "guild-A",
      eventId: 99,
      extraStrings: { title: "New Title" },
    });

    await getEventCommand().execute(interaction as never);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("見つかりません"),
    );
    expect(mocks.editEvent).not.toHaveBeenCalled();
  });

  it("calls editEvent exactly once when guildIds match", async () => {
    mocks.getEvent.mockResolvedValue(eventInGuildA); // owned by guild-A
    // Provide a title change so the handler does not short-circuit with
    // the "no fields specified" error before reaching editEvent.
    const interaction = makeInteraction({
      sub: "edit",
      guildId: "guild-A",
      eventId: 42,
      extraStrings: { title: "Updated Title" },
    });

    await getEventCommand().execute(interaction as never);

    expect(mocks.editEvent).toHaveBeenCalledTimes(1);
    expect(mocks.editEvent).toHaveBeenCalledWith(42, expect.objectContaining({ title: "Updated Title" }));
  });

  it("replies with a success message when guildIds match", async () => {
    mocks.getEvent.mockResolvedValue(eventInGuildA);
    const interaction = makeInteraction({
      sub: "edit",
      guildId: "guild-A",
      eventId: 42,
      extraStrings: { title: "Updated Title" },
    });

    await getEventCommand().execute(interaction as never);

    // editReply should NOT contain the error string
    const replies = interaction.editReply.mock.calls.map((c: unknown[]) => c[0]);
    const finalReply = replies[replies.length - 1] as string;
    expect(finalReply).not.toContain("見つかりません");
    expect(finalReply).toContain("更新しました");
  });
});
