/**
 * Tests for the runVcExpiryScheduler private-VC expiry + retry logic.
 *
 * Because index.ts creates a Discord client on import (and immediately logs in),
 * we cannot import it directly. Instead we inline the exact scheduler logic and
 * inject a mock client — the same pattern used in vc-delete-scheduler.test.ts.
 *
 * Scenarios covered:
 *   1. Channel is deleted and DB row is removed on a normal (successful) tick.
 *   2. DB row is preserved when the bot lacks channel permissions (50013).
 *   3. A Missing Permissions error is logged on the failing tick.
 *   4. DB row is removed on the next tick once permissions are restored.
 *   5. No duplicate log lines or extra deletePrivateVcSession calls across ticks.
 *   6. DB row is still removed when the channel is already gone (not in cache/fetch).
 *   7. Non-50013 errors do NOT preserve the DB row (channel treated as gone).
 *   8. Ura-session permission revocation is attempted and failures are logged separately.
 *   9. Session is skipped (no channel delete, no DB delete) when the guild is absent.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import { DiscordAPIError } from "discord.js";

/**
 * Build a minimal DiscordAPIError-like object without invoking the real
 * constructor (which requires a fully populated RequestData object).
 */
function makeDiscordAPIError(code: number, message: string): DiscordAPIError {
  const err = Object.create(DiscordAPIError.prototype) as DiscordAPIError;
  Object.defineProperties(err, {
    code:    { value: code,     writable: true, enumerable: true, configurable: true },
    message: { value: message,  writable: true, enumerable: true, configurable: true },
    status:  { value: 403,      writable: true, enumerable: true, configurable: true },
    method:  { value: "DELETE", writable: true, enumerable: true, configurable: true },
    url:     { value: "",       writable: true, enumerable: true, configurable: true },
  });
  return err;
}

// ─── Hoist mocks ──────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  getExpiredPrivateVcSessions: vi.fn(),
  deletePrivateVcSession: vi.fn(),
  getGuildSettings: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
}));

// ─── Mock lib/economy ────────────────────────────────────────────────────────
vi.mock("../lib/economy.js", () => ({
  getExpiredPrivateVcSessions: mocks.getExpiredPrivateVcSessions,
  deletePrivateVcSession: mocks.deletePrivateVcSession,
  getGuildSettings: mocks.getGuildSettings,
}));

