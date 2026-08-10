/**
 * Tests that VC session tracking respects the tracked-category setting.
 *
 * We exercise the REAL production function `openVcSessionIfTracked` exported
 * from community.ts.  The function accepts injectable dependencies so tests
 * can supply mock `getTrackedVcCategoryId` and `openSession` implementations
 * without mocking the entire community module — eliminating the risk of a
 * silent copy drifting from production (e.g. missing the isExile argument).
 *
 * Done-looks-like coverage:
 *   1. Join an untracked channel → openSession is NOT called
 *   2. Join a tracked channel    → openSession IS called (including isExile)
 *   3. No category configured (null) → all channels are tracked
 *   4. Channel has no parent (root-level) + category configured → NOT tracked
 *   5. getTrackedVcCategoryId throws → fail closed, openSession NOT called
 *   6. Move-from-tracked-to-untracked join side → openSession NOT called
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mock fns so vi.mock factories can reference them ──────────────────
const { loggerError, loggerInfo, loggerWarn } = vi.hoisted(() => ({
  loggerError: vi.fn(),
  loggerInfo:  vi.fn(),
  loggerWarn:  vi.fn(),
}));

// ─── Mock @workspace/db BEFORE any community.ts import ───────────────────────
//
// @workspace/db throws at module load if DATABASE_URL is absent.  We stub it
// out so community.ts can be imported without a real database.  No DB queries
// are executed because openVcSessionIfTracked uses injected deps exclusively.
vi.mock("@workspace/db", () => ({
  db: {},
  communityVcSessionsTable: {},
  communityVcPrivacyTable: {},
  communityVcPrivacyGlobalTable: {},
  communityRankingSettingsTable: {},
  communityEventSettingsTable: {},
  communityEventsTable: {},
  communityEventParticipantsTable: {},
  communityTicketSettingsTable: {},
  communityTicketsTable: {},
  communityTicketPanelsTable: {},
  communityRoleButtonsTable: {},
}));

// ─── Mock logger ──────────────────────────────────────────────────────────────
vi.mock("../lib/logger.js", () => ({
  logger: { error: loggerError, info: loggerInfo, warn: loggerWarn },
}));

// ─── Import the REAL production function ─────────────────────────────────────
import { openVcSessionIfTracked } from "../lib/community.js";

// ─── Per-test mock dep factory ────────────────────────────────────────────────

function makeDeps(overrides: {
  trackedCategoryId?: string | null | Error;
  openSession?: ReturnType<typeof vi.fn>;
}) {
  return {
    getTrackedVcCategoryId: overrides.trackedCategoryId instanceof Error
      ? vi.fn().mockRejectedValue(overrides.trackedCategoryId)
      : vi.fn().mockResolvedValue(overrides.trackedCategoryId ?? null),
    openSession: overrides.openSession ?? vi.fn().mockResolvedValue(null),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("openVcSessionIfTracked – tracked-category session gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Scenario 1: untracked channel ────────────────────────────────────────

  it("does NOT call openSession when the channel is outside the tracked category", async () => {
    const deps = makeDeps({ trackedCategoryId: "cat-tracked" });

    await openVcSessionIfTracked("guild-1", "user-1", "ch-other", "cat-other", false, deps);

    expect(deps.openSession).not.toHaveBeenCalled();
  });

  it("does NOT call openSession when the channel has no parent and a category is configured", async () => {
    const deps = makeDeps({ trackedCategoryId: "cat-tracked" });

    await openVcSessionIfTracked("guild-1", "user-1", "ch-root", null, false, deps);

    expect(deps.openSession).not.toHaveBeenCalled();
  });

  // ── Scenario 2: tracked channel ──────────────────────────────────────────

  it("calls openSession when the channel is inside the tracked category", async () => {
    const deps = makeDeps({ trackedCategoryId: "cat-tracked" });

    await openVcSessionIfTracked("guild-1", "user-1", "ch-tracked", "cat-tracked", false, deps);

    expect(deps.openSession).toHaveBeenCalledOnce();
    expect(deps.openSession).toHaveBeenCalledWith("guild-1", "user-1", "ch-tracked", false);
  });

  it("passes isExile=true to openSession for exile users in a tracked channel", async () => {
    const deps = makeDeps({ trackedCategoryId: "cat-tracked" });

    await openVcSessionIfTracked("guild-1", "exile-user", "ch-tracked", "cat-tracked", true, deps);

    expect(deps.openSession).toHaveBeenCalledOnce();
    expect(deps.openSession).toHaveBeenCalledWith("guild-1", "exile-user", "ch-tracked", true);
  });

  // ── Scenario 3: no category configured ───────────────────────────────────

  it("calls openSession for any channel when no category is configured (null → track all)", async () => {
    const deps = makeDeps({ trackedCategoryId: null });

    await openVcSessionIfTracked("guild-1", "user-1", "ch-anywhere", "cat-anything", false, deps);

    expect(deps.openSession).toHaveBeenCalledOnce();
    expect(deps.openSession).toHaveBeenCalledWith("guild-1", "user-1", "ch-anywhere", false);
  });

  it("calls openSession for a root-level channel when no category is configured", async () => {
    const deps = makeDeps({ trackedCategoryId: null });

    await openVcSessionIfTracked("guild-1", "user-1", "ch-root", null, false, deps);

    expect(deps.openSession).toHaveBeenCalledOnce();
  });

  // ── Scenario 5: fail closed on DB error ──────────────────────────────────

  it("does NOT call openSession when getTrackedVcCategoryId throws (fail closed)", async () => {
    const deps = makeDeps({ trackedCategoryId: new Error("DB timeout") });

    await openVcSessionIfTracked("guild-1", "user-1", "ch-1", "cat-A", false, deps);

    expect(deps.openSession).not.toHaveBeenCalled();
  });

  it("logs the error when getTrackedVcCategoryId throws", async () => {
    const dbErr = new Error("connection lost");
    const deps = makeDeps({ trackedCategoryId: dbErr });

    await openVcSessionIfTracked("guild-1", "user-1", "ch-1", "cat-A", false, deps);

    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining("getTrackedVcCategoryId"),
      dbErr,
    );
  });

  it("does NOT throw when getTrackedVcCategoryId rejects", async () => {
    const deps = makeDeps({ trackedCategoryId: new Error("oops") });

    await expect(
      openVcSessionIfTracked("guild-1", "user-1", "ch-1", null, false, deps),
    ).resolves.toBeUndefined();
  });

  // ── Scenario 6: move from tracked to untracked (join side) ───────────────
  //
  // The VoiceStateUpdate handler always calls closeSessionAndGetDuration for
  // the leave side unconditionally, then calls openVcSessionIfTracked for the
  // join side.  Here we confirm the join side of a "tracked→untracked" move
  // does not open a new session.

  it("does NOT open a session when moving to a channel outside the tracked category", async () => {
    const deps = makeDeps({ trackedCategoryId: "cat-tracked" });

    await openVcSessionIfTracked(
      "guild-1", "user-1",
      "ch-untracked-dst", "cat-other",   // destination is outside tracked category
      false,
      deps,
    );

    expect(deps.openSession).not.toHaveBeenCalled();
  });
});
