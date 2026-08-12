/**
 * Tests for buildTempVcCsvFilename and the tempvc export handler's filename wiring.
 *
 * Part 1 — Unit tests for buildTempVcCsvFilename (pure function):
 *   Covers the four meaningful filter combinations and edge-case variants:
 *   1. No filters         → tempvc-log-all.csv
 *   2. Date range only    → tempvc-log-YYYY-MM-DD_YYYY-MM-DD.csv
 *   3. User ID only       → tempvc-log-all-<userId>.csv
 *   4. Date range + user  → tempvc-log-YYYY-MM-DD_YYYY-MM-DD-<userId>.csv
 *   Plus start-only and end-only date range variants.
 *
 * Part 2 — Handler wiring tests:
 *   Confirms the tempvc export subcommand passes the filename returned by
 *   buildTempVcCsvFilename as the attachment name in the Discord reply, so
 *   that a correct filename cannot be computed yet silently ignored.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist controllable community.js mock functions ──────────────────────────
//
// vi.hoisted runs before vi.mock() factories so the test bodies can reconfigure
// these mocks via beforeEach without losing the reference.

const communityFns = vi.hoisted(() => ({
  getAllTempVcDeletions: vi.fn(),
  buildTempVcCsv:       vi.fn(),
}));

// ─── Mock ../lib/community.js ────────────────────────────────────────────────
//
// All community library functions are stubbed with vi.fn().  The two functions
// actually exercised by the export handler (getAllTempVcDeletions, buildTempVcCsv)
// use the hoisted references above so tests can set return values via beforeEach.

vi.mock("../lib/community.js", () => ({
  getAllTempVcDeletions:          communityFns.getAllTempVcDeletions,
  buildTempVcCsv:                communityFns.buildTempVcCsv,
  addParticipant:                vi.fn(),
  createEvent:                   vi.fn(),
  deleteEvent:                   vi.fn(),
  editEvent:                     vi.fn(),
  createRoleButton:              vi.fn(),
  deleteRoleButtonsByMessage:    vi.fn(),
  getEvent:                      vi.fn(),
  getParticipants:               vi.fn(),
  deleteUserVcSessions:          vi.fn(),
  getActiveSession:              vi.fn(),
  getActiveSessionCount:         vi.fn(),
  getRoleButtonById:             vi.fn(),
  getRoleButtonsByMessage:       vi.fn(),
  getEventSettings:              vi.fn(),
  getUserVcRank:                 vi.fn(),
  getVcRanking:                  vi.fn(),
  getVcTimeInPeriod:             vi.fn(),
  isVcTrackingOptedOut:          vi.fn(),
  listRoleButtonPanels:          vi.fn(),
  listUpcomingEvents:            vi.fn(),
  setEventSettings:              vi.fn(),
  removeParticipant:             vi.fn(),
  setLeaveLogChannel:            vi.fn(),
  setRankingSettings:            vi.fn(),
  setVcSessionRetentionDays:     vi.fn(),
  getVcSessionRetentionDays:     vi.fn(),
  setStaffRole:                  vi.fn(),
  setVcPrivacyOptOut:            vi.fn(),
  setVcGlobalPrivacyOptOut:      vi.fn(),
  setVcPrivacyOptin:             vi.fn(),
  isVcTrackingGloballyOptedOut:  vi.fn(),
  isVcTrackingGuildLocalOptedOut:vi.fn(),
  deleteAllUserVcSessions:       vi.fn(),
  updateEventMessageId:          vi.fn(),
  getAuditLogChannel:            vi.fn(),
  setAuditLogChannel:            vi.fn(),
  countCompletedSessionsOlderThan: vi.fn(),
  wipeGuildVcSessions:           vi.fn(),
  getTrackedVcCategoryId:        vi.fn(),
  setTrackedVcCategoryId:        vi.fn(),
  getTicketSettings:             vi.fn(),
  getTicketPanel:                vi.fn(),
  upsertTicketSettings:          vi.fn(),
  createTicket:                  vi.fn(),
  closeSession:                  vi.fn(),
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { buildTempVcCsvFilename, commands } from "../commands/index.js";

// ─── Part 1: buildTempVcCsvFilename pure-function tests ──────────────────────

describe("buildTempVcCsvFilename", () => {
  // ── no filters ──────────────────────────────────────────────────────────────

  it("returns tempvc-log-all.csv when no filters are supplied", () => {
    expect(buildTempVcCsvFilename({})).toBe("tempvc-log-all.csv");
  });

  it("returns tempvc-log-all.csv when all values are explicitly null", () => {
    expect(buildTempVcCsvFilename({ startStr: null, endStr: null, userId: null })).toBe(
      "tempvc-log-all.csv",
    );
  });

  // ── date range only ─────────────────────────────────────────────────────────

  it("includes both date strings joined with _ when start and end are provided", () => {
    expect(
      buildTempVcCsvFilename({ startStr: "2025-01-01", endStr: "2025-01-31" }),
    ).toBe("tempvc-log-2025-01-01_2025-01-31.csv");
  });

  it("uses from- prefix when only start is provided", () => {
    expect(buildTempVcCsvFilename({ startStr: "2025-06-01" })).toBe(
      "tempvc-log-from-2025-06-01.csv",
    );
  });

  it("uses until- prefix when only end is provided", () => {
    expect(buildTempVcCsvFilename({ endStr: "2025-06-30" })).toBe(
      "tempvc-log-until-2025-06-30.csv",
    );
  });

  // ── user ID only ─────────────────────────────────────────────────────────────

  it("appends -<userId> after 'all' when only user is provided", () => {
    expect(buildTempVcCsvFilename({ userId: "123456789" })).toBe(
      "tempvc-log-all-123456789.csv",
    );
  });

  // ── date range + user ────────────────────────────────────────────────────────

  it("combines both date strings and userId in the filename", () => {
    expect(
      buildTempVcCsvFilename({
        startStr: "2025-03-01",
        endStr: "2025-03-31",
        userId: "987654321",
      }),
    ).toBe("tempvc-log-2025-03-01_2025-03-31-987654321.csv");
  });

  it("combines from- prefix with userId when start-only and user are provided", () => {
    expect(
      buildTempVcCsvFilename({ startStr: "2025-09-01", userId: "111222333" }),
    ).toBe("tempvc-log-from-2025-09-01-111222333.csv");
  });

  it("combines until- prefix with userId when end-only and user are provided", () => {
    expect(
      buildTempVcCsvFilename({ endStr: "2025-09-30", userId: "444555666" }),
    ).toBe("tempvc-log-until-2025-09-30-444555666.csv");
  });
});

// ─── Part 2: tempvc export handler — filename wiring ─────────────────────────

/**
 * A minimal completed session row shape.  Only fields consumed by the handler
 * matter here; buildTempVcCsv is mocked and never inspects them.
 */