// ─── Mock logger ─────────────────────────────────────────────────────────────
vi.mock("../lib/logger.js", () => ({
  logger: {
    info:  mocks.loggerInfo,
    error: mocks.loggerError,
  },
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────
import {
  getExpiredPrivateVcSessions,
  deletePrivateVcSession,
  getGuildSettings,
} from "../lib/economy.js";
import { logger } from "../lib/logger.js";

// ─── Inline scheduler ────────────────────────────────────────────────────────
// Mirrors runVcExpiryScheduler from index.ts exactly, but accepts a client
// parameter so tests can inject a mock Discord client.

type MockChannel = {
  delete: (reason: string) => Promise<void>;
  permissionOverwrites?: {
    delete: (userId: string, reason: string) => Promise<void>;
  };
};

type MockGuild = {
  channels: {
    cache: Map<string, MockChannel>;
    fetch: (id: string) => Promise<MockChannel | null>;
  };
};

type MockClient = {
  guilds: { cache: Map<string, MockGuild> };
};

async function runVcExpiryScheduler(client: MockClient): Promise<void> {
  const now = new Date();
  const expired = await getExpiredPrivateVcSessions(now);

  for (const session of expired) {
    let missingPermissions = false;
    try {
      const guild = client.guilds.cache.get(session.guildId);
      if (guild) {
        const channel =
          guild.channels.cache.get(session.channelId) ??
          (await guild.channels.fetch(session.channelId).catch(() => null));
        if (channel) {
          await channel.delete("非公開VCの期限切れ");
          logger.info(
            `[vc-expiry] Deleted expired VC ${session.channelId} for user ${session.userId} in guild ${session.guildId}`,
          );
        }

        // For ura sessions, revoke the access channel permission.
        if (session.category === "ura") {
          try {
            const settings = await getGuildSettings(session.guildId);
            if ((settings as { uraChannelId?: string | null }).uraChannelId) {
              const uraChannelId = (settings as { uraChannelId: string }).uraChannelId;
              const accessCh =
                guild.channels.cache.get(uraChannelId) ??
                (await guild.channels.fetch(uraChannelId).catch(() => null));
              if (accessCh && accessCh.permissionOverwrites) {
                await accessCh.permissionOverwrites.delete(session.userId, "裏フリールームVC期限切れ");
                logger.info(`[vc-expiry] Revoked ura channel access for user ${session.userId}`);
              }
            }
          } catch (err) {
            logger.error(
              `[vc-expiry] Failed to revoke ura channel access for ${session.userId}`,
              err,
            );
          }
        }
      }
    } catch (err) {
      if (err instanceof DiscordAPIError && err.code === 50013) {
        missingPermissions = true;
        logger.error(
          `[vc-expiry] Missing Permissions — cannot delete channel ${session.channelId} ` +
          `for user ${session.userId} in guild ${session.guildId}. ` +
          `Grant the bot ManageChannels permission and the channel will be removed on the next tick.`,
          err,
        );
      } else {
        logger.error(`[vc-expiry] Failed to delete channel ${session.channelId}`, err);
      }
    }

    // Skip DB cleanup when the channel is still alive but we lack permission —
    // leave the row so the session is retried on the next tick.
    if (missingPermissions) continue;

    await deletePrivateVcSession(session.id).catch((err) =>
      logger.error(`[vc-expiry] Failed to delete session ${session.id}`, err),
    );
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    guildId: "guild-1",
    channelId: "channel-1",
    userId: "user-1",
    category: "vc",
    expiresAt: new Date(Date.now() - 60 * 1000), // expired 1 min ago
    ...overrides,
  };
}

function makeClient(
  opts: {
    channelDelete?: ReturnType<typeof vi.fn>;
    channelDeleteError?: Error;
    noGuild?: boolean;
    noChannel?: boolean;
    uraChannelId?: string;
    uraPermOverwriteDelete?: ReturnType<typeof vi.fn>;
    uraPermOverwriteError?: Error;
  } = {},
): MockClient {
  const channelDelete = opts.channelDelete ?? vi.fn().mockResolvedValue(undefined);

  const vcChannel: MockChannel = opts.channelDeleteError
    ? { delete: vi.fn().mockRejectedValue(opts.channelDeleteError) }
    : { delete: channelDelete };

  // Build a simple channel map: just the VC channel.
  const channelMap = new Map<string, MockChannel>();
  if (!opts.noChannel) {
    channelMap.set("channel-1", vcChannel);
  }

  // Optionally add a ura access channel.
  if (opts.uraChannelId) {
    const permOverwriteDelete =
      opts.uraPermOverwriteError
        ? vi.fn().mockRejectedValue(opts.uraPermOverwriteError)
        : (opts.uraPermOverwriteDelete ?? vi.fn().mockResolvedValue(undefined));
    channelMap.set(opts.uraChannelId, {
      delete: vi.fn().mockResolvedValue(undefined),
      permissionOverwrites: { delete: permOverwriteDelete },
    });
  }

  const guild: MockGuild = {
    channels: {
      cache: channelMap,
      fetch: vi.fn().mockResolvedValue(opts.noChannel ? null : vcChannel),
    },
  };

  return {
    guilds: {
      cache: opts.noGuild
        ? new Map()
        : new Map([["guild-1", guild]]),
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("runVcExpiryScheduler – normal expiry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deletePrivateVcSession.mockResolvedValue(undefined);
    mocks.getGuildSettings.mockResolvedValue({ uraChannelId: null });
  });

  it("deletes the Discord channel when the session is expired", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([makeSession()]);
    const client = makeClient();
    const channelDelete = (client.guilds.cache.get("guild-1")!.channels.cache.get("channel-1")!).delete as ReturnType<typeof vi.fn>;

    await runVcExpiryScheduler(client);

    expect(channelDelete).toHaveBeenCalledOnce();
    expect(channelDelete).toHaveBeenCalledWith("非公開VCの期限切れ");
  });

  it("removes the DB row after a successful channel deletion", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([makeSession()]);

    await runVcExpiryScheduler(makeClient());

    expect(mocks.deletePrivateVcSession).toHaveBeenCalledOnce();
    expect(mocks.deletePrivateVcSession).toHaveBeenCalledWith(1);
  });

  it("logs a confirmation after deleting the channel", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([makeSession()]);

    await runVcExpiryScheduler(makeClient());

    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("[vc-expiry] Deleted expired VC channel-1"),
    );
  });

  it("still removes the DB row when the channel is already gone (not in cache / fetch returns null)", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([makeSession()]);

    await runVcExpiryScheduler(makeClient({ noChannel: true }));

    // No channel.delete() needed, but the DB row must still be cleaned up.
    expect(mocks.deletePrivateVcSession).toHaveBeenCalledOnce();
  });

  it("skips channel deletion (but still cleans DB) when the guild is not in the cache", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([makeSession()]);

    await runVcExpiryScheduler(makeClient({ noGuild: true }));

    expect(mocks.deletePrivateVcSession).toHaveBeenCalledOnce();
  });

  it("does nothing when there are no expired sessions", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([]);

    await runVcExpiryScheduler(makeClient());

    expect(mocks.deletePrivateVcSession).not.toHaveBeenCalled();
    expect(mocks.loggerInfo).not.toHaveBeenCalled();
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });
});

