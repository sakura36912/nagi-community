/**
 * Tests for runPerGuildVcPrune — the per-guild VC session pruning scheduler.
 *
 * Verifies:
 *   (a) The scheduler reads each guild's retention window via getRetentionDays
 *       before calling pruneGuild.
 *   (b) pruneGuild is called with the value returned by getRetentionDays, not
 *       with a hardcoded fallback (e.g. 180) when a custom window is set.
 *   (c) When multiple guilds are present each is pruned with its own window.
 *   (d) An error thrown for one guild does not prevent the others from being
 *       pruned.
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

describe("runPerGuildVcPrune", () => {
  let getRetentionDays: ReturnType<typeof vi.fn>;
  let pruneGuild: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getRetentionDays = vi.fn();
    pruneGuild = vi.fn().mockResolvedValue(0);
  });

  it("calls pruneGuild with the value returned by getRetentionDays, not a hardcoded fallback", async () => {
    // The stored retention for this guild is 90 days — not the system default.
    getRetentionDays.mockResolvedValue(90);

    await runPerGuildVcPrune(["guild-1"], getRetentionDays, pruneGuild);

    expect(pruneGuild).toHaveBeenCalledOnce();
    expect(pruneGuild).toHaveBeenCalledWith("guild-1", 90);
  });

  it("does NOT call pruneGuild with 180 when the stored retention is 90", async () => {
    getRetentionDays.mockResolvedValue(90);

    await runPerGuildVcPrune(["guild-1"], getRetentionDays, pruneGuild);

    // Confirm the scheduler did not silently fall back to the default.
    expect(pruneGuild).not.toHaveBeenCalledWith("guild-1", 180);
  });

  it("calls getRetentionDays once per guild before pruning", async () => {
    getRetentionDays.mockResolvedValue(60);

    await runPerGuildVcPrune(["guild-a", "guild-b"], getRetentionDays, pruneGuild);

    expect(getRetentionDays).toHaveBeenCalledTimes(2);
    expect(getRetentionDays).toHaveBeenCalledWith("guild-a");
    expect(getRetentionDays).toHaveBeenCalledWith("guild-b");
  });

  it("uses each guild's own retention window independently", async () => {
    // Two guilds with different retention windows.
    getRetentionDays.mockImplementation(async (guildId: string) => {
      if (guildId === "guild-short") return 30;
      if (guildId === "guild-long") return 365;
      return 180;
    });

    await runPerGuildVcPrune(
      ["guild-short", "guild-long"],
      getRetentionDays,
      pruneGuild,
    );

    expect(pruneGuild).toHaveBeenCalledWith("guild-short", 30);
    expect(pruneGuild).toHaveBeenCalledWith("guild-long", 365);
    // Confirm 180 was never used as a silent override for either guild.
    expect(pruneGuild).not.toHaveBeenCalledWith("guild-short", 180);
    expect(pruneGuild).not.toHaveBeenCalledWith("guild-long", 180);
  });

  it("does nothing when the guild list is empty", async () => {
    await runPerGuildVcPrune([], getRetentionDays, pruneGuild);

    expect(getRetentionDays).not.toHaveBeenCalled();
    expect(pruneGuild).not.toHaveBeenCalled();
  });

  it("continues pruning remaining guilds when one throws an error", async () => {
    getRetentionDays.mockImplementation(async (guildId: string) => {
      if (guildId === "guild-bad") throw new Error("DB error");
      return 90;
    });

    // Should not throw — error is caught per-guild.
    await expect(
      runPerGuildVcPrune(["guild-bad", "guild-ok"], getRetentionDays, pruneGuild),
    ).resolves.toBeUndefined();

    // guild-ok must still be pruned despite guild-bad failing.
    expect(pruneGuild).toHaveBeenCalledWith("guild-ok", 90);
    expect(pruneGuild).not.toHaveBeenCalledWith("guild-bad", expect.anything());
  });
});