const FAKE_ROW = {
  sessionId: 1,
  guildId:   "guild-001",
  userId:    "user-001",
  channelId: "ch-001",
  joinedAt:  new Date("2025-01-01T00:00:00Z"),
  leftAt:    new Date("2025-01-01T01:00:00Z"),
  optedOut:  false,
};

const FAKE_CSV = "sessionId,guildId,userId,channelId,joinedAt,leftAt\n" +
                 "1,guild-001,user-001,ch-001,2025-01-01T00:00:00.000Z,2025-01-01T01:00:00.000Z\n";

/**
 * Builds a minimal mock ChatInputCommandInteraction for the export subcommand.
 *
 * @param startStr - value returned by options.getString("start"), or null
 * @param endStr   - value returned by options.getString("end"), or null
 * @param userId   - when provided, options.getUser("user") returns { id: userId };
 *                   otherwise null (no user filter)
 */
function makeExportInteraction(opts: {
  startStr?: string | null;
  endStr?: string | null;
  userId?: string | null;
} = {}) {
  const { startStr = null, endStr = null, userId = null } = opts;

  return {
    guildId: "guild-001",
    user: { id: "admin-001", tag: "Admin#0001" },
    memberPermissions: {
      has: vi.fn().mockReturnValue(true), // administrator = true
    },
    options: {
      getSubcommand: vi.fn().mockReturnValue("export"),
      getString:     vi.fn((name: string) => {
        if (name === "start") return startStr;
        if (name === "end")   return endStr;
        return null;
      }),
      getUser: vi.fn((name: string) => {
        if (name === "user" && userId) return { id: userId };
        return null;
      }),
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply:  vi.fn().mockResolvedValue(undefined),
    reply:      vi.fn().mockResolvedValue(undefined),
  };
}

describe("tempvc export — attachment filename matches buildTempVcCsvFilename output", () => {
  // Locate the tempvc command once; it is in the exported commands array.
  const tempvcCommand = commands.find((c) => c.data.name === "tempvc")!;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: one completed session row is returned so the handler does not
    // bail out with the "no records found" early return.
    communityFns.getAllTempVcDeletions.mockResolvedValue([FAKE_ROW]);
    communityFns.buildTempVcCsv.mockReturnValue(FAKE_CSV);
  });

  it("attachment name equals buildTempVcCsvFilename output when no filters are applied", async () => {
    const interaction = makeExportInteraction();
    await tempvcCommand.execute(interaction as never);

    const [[replyArg]] = interaction.editReply.mock.calls as [[{ files: { name: string }[] }]];
    const expectedFilename = buildTempVcCsvFilename({});
    expect(replyArg.files[0]!.name).toBe(expectedFilename);
  });

  it("attachment name equals buildTempVcCsvFilename output for a full date range", async () => {
    const interaction = makeExportInteraction({ startStr: "2025-01-01", endStr: "2025-01-31" });
    await tempvcCommand.execute(interaction as never);

    const [[replyArg]] = interaction.editReply.mock.calls as [[{ files: { name: string }[] }]];
    const expectedFilename = buildTempVcCsvFilename({ startStr: "2025-01-01", endStr: "2025-01-31" });
    expect(replyArg.files[0]!.name).toBe(expectedFilename);
  });

  it("attachment name equals buildTempVcCsvFilename output when only start date is provided", async () => {
    const interaction = makeExportInteraction({ startStr: "2025-06-01" });
    await tempvcCommand.execute(interaction as never);

    const [[replyArg]] = interaction.editReply.mock.calls as [[{ files: { name: string }[] }]];
    const expectedFilename = buildTempVcCsvFilename({ startStr: "2025-06-01" });
    expect(replyArg.files[0]!.name).toBe(expectedFilename);
  });

  it("attachment name equals buildTempVcCsvFilename output when only end date is provided", async () => {
    const interaction = makeExportInteraction({ endStr: "2025-06-30" });
    await tempvcCommand.execute(interaction as never);

    const [[replyArg]] = interaction.editReply.mock.calls as [[{ files: { name: string }[] }]];
    const expectedFilename = buildTempVcCsvFilename({ endStr: "2025-06-30" });
    expect(replyArg.files[0]!.name).toBe(expectedFilename);
  });

  it("attachment name equals buildTempVcCsvFilename output when only a user filter is applied", async () => {
    const interaction = makeExportInteraction({ userId: "123456789" });
    await tempvcCommand.execute(interaction as never);

    const [[replyArg]] = interaction.editReply.mock.calls as [[{ files: { name: string }[] }]];
    const expectedFilename = buildTempVcCsvFilename({ userId: "123456789" });
    expect(replyArg.files[0]!.name).toBe(expectedFilename);
  });

  it("attachment name equals buildTempVcCsvFilename output when date range and user filter are combined", async () => {
    const interaction = makeExportInteraction({
      startStr: "2025-03-01",
      endStr:   "2025-03-31",
      userId:   "987654321",
    });
    await tempvcCommand.execute(interaction as never);

    const [[replyArg]] = interaction.editReply.mock.calls as [[{ files: { name: string }[] }]];
    const expectedFilename = buildTempVcCsvFilename({
      startStr: "2025-03-01",
      endStr:   "2025-03-31",
      userId:   "987654321",
    });
    expect(replyArg.files[0]!.name).toBe(expectedFilename);
  });

  it("editReply carries exactly one file attachment when rows are present", async () => {
    const interaction = makeExportInteraction();
    await tempvcCommand.execute(interaction as never);

    const [[replyArg]] = interaction.editReply.mock.calls as [[{ files: unknown[] }]];
    expect(Array.isArray(replyArg.files)).toBe(true);
    expect(replyArg.files).toHaveLength(1);
  });

  it("attachment content is a Buffer (not a string or undefined)", async () => {
    const interaction = makeExportInteraction();
    await tempvcCommand.execute(interaction as never);

    const [[replyArg]] = interaction.editReply.mock.calls as [[{ files: { attachment: unknown }[] }]];
    expect(Buffer.isBuffer(replyArg.files[0]!.attachment)).toBe(true);
  });

  it("does not send a file attachment when getAllTempVcDeletions returns no rows", async () => {
    communityFns.getAllTempVcDeletions.mockResolvedValue([]);
    const interaction = makeExportInteraction();
    await tempvcCommand.execute(interaction as never);

    // The handler replies with a plain "no records" string — no files key.
    const [[replyArg]] = interaction.editReply.mock.calls as [[unknown]];
    expect(typeof replyArg === "string" || !(replyArg as { files?: unknown }).files).toBe(true);
  });
});