describe("runVcExpiryScheduler – Missing Permissions (code 50013)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deletePrivateVcSession.mockResolvedValue(undefined);
    mocks.getGuildSettings.mockResolvedValue({ uraChannelId: null });
  });

  it("does NOT remove the DB row when channel.delete() throws 50013", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([makeSession()]);

    const permError = makeDiscordAPIError(50013, "Missing Permissions");
    await runVcExpiryScheduler(makeClient({ channelDeleteError: permError }));

    expect(mocks.deletePrivateVcSession).not.toHaveBeenCalled();
  });

  it("logs a Missing Permissions error message on the failing tick", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([makeSession()]);

    const permError = makeDiscordAPIError(50013, "Missing Permissions");
    await runVcExpiryScheduler(makeClient({ channelDeleteError: permError }));

    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("Missing Permissions"),
      permError,
    );
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("next tick"),
      permError,
    );
  });

  it("does NOT log an info line for a failed deletion", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([makeSession()]);

    const permError = makeDiscordAPIError(50013, "Missing Permissions");
    await runVcExpiryScheduler(makeClient({ channelDeleteError: permError }));

    expect(mocks.loggerInfo).not.toHaveBeenCalledWith(
      expect.stringContaining("[vc-expiry] Deleted expired VC"),
    );
  });

  it("still removes the DB row for a non-50013 error (channel treated as gone)", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([makeSession()]);

    const otherError = makeDiscordAPIError(10003, "Unknown Channel");
    await runVcExpiryScheduler(makeClient({ channelDeleteError: otherError }));

    expect(mocks.deletePrivateVcSession).toHaveBeenCalledOnce();
  });
});

// ─── Two-tick retry: permission restored between ticks ───────────────────────

