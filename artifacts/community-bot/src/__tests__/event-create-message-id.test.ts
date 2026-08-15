/**
 * Tests for the /event create subcommand handler.
 *
 * Verifies:
 *   1. createEvent is called with the correct guildId, channelId, and title.
 *   2. updateEventMessageId is called with the Discord message ID returned by
 *      channel.send, so the edit handler can refresh the embed later.
 *   3. Edge case — channel not text-based: updateEventMessageId is NOT called,
 *      but the command still replies with success.
 *   4. Edge case — channel.send throws: the error propagates (no silent swallow).
 *   5. Edge case — invalid date: createEvent is never called; handler replies
 *      with an ephemeral error before deferring.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock state ────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  createEvent:           vi.fn(),
  updateEventMessageId:  vi.fn(),
  getEvent:              vi.fn(),
  getParticipants:       vi.fn(),
}));

// ─── Mock ../lib/community.js ─────────────────────────────────────────────────
// Fully replace the module so @workspace/db is never loaded.

vi.mock("../lib/community.js", () => ({
  createEvent:                       mocks.createEvent,
  updateEventMessageId:              mocks.updateEventMessageId,
  getEvent:                          mocks.getEvent,
  getParticipants:                   mocks.getParticipants,
  // stubs for all symbols imported at module level by commands/index.ts
  addParticipant:                    vi.fn(),
  removeParticipant:                 vi.fn(),
  deleteEvent:                       vi.fn(),
  editEvent:                         vi.fn(),
  listUpcomingEvents:                vi.fn(),
  createRoleButton:                  vi.fn(),
  deleteRoleButtonsByMessage:        vi.fn(),
  getRoleButtonById:                 vi.fn(),
  getRoleButtonsByMessage:           vi.fn(),
  listRoleButtonPanels:              vi.fn(),
  deleteUserVcSessions:              vi.fn(),
  getActiveSession:                  vi.fn(),
  getActiveSessionCount:             vi.fn(),
  getEventSettings:                  vi.fn(),
  getUserVcRank:                     vi.fn(),
  getVcRanking:                      vi.fn(),
  getVcTimeInPeriod:                 vi.fn(),
  isVcTrackingOptedOut:              vi.fn(),
  isVcTrackingGloballyOptedOut:      vi.fn(),
  isVcTrackingGuildLocalOptedOut:    vi.fn(),
  setEventSettings:                  vi.fn(),
  setLeaveLogChannel:                vi.fn(),
  setRankingSettings:                vi.fn(),
  setVcSessionRetentionDays:         vi.fn(),
  getVcSessionRetentionDays:         vi.fn(),
  setStaffRole:                      vi.fn(),
  setVcPrivacyOptOut:                vi.fn(),
  setVcGlobalPrivacyOptOut:          vi.fn(),
  setVcPrivacyOptin:                 vi.fn(),
  deleteAllUserVcSessions:           vi.fn(),
  getAllTempVcDeletions:              vi.fn(),
  getAuditLogChannel:                vi.fn(),
  setAuditLogChannel:                vi.fn(),
  countCompletedSessionsOlderThan:   vi.fn(),
  buildTempVcCsv:                    vi.fn(),
  wipeGuildVcSessions:               vi.fn(),
  getTrackedVcCategoryId:            vi.fn(),
  setTrackedVcCategoryId:            vi.fn(),
  getTicketSettings:                 vi.fn(),
  getTicketPanel:                    vi.fn(),
  upsertTicketSettings:              vi.fn(),
  createTicket:                      vi.fn(),
}));

// ─── Mock @workspace/db ───────────────────────────────────────────────────────
// Needed so community.js (if partially loaded) and commands/index.ts imports don't fail.

vi.mock("@workspace/db", () => {
  const tbl = (name: string) =>
    new Proxy({} as Record<string, string>, { get: (_t, p: string) => `${name}.${p}` });

  return {
    db: { select: vi.fn(), delete: vi.fn(), insert: vi.fn(), update: vi.fn() },
    communityEventSettingsTable:       tbl("eventSettings"),
    communityEventsTable:              tbl("events"),
    communityEventParticipantsTable:   tbl("eventParticipants"),
    communityTicketSettingsTable:      tbl("ticketSettings"),
    communityTicketsTable:             tbl("tickets"),
    communityTicketPanelsTable:        tbl("ticketPanels"),
    communityVcSessionsTable:          tbl("sessions"),
    communityVcPrivacyTable:           tbl("privacy"),
    communityVcPrivacyGlobalTable:     tbl("global"),
    communityRankingSettingsTable:     tbl("rankingSettings"),
    communityRoleButtonsTable:         tbl("roleButtons"),
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

// ─── Import AFTER mocks ───────────────────────────────────────────────────────

import { commands } from "../commands/index.js";

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const fakeEvent = {
  id: 42,
  guildId: "guild-001",
  channelId: "chan-001",
  title: "Test Event",
  description: null,
  scheduledAt: new Date("2099-12-31T00:00:00+09:00"),
};

const fakeMessage = { id: "msg-discord-999" };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getEventCommand() {
  const cmd = commands.find((c) => c.data.name === "event");
  if (!cmd) throw new Error("event command not found in commands array");
  return cmd;
}

interface MakeInteractionOpts {
  guildId?: string | null;
  title?: string;
  dateStr?: string;
  channelId?: string;
  description?: string | null;
  channelIsTextBased?: boolean;
  sendThrows?: boolean;
}

function makeInteraction(opts: MakeInteractionOpts = {}) {
  const {
    guildId           = "guild-001",
    title             = "Test Event",
    dateStr           = "2099-12-31",
    channelId         = "chan-001",
    description       = null,
    channelIsTextBased = true,
    sendThrows        = false,
  } = opts;

  const fakeChannel = {
    id: channelId,
    isTextBased: vi.fn().mockReturnValue(channelIsTextBased),
    send: vi.fn(async () => {
      if (sendThrows) throw new Error("Discord send failed");
      return fakeMessage;
    }),
  };

  return {
    guildId,
    guild: guildId
      ? { id: guildId, channels: { cache: { get: vi.fn().mockReturnValue(fakeChannel) } } }
      : null,
    user: { id: "user-001" },
    memberPermissions: { has: vi.fn().mockReturnValue(true) },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply:  vi.fn().mockResolvedValue(undefined),
    reply:      vi.fn().mockResolvedValue(undefined),
    options: {
      getSubcommand: vi.fn().mockReturnValue("create"),
      getString: vi.fn((name: string) => {
        if (name === "title")       return title;
        if (name === "date")        return dateStr;
        if (name === "description") return description;
        return null;
      }),
      getChannel: vi.fn().mockReturnValue({ id: channelId }),
      getInteger: vi.fn().mockReturnValue(null),
      getBoolean: vi.fn().mockReturnValue(null),
      getUser:    vi.fn().mockReturnValue(null),
    },
    // Exposed so tests can assert on channel.send.
    _fakeChannel: fakeChannel,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("/event create — createEvent is called correctly", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // getEvent + getParticipants are called inside buildEventEmbed.
    mocks.getEvent.mockResolvedValue(fakeEvent);
    mocks.getParticipants.mockResolvedValue([]);
  });

  it("calls createEvent with the correct guildId", async () => {
    mocks.createEvent.mockResolvedValue({ ...fakeEvent, guildId: "guild-xyz" });
    mocks.updateEventMessageId.mockResolvedValue(undefined);

    const interaction = makeInteraction({ guildId: "guild-xyz" });
    await getEventCommand().execute(interaction as never);

    expect(mocks.createEvent).toHaveBeenCalledTimes(1);
    expect(mocks.createEvent.mock.calls[0]![0]).toBe("guild-xyz");
  });

  it("calls createEvent with the correct channelId", async () => {
    mocks.createEvent.mockResolvedValue({ ...fakeEvent, channelId: "chan-abc" });
    mocks.updateEventMessageId.mockResolvedValue(undefined);

    const interaction = makeInteraction({ channelId: "chan-abc" });
    await getEventCommand().execute(interaction as never);

    expect(mocks.createEvent.mock.calls[0]![1]).toBe("chan-abc");
  });

  it("calls createEvent with the correct title", async () => {
    mocks.createEvent.mockResolvedValue({ ...fakeEvent, title: "Summer Festival" });
    mocks.updateEventMessageId.mockResolvedValue(undefined);

    const interaction = makeInteraction({ title: "Summer Festival" });
    await getEventCommand().execute(interaction as never);

    expect(mocks.createEvent.mock.calls[0]![2]).toBe("Summer Festival");
  });

  it("calls createEvent with description=null when no description is provided", async () => {
    mocks.createEvent.mockResolvedValue(fakeEvent);
    mocks.updateEventMessageId.mockResolvedValue(undefined);

    const interaction = makeInteraction({ description: null });
    await getEventCommand().execute(interaction as never);

    expect(mocks.createEvent.mock.calls[0]![3]).toBeNull();
  });

  it("calls createEvent with the description string when one is provided", async () => {
    mocks.createEvent.mockResolvedValue(fakeEvent);
    mocks.updateEventMessageId.mockResolvedValue(undefined);

    const interaction = makeInteraction({ description: "Bring a hat" });
    await getEventCommand().execute(interaction as never);

    expect(mocks.createEvent.mock.calls[0]![3]).toBe("Bring a hat");
  });

  it("calls createEvent with a valid Date for scheduledAt", async () => {
    mocks.createEvent.mockResolvedValue(fakeEvent);
    mocks.updateEventMessageId.mockResolvedValue(undefined);

    const interaction = makeInteraction({ dateStr: "2099-06-15" });
    await getEventCommand().execute(interaction as never);

    const scheduledAt = mocks.createEvent.mock.calls[0]![4] as Date;
    expect(scheduledAt).toBeInstanceOf(Date);
    expect(isNaN(scheduledAt.getTime())).toBe(false);
  });
});

describe("/event create — updateEventMessageId is called with the Discord message ID", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createEvent.mockResolvedValue(fakeEvent);
    mocks.updateEventMessageId.mockResolvedValue(undefined);
    mocks.getEvent.mockResolvedValue(fakeEvent);
    mocks.getParticipants.mockResolvedValue([]);
  });

  it("calls updateEventMessageId once after a successful channel.send", async () => {
    const interaction = makeInteraction();
    await getEventCommand().execute(interaction as never);

    expect(mocks.updateEventMessageId).toHaveBeenCalledTimes(1);
  });

  it("calls updateEventMessageId with the event ID returned by createEvent", async () => {
    const interaction = makeInteraction();
    await getEventCommand().execute(interaction as never);

    expect(mocks.updateEventMessageId.mock.calls[0]![0]).toBe(fakeEvent.id);
  });

  it("calls updateEventMessageId with the Discord message ID from channel.send", async () => {
    const interaction = makeInteraction();
    await getEventCommand().execute(interaction as never);

    expect(mocks.updateEventMessageId.mock.calls[0]![1]).toBe(fakeMessage.id);
  });

  it("calls channel.send with an embeds array containing the event embed", async () => {
    const interaction = makeInteraction();
    await getEventCommand().execute(interaction as never);

    expect(interaction._fakeChannel.send).toHaveBeenCalledTimes(1);
    const [[sendPayload]] = interaction._fakeChannel.send.mock.calls as unknown as [[{ embeds: { data: { title?: string } }[]; components: unknown[] }]];

    // Payload must carry an embeds array — not plain text or an empty object.
    expect(Array.isArray(sendPayload.embeds)).toBe(true);
    expect(sendPayload.embeds).toHaveLength(1);

    // The embed title must reference the event title built by buildEventEmbed.
    const embedTitle = sendPayload.embeds[0]?.data?.title ?? "";
    expect(embedTitle).toContain(fakeEvent.title);

    // Component rows (join / cancel buttons) must also be present.
    expect(Array.isArray(sendPayload.components)).toBe(true);
    expect(sendPayload.components.length).toBeGreaterThan(0);
  });

  it("calls updateEventMessageId only after channel.send resolves", async () => {
    const order: string[] = [];

    mocks.updateEventMessageId.mockImplementation(async () => {
      order.push("updateMessageId");
    });

    const interaction = makeInteraction();
    // Override channel.send on the already-created fakeChannel.
    interaction._fakeChannel.send.mockImplementation(async () => {
      order.push("send");
      return fakeMessage;
    });

    await getEventCommand().execute(interaction as never);

    expect(order).toEqual(["send", "updateMessageId"]);
  });

  it("replies with a success message that includes the event title", async () => {
    const interaction = makeInteraction({ title: "My Unique Event" });
    mocks.createEvent.mockResolvedValue({ ...fakeEvent, title: "My Unique Event" });
    await getEventCommand().execute(interaction as never);

    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    const [[reply]] = interaction.editReply.mock.calls as [[string]];
    expect(reply).toMatch(/✅/);
    expect(reply).toContain("My Unique Event");
  });
});

describe("/event create — edge case: channel is not text-based", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createEvent.mockResolvedValue(fakeEvent);
    mocks.updateEventMessageId.mockResolvedValue(undefined);
    mocks.getEvent.mockResolvedValue(fakeEvent);
    mocks.getParticipants.mockResolvedValue([]);
  });

  it("does NOT call channel.send when the target channel is not text-based", async () => {
    const interaction = makeInteraction({ channelIsTextBased: false });
    await getEventCommand().execute(interaction as never);

    expect(interaction._fakeChannel.send).not.toHaveBeenCalled();
  });

  it("does NOT call updateEventMessageId when the channel is not text-based", async () => {
    const interaction = makeInteraction({ channelIsTextBased: false });
    await getEventCommand().execute(interaction as never);

    expect(mocks.updateEventMessageId).not.toHaveBeenCalled();
  });

  it("still replies with success even when the channel is not text-based", async () => {
    const interaction = makeInteraction({ channelIsTextBased: false });
    await getEventCommand().execute(interaction as never);

    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    const [[reply]] = interaction.editReply.mock.calls as [[string]];
    expect(reply).toMatch(/✅/);
  });

  it("still calls createEvent when the target channel is not text-based", async () => {
    const interaction = makeInteraction({ channelIsTextBased: false });
    await getEventCommand().execute(interaction as never);

    expect(mocks.createEvent).toHaveBeenCalledTimes(1);
  });
});

describe("/event create — edge case: channel.send throws", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createEvent.mockResolvedValue(fakeEvent);
    mocks.updateEventMessageId.mockResolvedValue(undefined);
    mocks.getEvent.mockResolvedValue(fakeEvent);
    mocks.getParticipants.mockResolvedValue([]);
  });

  it("propagates the error when channel.send throws (no silent swallow)", async () => {
    const interaction = makeInteraction({ sendThrows: true });
    await expect(getEventCommand().execute(interaction as never)).rejects.toThrow(
      "Discord send failed",
    );
  });

  it("does NOT call updateEventMessageId when channel.send throws", async () => {
    const interaction = makeInteraction({ sendThrows: true });
    await expect(getEventCommand().execute(interaction as never)).rejects.toBeDefined();
    expect(mocks.updateEventMessageId).not.toHaveBeenCalled();
  });
});

describe("/event create — edge case: invalid date format", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replies with an ephemeral error and does NOT call createEvent when the date is invalid", async () => {
    const interaction = makeInteraction({ dateStr: "not-a-date" });
    await getEventCommand().execute(interaction as never);

    expect(mocks.createEvent).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledTimes(1);
    const [[replyArg]] = interaction.reply.mock.calls as [[{ content: string; ephemeral: boolean }]];
    expect(replyArg.ephemeral).toBe(true);
    expect(replyArg.content).toMatch(/日付/);
  });

  it("does NOT call updateEventMessageId when the date is invalid", async () => {
    const interaction = makeInteraction({ dateStr: "bad" });
    await getEventCommand().execute(interaction as never);

    expect(mocks.updateEventMessageId).not.toHaveBeenCalled();
  });
});