// ─── Part 3: tempvc export — attachment content reflects the filtered row set ─

/**
 * Two distinct row fixtures with different userIds so tests can confirm the
 * CSV content was built from the correct set (not a stale or unfiltered result).
 */
const ROW_A = {
  sessionId: 10,
  guildId:   "guild-001",
  userId:    "user-AAA",
  channelId: "ch-001",
  joinedAt:  new Date("2025-02-01T00:00:00Z"),
  leftAt:    new Date("2025-02-01T01:00:00Z"),
  optedOut:  false,
};

const ROW_B = {
  sessionId: 20,
  guildId:   "guild-001",
  userId:    "user-BBB",
  channelId: "ch-002",
  joinedAt:  new Date("2025-05-01T00:00:00Z"),
  leftAt:    new Date("2025-05-01T02:00:00Z"),
  optedOut:  false,
};

/** CSV that buildTempVcCsv returns when given only ROW_A. */
const CSV_A =
  "sessionId,guildId,userId,channelId,joinedAt,leftAt,optedOut\n" +
  "10,guild-001,user-AAA,ch-001,2025-02-01T00:00:00.000Z,2025-02-01T01:00:00.000Z,false\n";

/** CSV that buildTempVcCsv returns when given only ROW_B. */
const CSV_B =
  "sessionId,guildId,userId,channelId,joinedAt,leftAt,optedOut\n" +
  "20,guild-001,user-BBB,ch-002,2025-05-01T00:00:00.000Z,2025-05-01T02:00:00.000Z,false\n";