describe("runVcExpiryScheduler – retry after permission is restored", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deletePrivateVcSession.mockResolvedValue(undefined);
    mocks.getGuildSettings.mockResolvedValue({ uraChannelId: null });
  });

  it("preserves the DB row on the first tick (50013) and removes it on the second tick once permissions are restored", async () => {
    const session = makeSession();

    // Both ticks see the same session (it was preserved after tick 1).
    mocks.getExpiredPrivateVcSessions.mockResolvedValue([session]);

    // channel.delete() fails with 50013 on the first call, succeeds on the second.
    const channelDelete = vi
      .fn()
      .mockRejectedValueOnce(makeDiscordAPIError(50013, "Missing Permissions"))
      .mockResolvedValueOnce(undefined);

    const client = makeClient({ channelDelete });

    // ── Tick 1: missing permissions ──────────────────────────────────────────
    await runVcExpiryScheduler(client);

    // DB row must NOT be deleted — session must be retried next tick.
    expect(mocks.deletePrivateVcSession).not.toHaveBeenCalled();
    // A Missing Permissions error must be logged.
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("Missing Permissions"),
      expect.anything(),
    );

    // Clear call history so we can make clean assertions for tick 2.
    vi.clearAllMocks();
    mocks.deletePrivateVcSession.mockResolvedValue(undefined);
    mocks.getExpiredPrivateVcSessions.mockResolvedValue([session]);

    // ── Tick 2: permissions restored ─────────────────────────────────────────
    await runVcExpiryScheduler(client);

    // channel.delete() must have been called (the second mock call).
    expect(channelDelete).toHaveBeenCalledTimes(1);
    expect(channelDelete).toHaveBeenCalledWith("非公開VCの期限切れ");
    // DB row must now be cleaned up.
    expect(mocks.deletePrivateVcSession).toHaveBeenCalledOnce();
    expect(mocks.deletePrivateVcSession).toHaveBeenCalledWith(1);
    // No permission error on tick 2.
    expect(mocks.loggerError).not.toHaveBeenCalled();
    // Success info log present.
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("[vc-expiry] Deleted expired VC channel-1"),
    );
  });

  it("does not produce duplicate deletePrivateVcSession calls across two successful ticks", async () => {
    const session = makeSession();

    // Tick 1 returns the session; tick 2 returns nothing (row was already removed).
    mocks.getExpiredPrivateVcSessions
      .mockResolvedValueOnce([session])
      .mockResolvedValueOnce([]);

    const client = makeClient();

    await runVcExpiryScheduler(client); // tick 1
    await runVcExpiryScheduler(client); // tick 2

    // deletePrivateVcSession must be called exactly once total.
    expect(mocks.deletePrivateVcSession).toHaveBeenCalledTimes(1);
  });

  it("no duplicate 'Deleted expired VC' log lines when the session is processed once", async () => {
    const session = makeSession();

    mocks.getExpiredPrivateVcSessions
      .mockResolvedValueOnce([session])
      .mockResolvedValueOnce([]);

    const client = makeClient();

    await runVcExpiryScheduler(client);
    await runVcExpiryScheduler(client);

    const deletedInfoCalls = mocks.loggerInfo.mock.calls.filter(
      (args: unknown[]) =>
        typeof args[0] === "string" && args[0].includes("[vc-expiry] Deleted expired VC"),
    );
    expect(deletedInfoCalls).toHaveLength(1);
  });
});

// ─── Ura session: permission revocation ──────────────────────────────────────

describe("runVcExpiryScheduler – ura session access revocation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deletePrivateVcSession.mockResolvedValue(undefined);
  });

  it("revokes the ura access channel permission for ura sessions", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([
      makeSession({ category: "ura" }),
    ]);
    const permOverwriteDelete = vi.fn().mockResolvedValue(undefined);
    mocks.getGuildSettings.mockResolvedValue({ uraChannelId: "ura-channel-1" });

    const client = makeClient({
      uraChannelId: "ura-channel-1",
      uraPermOverwriteDelete: permOverwriteDelete,
    });

    await runVcExpiryScheduler(client);

    expect(permOverwriteDelete).toHaveBeenCalledOnce();
    expect(permOverwriteDelete).toHaveBeenCalledWith("user-1", "裏フリールームVC期限切れ");
  });

  it("does NOT revoke ura access for non-ura sessions", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([
      makeSession({ category: "vc" }),
    ]);
    mocks.getGuildSettings.mockResolvedValue({ uraChannelId: "ura-channel-1" });

    const permOverwriteDelete = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({
      uraChannelId: "ura-channel-1",
      uraPermOverwriteDelete: permOverwriteDelete,
    });

    await runVcExpiryScheduler(client);

    expect(permOverwriteDelete).not.toHaveBeenCalled();
  });

  it("logs an error if ura permission revocation fails, but still removes the DB row", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([
      makeSession({ category: "ura" }),
    ]);
    const revokeError = new Error("Cannot edit channel");
    mocks.getGuildSettings.mockResolvedValue({ uraChannelId: "ura-channel-1" });

    const client = makeClient({
      uraChannelId: "ura-channel-1",
      uraPermOverwriteError: revokeError,
    });

    await runVcExpiryScheduler(client);

    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("[vc-expiry] Failed to revoke ura channel access"),
      revokeError,
    );
    // DB row must still be cleaned up despite the revocation failure.
    expect(mocks.deletePrivateVcSession).toHaveBeenCalledOnce();
  });
});
