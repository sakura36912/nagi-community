/**
 * /event edit — Discord embed refresh path
 *
 * Tests:
 * 1. msg.edit() is called when event.messageId is set and the message exists
 * 2. editEvent still succeeds (handler replies success) when the message no
 *    longer exists (fetch returns null)
 * 3. no fetch is attempted when event.messageId is null
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock state ──────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => {
  const editEvent      = vi.fn().mockResolvedValue(undefined);
  const getEvent       = vi.fn();
  const getParticipants = vi.fn().mockResolvedValue([]);

  // Stubs for all other community.js imports used in commands/index.ts
  const noop = () => vi.fn().mockResolvedValue(undefined);

  return {
    editEvent,
    getEvent,
    getParticipants,
    // stubs
    addParticipant:              vi.fn().mockResolvedValue(false),
    createEvent:                 noop(),
    deleteEvent:                 noop(),
    createRoleButton:            noop(),
    deleteRoleButtonsByMessage:  noop(),
    deleteUserVcSessions:        vi.fn().mockResolvedValue(0),
    getActiveSession:            vi.fn().mockResolvedValue(null),
    getActiveSessionCount:       vi.fn().mockResolvedValue(0),
    getRoleButtonById:           vi.fn().mockResolvedValue(null),
    getRoleButtonsByMessage:     vi.fn().mockResolvedValue([]),
    getEventSettings:            vi.fn().mockResolvedValue(null),
    getUserVcRank:               vi.fn().mockResolvedValue(null),
    getVcRanking:                vi.fn().mockResolvedValue([]),
    getVcTimeInPeriod:           vi.fn().mockResolvedValue(0),
    isVcTrackingOptedOut:        vi.fn().mockResolvedValue(false),
    listRoleButtonPanels:        vi.fn().mockResolvedValue([]),
    listUpcomingEvents:          vi.fn().mockResolvedValue([]),
    setEventSettings:            noop(),
    removeParticipant:           vi.fn().mockResolvedValue(false),
    setLeaveLogChannel:          noop(),
    setRankingSettings:          noop(),
    setVcSessionRetentionDays:   noop(),
    getVcSessionRetentionDays:   vi.fn().mockResolvedValue(null),
    setStaffRole:                noop(),
    setVcPrivacyOptOut:          vi.fn().mockResolvedValue(false),
    setVcGlobalPrivacyOptOut:    vi.fn().mockResolvedValue(0),
    setVcPrivacyOptin:           noop(),
    isVcTrackingGloballyOptedOut: vi.fn().mockResolvedValue(false),
    isVcTrackingGuildLocalOptedOut: vi.fn().mockResolvedValue(false),
    deleteAllUserVcSessions:     vi.fn().mockResolvedValue(0),
    updateEventMessageId:        noop(),
    getAllTempVcDeletions:        vi.fn().mockResolvedValue([]),
    getAuditLogChannel:          vi.fn().mockResolvedValue(null),
    setAuditLogChannel:          noop(),
    countCompletedSessionsOlderThan: vi.fn().mockResolvedValue(0),
    buildTempVcCsv:              vi.fn().mockResolvedValue(""),
    wipeGuildVcSessions:         vi.fn().mockResolvedValue(0),
    getTrackedVcCategoryId:      vi.fn().mockResolvedValue(null),
    setTrackedVcCategoryId:      noop(),
    getTicketSettings:           vi.fn().mockResolvedValue(null),
    getTicketPanel:              vi.fn().mockResolvedValue(null),
    upsertTicketSettings:        noop(),
    createTicket:                vi.fn().mockResolvedValue({ id: 1 }),
  };
});

// ─── Mock ../lib/community.js ─────────────────────────────────────────────────
vi.mock("../lib/community.js", () => ({
  editEvent:                   mocks.editEvent,
  getEvent:                    mocks.getEvent,
  getParticipants:             mocks.getParticipants,
  addParticipant:              mocks.addParticipant,
  createEvent:                 mocks.createEvent,
  deleteEvent:                 mocks.deleteEvent,
  createRoleButton:            mocks.createRoleButton,
  deleteRoleButtonsByMessage:  mocks.deleteRoleButtonsByMessage,
  deleteUserVcSessions:        mocks.deleteUserVcSessions,
  getActiveSession:            mocks.getActiveSession,
  getActiveSessionCount:       mocks.getActiveSessionCount,
  getRoleButtonById:           mocks.getRoleButtonById,
  getRoleButtonsByMessage:     mocks.getRoleButtonsByMessage,
  getEventSettings:            mocks.getEventSettings,
  getUserVcRank:               mocks.getUserVcRank,
  getVcRanking:                mocks.getVcRanking,
  getVcTimeInPeriod:           mocks.getVcTimeInPeriod,
  isVcTrackingOptedOut:        mocks.isVcTrackingOptedOut,
  listRoleButtonPanels:        mocks.listRoleButtonPanels,
  listUpcomingEvents:          mocks.listUpcomingEvents,
  setEventSettings:            mocks.setEventSettings,
  removeParticipant:           mocks.removeParticipant,
  setLeaveLogChannel:          mocks.setLeaveLogChannel,
  setRankingSettings:          mocks.setRankingSettings,
  setVcSessionRetentionDays:   mocks.setVcSessionRetentionDays,
  getVcSessionRetentionDays:   mocks.getVcSessionRetentionDays,
  setStaffRole:                mocks.setStaffRole,
  setVcPrivacyOptOut:          mocks.setVcPrivacyOptOut,
  setVcGlobalPrivacyOptOut:    mocks.setVcGlobalPrivacyOptOut,
  setVcPrivacyOptin:           mocks.setVcPrivacyOptin,
  isVcTrackingGloballyOptedOut: mocks.isVcTrackingGloballyOptedOut,
  isVcTrackingGuildLocalOptedOut: mocks.isVcTrackingGuildLocalOptedOut,
  deleteAllUserVcSessions:     mocks.deleteAllUserVcSessions,
  updateEventMessageId:        mocks.updateEventMessageId,
  getAllTempVcDeletions:        mocks.getAllTempVcDeletions,
  getAuditLogChannel:          mocks.getAuditLogChannel,
  setAuditLogChannel:          mocks.setAuditLogChannel,
  countCompletedSessionsOlderThan: mocks.countCompletedSessionsOlderThan,
  buildTempVcCsv:              mocks.buildTempVcCsv,
  wipeGuildVcSessions:         mocks.wipeGuildVcSessions,
  getTrackedVcCategoryId:      mocks.getTrackedVcCategoryId,
  setTrackedVcCategoryId:      mocks.setTrackedVcCategoryId,
  getTicketSettings:           mocks.getTicketSettings,
  getTicketPanel:              mocks.getTicketPanel,
  upsertTicketSettings:        mocks.upsertTicketSettings,
  createTicket:                mocks.createTicket,
}));

// ─── Mock ../lib/logger.js ────────────────────────────────────────────────────
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ─── Mock discord.js ─────────────────────────────────────────────────────────
// The commands module builds SlashCommandBuilder instances at import time, so we
// need chainable stubs for all builder methods.  EmbedBuilder / ActionRowBuilder /
// ButtonBuilder only need to be constructible — the real output shape does not
// matter for these tests.

vi.mock("discord.js", () => {
  // A chainable stub that records setName() so data.name works correctly.
  class FakeBuilder {
    _name = "";
    setName(n: string)                              { this._name = n; return this; }
    get name()                                      { return this._name; }
    toJSON()                                        { return { name: this._name }; }
    setDescription()                                { return this; }
    setDMPermission()                               { return this; }
    setDefaultMemberPermissions()                   { return this; }
    addSubcommand(fn: (s: FakeBuilder) => unknown)      { fn(new FakeBuilder()); return this; }
    addSubcommandGroup(fn: (g: FakeBuilder) => unknown) { fn(new FakeBuilder()); return this; }
    addIntegerOption(fn: (o: FakeOption) => unknown){ fn(new FakeOption()); return this; }
    addNumberOption(fn: (o: FakeOption) => unknown) { fn(new FakeOption()); return this; }
    addStringOption(fn: (o: FakeOption) => unknown) { fn(new FakeOption()); return this; }
    addChannelOption(fn: (o: FakeOption) => unknown){ fn(new FakeOption()); return this; }
    addBooleanOption(fn: (o: FakeOption) => unknown){ fn(new FakeOption()); return this; }
    addRoleOption(fn: (o: FakeOption) => unknown)   { fn(new FakeOption()); return this; }
    addUserOption(fn: (o: FakeOption) => unknown)   { fn(new FakeOption()); return this; }
    addAttachmentOption(fn: (o: FakeOption) => unknown) { fn(new FakeOption()); return this; }
  }

  class FakeOption {
    setName()           { return this; }
    setDescription()    { return this; }
    setRequired()       { return this; }
    setMinValue()       { return this; }
    setMaxValue()       { return this; }
    setMaxLength()      { return this; }
    setMinLength()      { return this; }
    addChannelTypes()   { return this; }
    addChoices()        { return this; }
  }

  class FakeEmbed {
    data: Record<string, unknown> = {};
    setTitle(t: string)      { this.data["title"] = t; return this; }
    setColor(c: unknown)     { this.data["color"] = c; return this; }
    setDescription(d: string){ this.data["desc"]  = d; return this; }
    setFooter(f: unknown)    { this.data["footer"] = f; return this; }
    setTimestamp()           { return this; }
    setThumbnail()           { return this; }
    addFields()              { return this; }
  }

  class FakeButton {
    setCustomId()  { return this; }
    setLabel()     { return this; }
    setStyle()     { return this; }
    setDisabled()  { return this; }
  }

  class FakeRow {
    addComponents() { return this; }
  }

  return {
    EmbedBuilder:         FakeEmbed,
    ButtonBuilder:        FakeButton,
    ActionRowBuilder:     FakeRow,
    SlashCommandBuilder:  FakeBuilder,
    PermissionFlagsBits:  new Proxy({}, { get: () => BigInt(8) }),
    ChannelType:          new Proxy({}, { get: () => 0 }),
    ButtonStyle:          { Success: 3, Secondary: 2, Primary: 1, Danger: 4, Link: 5 },
  };
});

// ─── Import SUT after mocks ───────────────────────────────────────────────────
import { commands } from "../commands/index.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const EVENT_ID   = 42;
const GUILD_ID   = "guild-111";
const CHANNEL_ID = "channel-222";
const MESSAGE_ID = "message-333";

const baseEvent = {
  id:          EVENT_ID,
  guildId:     GUILD_ID,
  channelId:   CHANNEL_ID,
  messageId:   MESSAGE_ID,
  title:       "Test Event",
  description: "desc",
  scheduledAt: new Date("2026-12-01T10:00:00+09:00"),
  reminderSentAt:   null,
  reminder24hSentAt: null,
};

function makeInteraction(opts: {
  guildId?: string | null;
  guild?: unknown;
  eventId?: number;
  newTitle?: string | null;
  newDate?: string | null;
  newDesc?: string | null;
  isAdmin?: boolean;
}) {
  const {
    guildId  = GUILD_ID,
    guild    = null,
    eventId  = EVENT_ID,
    newTitle = "Updated Title",
    newDate  = null,
    newDesc  = null,
    isAdmin  = true,
  } = opts;

  return {
    guildId,
    guild,
    user: { id: "user-001", tag: "Admin#0001" },
    member: {
      permissions: { has: vi.fn().mockReturnValue(isAdmin) },
    },
    memberPermissions: { has: vi.fn().mockReturnValue(isAdmin) },
    options: {
      getSubcommand: vi.fn().mockReturnValue("edit"),
      getInteger: vi.fn().mockReturnValue(eventId),
      getString: vi.fn((name: string) => {
        if (name === "title")       return newTitle;
        if (name === "date")        return newDate;
        if (name === "description") return newDesc;
        return null;
      }),
      getChannel: vi.fn().mockReturnValue(null),
      getRole:    vi.fn().mockReturnValue(null),
      getBoolean: vi.fn().mockReturnValue(null),
      getUser:    vi.fn().mockReturnValue(null),
    },
    reply:       vi.fn().mockResolvedValue(undefined),
    deferReply:  vi.fn().mockResolvedValue(undefined),
    editReply:   vi.fn().mockResolvedValue(undefined),
  };
}

function getEventCommand() {
  const cmd = commands.find((c) => c.data.name === "event");
  if (!cmd) throw new Error("eventCommand not found in commands array");
  return cmd;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("/event edit — embed refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: getEvent returns baseEvent (with messageId set)
    mocks.getEvent.mockResolvedValue({ ...baseEvent });
    // getParticipants returns an empty list by default
    mocks.getParticipants.mockResolvedValue([]);
  });

  it("calls msg.edit() with the updated embed when the message still exists", async () => {
    const msgEdit = vi.fn().mockResolvedValue(undefined);
    const fetch   = vi.fn().mockResolvedValue({ edit: msgEdit });

    const eventChannel = {
      isTextBased: () => true,
      messages: { fetch },
    };

    const guild = {
      channels: { cache: { get: vi.fn().mockReturnValue(eventChannel) } },
    };

    const interaction = makeInteraction({ guild });
    await getEventCommand().execute(interaction as never);

    // Message was fetched by its stored messageId
    expect(fetch).toHaveBeenCalledWith(MESSAGE_ID);

    // msg.edit was called (embed refresh succeeded)
    expect(msgEdit).toHaveBeenCalledOnce();
    const [editArg] = msgEdit.mock.calls[0] as [{ embeds: unknown[]; components: unknown[] }];
    expect(editArg).toHaveProperty("embeds");
    expect(editArg).toHaveProperty("components");

    // Handler still replies with success
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("✅"),
    );
  });

  it("succeeds and replies success when the message no longer exists (fetch returns null)", async () => {
    const fetch = vi.fn().mockResolvedValue(null); // message gone

    const eventChannel = {
      isTextBased: () => true,
      messages: { fetch },
    };

    const guild = {
      channels: { cache: { get: vi.fn().mockReturnValue(eventChannel) } },
    };

    const interaction = makeInteraction({ guild });
    await getEventCommand().execute(interaction as never);

    // editEvent was still called (DB was updated)
    expect(mocks.editEvent).toHaveBeenCalledOnce();

    // fetch was attempted but returned null, so no error was thrown
    expect(fetch).toHaveBeenCalledWith(MESSAGE_ID);

    // Handler replies with success despite the missing Discord message
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("✅"),
    );
  });

  it("does not fetch the channel message when event.messageId is null", async () => {
    // Return an event with no messageId
    mocks.getEvent.mockResolvedValue({ ...baseEvent, messageId: null });

    const fetch = vi.fn();
    const eventChannel = {
      isTextBased: () => true,
      messages: { fetch },
    };

    const guild = {
      channels: { cache: { get: vi.fn().mockReturnValue(eventChannel) } },
    };

    const interaction = makeInteraction({ guild });
    await getEventCommand().execute(interaction as never);

    // editEvent was still called
    expect(mocks.editEvent).toHaveBeenCalledOnce();

    // No Discord message fetch was attempted
    expect(fetch).not.toHaveBeenCalled();

    // Handler replies success
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining("✅"),
    );
  });
});