/** CSV that buildTempVcCsv returns when given both rows. */
const CSV_AB =
  "sessionId,guildId,userId,channelId,joinedAt,leftAt,optedOut\n" +
  "10,guild-001,user-AAA,ch-001,2025-02-01T00:00:00.000Z,2025-02-01T01:00:00.000Z,false\n" +
  "20,guild-001,user-BBB,ch-002,2025-05-01T00:00:00.000Z,2025-05-01T02:00:00.000Z,false\n";

describe("tempvc export — attachment content reflects the filtered row set", () => {
  const tempvcCommand = commands.find((c) => c.data.name === "tempvc")!;

  beforeEach(() => {
    vi.clearAllMocks();

    // buildTempVcCsv returns different CSV depending on which rows it receives,
    // so the tests can detect if the wrong row set was passed to it.
    communityFns.buildTempVcCsv.mockImplementation(
      (rows: { userId: string }[]) => {
        const hasA = rows.some((r) => r.userId === "user-AAA");
        const hasB = rows.some((r) => r.userId === "user-BBB");
        if (hasA && hasB) return CSV_AB;
        if (hasA)         return CSV_A;
        if (hasB)         return CSV_B;
        return "";
      },
    );
  });

  it("Buffer decodes to the CSV built from the row set returned for the user-AAA filter", async () => {
    // Seed: only ROW_A comes back from the DB when filtering by user-AAA.
    communityFns.getAllTempVcDeletions.mockResolvedValue([ROW_A]);
    const interaction = makeExportInteraction({ userId: "user-AAA" });
    await tempvcCommand.execute(interaction as never);

    const [[replyArg]] = interaction.editReply.mock.calls as [
      [{ files: { attachment: Buffer }[] }],
    ];
    const decoded = replyArg.files[0]!.attachment.toString("utf-8");

    // Content must match the CSV produced from ROW_A.
    expect(decoded).toBe(CSV_A);
    // Spot-check: the user-AAA userId is present and user-BBB is absent.
    expect(decoded).toContain("user-AAA");
    expect(decoded).not.toContain("user-BBB");
  });

  it("Buffer decodes to the CSV built from the row set returned for the user-BBB filter", async () => {
    // Seed: only ROW_B comes back from the DB when filtering by user-BBB.
    communityFns.getAllTempVcDeletions.mockResolvedValue([ROW_B]);
    const interaction = makeExportInteraction({ userId: "user-BBB" });
    await tempvcCommand.execute(interaction as never);

    const [[replyArg]] = interaction.editReply.mock.calls as [
      [{ files: { attachment: Buffer }[] }],
    ];
    const decoded = replyArg.files[0]!.attachment.toString("utf-8");

    expect(decoded).toBe(CSV_B);
    expect(decoded).toContain("user-BBB");
    expect(decoded).not.toContain("user-AAA");
  });

  it("Buffer decodes to the combined CSV when no user filter is applied and both rows are returned", async () => {
    // Seed: both rows come back when no filter is applied.
    communityFns.getAllTempVcDeletions.mockResolvedValue([ROW_A, ROW_B]);
    const interaction = makeExportInteraction();
    await tempvcCommand.execute(interaction as never);

    const [[replyArg]] = interaction.editReply.mock.calls as [
      [{ files: { attachment: Buffer }[] }],
    ];
    const decoded = replyArg.files[0]!.attachment.toString("utf-8");

    expect(decoded).toBe(CSV_AB);
    expect(decoded).toContain("user-AAA");
    expect(decoded).toContain("user-BBB");
  });

  it("buildTempVcCsv is called with the exact rows getAllTempVcDeletions returned", async () => {
    // This is the core wiring check: if the handler were to pass a stale or
    // re-queried row set to buildTempVcCsv the spy would catch the discrepancy.
    communityFns.getAllTempVcDeletions.mockResolvedValue([ROW_A, ROW_B]);
    const interaction = makeExportInteraction();
    await tempvcCommand.execute(interaction as never);

    expect(communityFns.buildTempVcCsv).toHaveBeenCalledTimes(1);
    expect(communityFns.buildTempVcCsv).toHaveBeenCalledWith([ROW_A, ROW_B]);
  });

  it("Buffer content is UTF-8 encoded output of buildTempVcCsv (round-trip is lossless)", async () => {
    const uniqueCsv = "header\nrow1,guild-001,user-AAA\n";
    communityFns.getAllTempVcDeletions.mockResolvedValue([ROW_A]);
    communityFns.buildTempVcCsv.mockReturnValue(uniqueCsv);

    const interaction = makeExportInteraction({ userId: "user-AAA" });
    await tempvcCommand.execute(interaction as never);

    const [[replyArg]] = interaction.editReply.mock.calls as [
      [{ files: { attachment: Buffer }[] }],
    ];
    const buf = replyArg.files[0]!.attachment;

    // The Buffer must be a byte-for-byte UTF-8 encoding of the CSV string.
    expect(buf.toString("utf-8")).toBe(uniqueCsv);
    expect(buf).toEqual(Buffer.from(uniqueCsv, "utf-8"));
  });
});
