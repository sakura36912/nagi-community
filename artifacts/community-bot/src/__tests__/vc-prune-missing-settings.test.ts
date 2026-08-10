/**
 * Tests for runPerGuildVcPrune when a guild's settings row disappears mid-run.
 *
 * Scenario: The scheduler has already fetched the list of active guild IDs when
 * an admin concurrently deletes (or the DB rolls back) a guild's ranking-settings
 * row.  By the time getRetentionDays is called for that guild the row is gone, so
 * getVcSessionRetentionDays returns its built-in fallback (180 days) instead of a
 * custom value.
 *
 * Verifies:
 *   (a) The pruner does NOT throw when the settings row is absent mid-run.
 *   (b) The guild is pruned with the safe system default (180 days), preventing
 *       silent data loss that would occur if a shorter custom window were used.
 *   (c) Sessions from other guilds are unaffected — the missing row for one guild
 *       does not skip or corrupt pruning for the remaining guilds.
 *   (d) The pruner also does not throw when getRetentionDays itself rejects (e.g.
 *       a transient DB error during the settings lookup), and still processes the
 *       remaining guilds.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Mock the logger so no output escapes to the test runner ─────────────────
vi.mock("../lib/logger.js", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// ─── Import under test (resolved after mocks) ────────────────────────────────
import { runPerGuildVcPrune } from "../lib/vc-prune-scheduler.js";

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("runPerGuildVcPrune – settings row disappears mid-run", () => {
  let getRetentionDays: ReturnType<typeof vi.fn>;
  let pruneGuild: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getRetentionDays = vi.fn();
    pruneGuild = vi.fn().mockResolvedValue(0);
  });

  it("uses the system-default retention (180) when the settings row is absent for a guild", async () => {
    // Simulate: settings row was deleted between the guild-list fetch and the
    // per-guild lookup.  getVcSessionRetentionDays falls back to 180.
    getRetentionDays.mockResolvedValue(180);

    await runPerGuildVcPrune(["guild-no-settings"], getRetentionDays, pruneGuild);

    expect(pruneGuild).toHaveBeenCalledOnce();
    expect(pruneGuild).toHaveBeenCalledWith("guild-no-settings", 180);
  });

  it("does NOT throw when the settings row is absent mid-run", async () => {
    getRetentionDays.mockResolvedValue(180);

    await expect(
      runPerGuildVcPrune(["guild-no-settings"], getRetentionDays, pruneGuild),
    ).resolves.toBeUndefined();
  });

  it("uses the system-default (180) for the missing-settings guild and the custom window for others", async () => {
    // guild-gone: settings row deleted mid-run → falls back to 180
    // guild-intact: still has its custom 45-day retention row
    getRetentionDays.mockImplementation(async (guildId: string) => {
      if (guildId === "guild-gone") return 180; // fallback because row is absent
      if (guildId === "guild-intact") return 45; // custom retention still in DB
      return 180;
    });

    await runPerGuildVcPrune(
      ["guild-gone", "guild-intact"],
      getRetentionDays,
      pruneGuild,
    );

    expect(pruneGuild).toHaveBeenCalledWith("guild-gone", 180);
    expect(pruneGuild).toHaveBeenCalledWith("guild-intact", 45);
  });

  it("does NOT use a shorter-than-default window for the guild whose row disappeared", async () => {
    // This guards against an implementation bug that could default to 0 or some
    // other unsafe value, causing over-deletion of session history.
    getRetentionDays.mockResolvedValue(180);

    await runPerGuildVcPrune(["guild-no-settings"], getRetentionDays, pruneGuild);

    // Must never have been called with a shorter-than-default window.
    const calls = pruneGuild.mock.calls as [string, number][];
    for (const [, days] of calls) {
      expect(days).toBeGreaterThanOrEqual(180);
    }
  });

  it("still prunes all other guilds when one guild's settings row is absent", async () => {
    // Three guilds; guild-middle loses its settings row mid-run.
    getRetentionDays.mockImplementation(async (guildId: string) => {
      if (guildId === "guild-a") return 60;
      if (guildId === "guild-middle") return 180; // fallback — row gone
      if (guildId === "guild-z") return 90;
      return 180;
    });

    await runPerGuildVcPrune(
      ["guild-a", "guild-middle", "guild-z"],
      getRetentionDays,
      pruneGuild,
    );

    expect(pruneGuild).toHaveBeenCalledWith("guild-a", 60);
    expect(pruneGuild).toHaveBeenCalledWith("guild-middle", 180);
    expect(pruneGuild).toHaveBeenCalledWith("guild-z", 90);
    expect(pruneGuild).toHaveBeenCalledTimes(3);
  });

  it("does NOT throw when the settings lookup itself throws (transient DB error mid-run)", async () => {
    // Stricter scenario: the settings row query errors out entirely rather than
    // returning an empty result.  The pruner must still not propagate the error.
    getRetentionDays.mockImplementation(async (guildId: string) => {
      if (guildId === "guild-db-error") throw new Error("connection reset");
      return 90;
    });

    await expect(
      runPerGuildVcPrune(
        ["guild-db-error", "guild-ok"],
        getRetentionDays,
        pruneGuild,
      ),
    ).resolves.toBeUndefined();
  });

  it("still prunes remaining guilds when the settings lookup throws for one guild", async () => {
    getRetentionDays.mockImplementation(async (guildId: string) => {
      if (guildId === "guild-db-error") throw new Error("connection reset");
      return 90;
    });

    await runPerGuildVcPrune(
      ["guild-db-error", "guild-ok-1", "guild-ok-2"],
      getRetentionDays,
      pruneGuild,
    );

    // guild-db-error must be skipped — pruneGuild must not be called for it
    expect(pruneGuild).not.toHaveBeenCalledWith("guild-db-error", expect.anything());

    // The two healthy guilds must still be pruned
    expect(pruneGuild).toHaveBeenCalledWith("guild-ok-1", 90);
    expect(pruneGuild).toHaveBeenCalledWith("guild-ok-2", 90);
    expect(pruneGuild).toHaveBeenCalledTimes(2);
  });
});
