/**
 * Tests for the runVcExpiryScheduler private-VC expiry + deletion logic.
 *
 * Because index.ts creates a Discord client on import (and immediately logs in),
 * we cannot import it directly. Instead we inline the exact scheduler logic and
 * inject a mock client — the same pattern used in vc-delete-scheduler.test.ts.
 *
 * Scenarios covered:
 *   1. channel.delete() succeeds → deletePrivateVcSession IS called.
 *   2. channel.delete() throws 50013 on tick 1 → deletePrivateVcSession NOT called, error logged.
 *   3. channel.delete() succeeds on tick 2 after a 50013 on tick 1 → deletePrivateVcSession IS called.
 *   4. Channel is already gone (not in cache / fetch returns null) → deletePrivateVcSession still called.
 *   5. Guild is not in cache → deletePrivateVcSession still called (no channel to delete).
 *   6. Non-permission error (e.g. 10003) → deletePrivateVcSession IS called (channel already gone).
 *   7. ura sessions: permission revocation attempted after channel deletion.
 *   8. ura sessions: permission revocation failure is logged but does not block session cleanup.
 *   9. deleteSchedule is called alongside deletePrivateVcSession so the warning DM scheduler
 *      never sees a stale schedule row for an already-deleted channel.
 *  10. deleteSchedule is NOT called when the bot has missing permissions (channel still alive).
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import { DiscordAPIError } from "discord.js";

/**
 * Build a minimal DiscordAPIError-like object without invoking the real
 * constructor (which requires a fully populated RequestData object).
 * The scheduler only checks `err instanceof DiscordAPIError` and `err.code`,
 * so we fake both via prototype patching.
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

// ─── Hoist mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  getExpiredPrivateVcSessions: vi.fn(),
  deletePrivateVcSession: vi.fn(),
  getGuildSettings: vi.fn(),
  deleteSchedule: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
}));

// ─── Mock lib/economy ────────────────────────────────────────────────────────
vi.mock("../lib/economy.js", () => ({
  getExpiredPrivateVcSessions: mocks.getExpiredPrivateVcSessions,
  deletePrivateVcSession: mocks.deletePrivateVcSession,
  getGuildSettings: mocks.getGuildSettings,
}));

// ─── Mock lib/vc ─────────────────────────────────────────────────────────────
vi.mock("../lib/vc.js", () => ({
  deleteSchedule: mocks.deleteSchedule,
}));

// ─── Mock logger ─────────────────────────────────────────────────────────────
vi.mock("../lib/logger.js", () => ({
  logger: {
    info: mocks.loggerInfo,
    error: mocks.loggerError,
  },
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────
import {
  getExpiredPrivateVcSessions,
  deletePrivateVcSession,
  getGuildSettings,
} from "../lib/economy.js";
import { deleteSchedule } from "../lib/vc.js";
import { logger } from "../lib/logger.js";

// ─── Inline scheduler ────────────────────────────────────────────────────────
// Mirrors the runVcExpiryScheduler function from index.ts exactly, but accepts
// a client parameter so tests can inject a mock.

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
  guilds: {
    cache: Map<string, MockGuild>;
  };
};

async function runVcExpiryScheduler(client: MockClient): Promise<void> {
  const now = new Date();
  const expired = await getExpiredPrivateVcSessions(now);

  for (const session of expired as Array<{
    id: number;
    guildId: string;
    channelId: string;
    userId: string;
    category: string | null;
  }>) {
    let missingPermissions = false;
    let uraRevocationFailed = false;
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
            const settings = await getGuildSettings(session.guildId) as { uraChannelId?: string };
            if (settings.uraChannelId) {
              const accessCh =
                guild.channels.cache.get(settings.uraChannelId) ??
                (await guild.channels.fetch(settings.uraChannelId));
              if (accessCh && "permissionOverwrites" in accessCh && accessCh.permissionOverwrites) {
                await accessCh.permissionOverwrites.delete(session.userId, "裏フリールームVC期限切れ");
                logger.info(
                  `[vc-expiry] Revoked ura channel access for user ${session.userId}`,
                );
              }
            }
          } catch (err) {
            // Do NOT remove the DB row when ura revocation fails — leave the
            // session record intact so the next scheduler tick retries the
            // revocation.  This covers both a transient fetch failure (bot
            // temporarily cannot reach the ura access channel) and a
            // permissionOverwrites.delete failure.  The session row drives the
            // retry: on the next tick the channel is refetched and revocation
            // is attempted again until it succeeds.
            uraRevocationFailed = true;
            logger.error(
              `[vc-expiry] Failed to revoke ura channel access for ${session.userId}`,
              err,
            );
          }
        }
      }
    } catch (err) {
      // DiscordAPIError code 50013 = Missing Permissions.
      // Do NOT remove the DB row — the channel is still alive. Leave the
      // session record intact so the next scheduler tick retries automatically
      // once an admin restores the ManageChannels permission.
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

    // Skip DB cleanup when the channel is still alive but we lack permission,
    // or when the ura access-channel revocation has not yet succeeded — leave
    // the row so the session is retried on the next tick.
    if (missingPermissions || uraRevocationFailed) continue;

    // Remove the session record (channel was deleted or was already gone).
    await deletePrivateVcSession(session.id).catch((err: unknown) =>
      logger.error(`[vc-expiry] Failed to delete session ${session.id}`, err),
    );
    // Remove the schedule row so the pre-expiry warning scheduler does not
    // attempt to DM the user for an already-deleted channel.
    await deleteSchedule(session.channelId).catch((err: unknown) =>
      logger.error(`[vc-expiry] Failed to remove schedule row for ${session.channelId}`, err),
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
    category: null,
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
    uraPermOverwriteDeleteError?: Error;
    /**
     * When set the ura channel is kept out of the channel cache so the
     * scheduler always goes through guild.channels.fetch() for it.  The
     * provided function is used as the fetch implementation, which lets tests
     * simulate a transient failure on tick 1 and a successful fetch on tick 2.
     */
    uraChannelFetch?: ReturnType<typeof vi.fn>;
  } = {},
): MockClient & { _channelDelete: ReturnType<typeof vi.fn> } {
  const channelDelete = opts.channelDelete ?? vi.fn().mockResolvedValue(undefined);

  const vcChannel: MockChannel = opts.channelDeleteError
    ? { delete: vi.fn().mockRejectedValue(opts.channelDeleteError) }
    : { delete: channelDelete };

  const uraPermDelete =
    opts.uraPermOverwriteDeleteError
      ? vi.fn().mockRejectedValue(opts.uraPermOverwriteDeleteError)
      : (opts.uraPermOverwriteDelete ?? vi.fn().mockResolvedValue(undefined));

  const uraChannel: MockChannel = {
    delete: vi.fn().mockResolvedValue(undefined),
    permissionOverwrites: { delete: uraPermDelete },
  };

  // When a custom uraChannelFetch is provided the ura channel is intentionally
  // left out of the cache so that guild.channels.fetch() is always invoked.
  const uraInCache = opts.uraChannelId && !opts.uraChannelFetch;

  const channelCacheEntries: Array<[string, MockChannel]> = [
    ["channel-1", vcChannel],
    ...(uraInCache ? [[opts.uraChannelId as string, uraChannel] as [string, MockChannel]] : []),
  ];

  return {
    _channelDelete: channelDelete,
    guilds: {
      cache: opts.noGuild
        ? new Map()
        : new Map<string, MockGuild>([
            [
              "guild-1",
              {
                channels: {
                  cache: opts.noChannel
                    ? new Map()
                    : new Map(channelCacheEntries),
                  fetch: vi
                    .fn()
                    .mockImplementation((id: string) => {
                      if (opts.noChannel) return Promise.resolve(null);
                      if (id === "channel-1") return Promise.resolve(vcChannel);
                      if (opts.uraChannelId && id === opts.uraChannelId) {
                        // Use the custom fetch fn when provided (supports
                        // first-fail-then-succeed two-tick scenarios).
                        if (opts.uraChannelFetch) return opts.uraChannelFetch(id);
                        return Promise.resolve(uraChannel);
                      }
                      return Promise.resolve(null);
                    }),
                },
              },
            ],
          ]),
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("runVcExpiryScheduler – successful deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deletePrivateVcSession.mockResolvedValue(undefined);
    mocks.deleteSchedule.mockResolvedValue(true);
  });

  it("calls channel.delete() with the correct reason when a session has expired", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([makeSession()]);
    const client = makeClient();

    await runVcExpiryScheduler(client);

    expect(client._channelDelete).toHaveBeenCalledOnce();
    expect(client._channelDelete).toHaveBeenCalledWith("非公開VCの期限切れ");
  });

  it("calls deletePrivateVcSession after a successful channel.delete()", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([makeSession()]);

    await runVcExpiryScheduler(makeClient());

    expect(mocks.deletePrivateVcSession).toHaveBeenCalledOnce();
    expect(mocks.deletePrivateVcSession).toHaveBeenCalledWith(1);
  });

  it("logs a success message after deleting the channel", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([makeSession()]);

    await runVcExpiryScheduler(makeClient());

    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("[vc-expiry] Deleted expired VC channel-1"),
    );
  });

  it("still calls deletePrivateVcSession when the channel is already gone (not in cache)", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([makeSession()]);

    await runVcExpiryScheduler(makeClient({ noChannel: true }));

    // Channel not found — skip deletion but still clean up the DB row.
    expect(mocks.deletePrivateVcSession).toHaveBeenCalledOnce();
  });

  it("still calls deletePrivateVcSession when the guild is not in the cache", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([makeSession()]);

    await runVcExpiryScheduler(makeClient({ noGuild: true }));

    expect(mocks.deletePrivateVcSession).toHaveBeenCalledOnce();
  });

  it("does nothing when there are no expired sessions", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([]);

    await runVcExpiryScheduler(makeClient());

    expect(mocks.deletePrivateVcSession).not.toHaveBeenCalled();
  });
});

describe("runVcExpiryScheduler – 50013 retry path (two-tick)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deletePrivateVcSession.mockResolvedValue(undefined);
    mocks.deleteSchedule.mockResolvedValue(true);
  });

  it("does NOT call deletePrivateVcSession on tick 1 when channel.delete() throws 50013", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([makeSession()]);

    const permError = makeDiscordAPIError(50013, "Missing Permissions");
    const client = makeClient({ channelDeleteError: permError });

    await runVcExpiryScheduler(client);

    expect(mocks.deletePrivateVcSession).not.toHaveBeenCalled();
  });

  it("logs a Missing Permissions error on tick 1", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([makeSession()]);

    const permError = makeDiscordAPIError(50013, "Missing Permissions");
    await runVcExpiryScheduler(makeClient({ channelDeleteError: permError }));

    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("Missing Permissions"),
      permError,
    );
  });

  it("calls deletePrivateVcSession on tick 2 after permissions are restored", async () => {
    const session = makeSession();
    const permError = makeDiscordAPIError(50013, "Missing Permissions");

    // Tick 1: channel.delete() throws 50013 — session row is left in DB.
    const deleteFn = vi
      .fn()
      .mockRejectedValueOnce(permError)   // tick 1: fails
      .mockResolvedValueOnce(undefined);   // tick 2: succeeds

    const client = makeClient({ channelDelete: deleteFn });

    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([session]);
    await runVcExpiryScheduler(client);

    // After tick 1: DB row must NOT have been removed.
    expect(mocks.deletePrivateVcSession).not.toHaveBeenCalled();

    // Tick 2: permissions restored — same session appears again.
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([session]);
    await runVcExpiryScheduler(client);

    // After tick 2: channel was deleted successfully, so DB row is removed.
    expect(mocks.deletePrivateVcSession).toHaveBeenCalledOnce();
    expect(mocks.deletePrivateVcSession).toHaveBeenCalledWith(1);
  });

  it("error message on tick 1 instructs admin to restore ManageChannels permission", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([makeSession()]);

    const permError = makeDiscordAPIError(50013, "Missing Permissions");
    await runVcExpiryScheduler(makeClient({ channelDeleteError: permError }));

    const [msg] = mocks.loggerError.mock.calls[0] as [string, unknown];
    expect(msg).toContain("ManageChannels");
    expect(msg).toContain("next tick");
  });
});

describe("runVcExpiryScheduler – non-permission errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deletePrivateVcSession.mockResolvedValue(undefined);
    mocks.deleteSchedule.mockResolvedValue(true);
  });

  it("calls deletePrivateVcSession even when channel.delete() throws a non-50013 error", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([makeSession()]);

    const otherError = makeDiscordAPIError(10003, "Unknown Channel");
    await runVcExpiryScheduler(makeClient({ channelDeleteError: otherError }));

    // Non-50013 → channel is treated as gone; DB row is cleaned up.
    expect(mocks.deletePrivateVcSession).toHaveBeenCalledOnce();
  });

  it("logs a generic error for non-50013 failures", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([makeSession()]);

    const otherError = makeDiscordAPIError(10003, "Unknown Channel");
    await runVcExpiryScheduler(makeClient({ channelDeleteError: otherError }));

    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("[vc-expiry] Failed to delete channel channel-1"),
      otherError,
    );
  });
});

describe("runVcExpiryScheduler – ura session permission revocation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deletePrivateVcSession.mockResolvedValue(undefined);
    mocks.deleteSchedule.mockResolvedValue(true);
    mocks.getGuildSettings.mockResolvedValue({ uraChannelId: "ura-channel-1" });
  });

  it("revokes ura channel access and logs success after deleting the VC channel", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([
      makeSession({ category: "ura" }),
    ]);

    const uraPermDelete = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({ uraChannelId: "ura-channel-1", uraPermOverwriteDelete: uraPermDelete });

    await runVcExpiryScheduler(client);

    expect(uraPermDelete).toHaveBeenCalledOnce();
    expect(uraPermDelete).toHaveBeenCalledWith("user-1", "裏フリールームVC期限切れ");
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("[vc-expiry] Revoked ura channel access for user user-1"),
    );
  });

  it("logs an error and does NOT call deletePrivateVcSession when ura permission revocation fails (row kept for retry)", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([
      makeSession({ category: "ura" }),
    ]);

    const revokeError = new Error("Cannot edit permissions");
    const client = makeClient({
      uraChannelId: "ura-channel-1",
      uraPermOverwriteDeleteError: revokeError,
    });

    await runVcExpiryScheduler(client);

    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("[vc-expiry] Failed to revoke ura channel access for user-1"),
      revokeError,
    );
    // The session row must be kept so the next tick retries the revocation.
    expect(mocks.deletePrivateVcSession).not.toHaveBeenCalled();
  });

  it("retries ura revocation on tick 2 and cleans up the session row once it succeeds", async () => {
    const session = makeSession({ category: "ura" });
    const revokeError = new Error("Cannot edit permissions");

    // Tick 1: revocation fails → session row is preserved.
    const uraPermDelete = vi
      .fn()
      .mockRejectedValueOnce(revokeError)  // tick 1: fails
      .mockResolvedValueOnce(undefined);   // tick 2: succeeds

    const client = makeClient({
      uraChannelId: "ura-channel-1",
      uraPermOverwriteDelete: uraPermDelete,
    });

    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([session]);
    await runVcExpiryScheduler(client);

    // After tick 1: session row must NOT have been removed.
    expect(mocks.deletePrivateVcSession).not.toHaveBeenCalled();

    // Tick 2: same session reappears (row was kept); revocation succeeds.
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([session]);
    await runVcExpiryScheduler(client);

    // After tick 2: revocation succeeded, so the session row is now removed.
    expect(mocks.deletePrivateVcSession).toHaveBeenCalledOnce();
    expect(mocks.deletePrivateVcSession).toHaveBeenCalledWith(1);
  });

  it("does NOT call deletePrivateVcSession on tick 1 when the ura access-channel fetch fails (row kept for retry)", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([
      makeSession({ category: "ura" }),
    ]);

    const fetchError = new Error("Cannot reach channel");
    // ura channel is not in cache; fetch always rejects on tick 1.
    const uraChannelFetch = vi.fn().mockRejectedValue(fetchError);
    const client = makeClient({ uraChannelId: "ura-channel-1", uraChannelFetch });

    await runVcExpiryScheduler(client);

    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("[vc-expiry] Failed to revoke ura channel access for user-1"),
      fetchError,
    );
    // Session row must be preserved so the next tick can retry revocation.
    expect(mocks.deletePrivateVcSession).not.toHaveBeenCalled();
  });

  it("retries ura revocation on tick 2 when the access-channel was unreachable on tick 1", async () => {
    const session = makeSession({ category: "ura" });
    const fetchError = new Error("Cannot reach channel");

    const uraPermDelete = vi.fn().mockResolvedValue(undefined);
    const uraChannel: MockChannel = {
      delete: vi.fn().mockResolvedValue(undefined),
      permissionOverwrites: { delete: uraPermDelete },
    };

    // Tick 1: fetch rejects → uraRevocationFailed, row kept.
    // Tick 2: fetch resolves → revocation succeeds, row cleaned up.
    const uraChannelFetch = vi
      .fn()
      .mockRejectedValueOnce(fetchError)
      .mockResolvedValueOnce(uraChannel);

    const client = makeClient({ uraChannelId: "ura-channel-1", uraChannelFetch });

    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([session]);
    await runVcExpiryScheduler(client);

    // After tick 1: fetch failed → session row must NOT have been removed.
    expect(mocks.deletePrivateVcSession).not.toHaveBeenCalled();

    // Tick 2: access channel now reachable; revocation and cleanup succeed.
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([session]);
    await runVcExpiryScheduler(client);

    expect(uraPermDelete).toHaveBeenCalledOnce();
    expect(mocks.deletePrivateVcSession).toHaveBeenCalledOnce();
    expect(mocks.deletePrivateVcSession).toHaveBeenCalledWith(1);
  });

  it("does not attempt ura revocation for non-ura sessions", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([
      makeSession({ category: "standard" }),
    ]);

    const uraPermDelete = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({ uraChannelId: "ura-channel-1", uraPermOverwriteDelete: uraPermDelete });

    await runVcExpiryScheduler(client);

    expect(uraPermDelete).not.toHaveBeenCalled();
    expect(mocks.getGuildSettings).not.toHaveBeenCalled();
  });

  it("skips revocation when uraChannelId is not set in guild settings", async () => {
    mocks.getGuildSettings.mockResolvedValue({ uraChannelId: null });
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([
      makeSession({ category: "ura" }),
    ]);

    const uraPermDelete = vi.fn().mockResolvedValue(undefined);
    const client = makeClient({ uraChannelId: "ura-channel-1", uraPermOverwriteDelete: uraPermDelete });

    await runVcExpiryScheduler(client);

    expect(uraPermDelete).not.toHaveBeenCalled();
    // Session is still cleaned up.
    expect(mocks.deletePrivateVcSession).toHaveBeenCalledOnce();
  });
});

// ─── deleteSchedule – ghost-warning-DM prevention ────────────────────────────

describe("runVcExpiryScheduler – deleteSchedule called to prevent ghost warning DMs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deletePrivateVcSession.mockResolvedValue(undefined);
    mocks.deleteSchedule.mockResolvedValue(true);
  });

  it("calls deleteSchedule with the channelId after a successful channel.delete()", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([makeSession()]);

    await runVcExpiryScheduler(makeClient());

    expect(mocks.deleteSchedule).toHaveBeenCalledOnce();
    expect(mocks.deleteSchedule).toHaveBeenCalledWith("channel-1");
  });

  it("calls deleteSchedule even when the channel is already gone (no channel in cache)", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([makeSession()]);

    await runVcExpiryScheduler(makeClient({ noChannel: true }));

    // Channel was already gone — but the schedule row must still be cleaned up.
    expect(mocks.deleteSchedule).toHaveBeenCalledOnce();
    expect(mocks.deleteSchedule).toHaveBeenCalledWith("channel-1");
  });

  it("calls deleteSchedule even when the guild is not in the cache", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([makeSession()]);

    await runVcExpiryScheduler(makeClient({ noGuild: true }));

    expect(mocks.deleteSchedule).toHaveBeenCalledOnce();
    expect(mocks.deleteSchedule).toHaveBeenCalledWith("channel-1");
  });

  it("does NOT call deleteSchedule when the bot lacks permissions (50013 — channel still alive)", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([makeSession()]);

    const permError = makeDiscordAPIError(50013, "Missing Permissions");
    await runVcExpiryScheduler(makeClient({ channelDeleteError: permError }));

    // Channel is still alive — leave the schedule row intact so the warning DM
    // can still fire once permissions are restored and the channel is deleted.
    expect(mocks.deleteSchedule).not.toHaveBeenCalled();
  });

  it("calls deleteSchedule for a non-50013 error (channel treated as already gone)", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([makeSession()]);

    const otherError = makeDiscordAPIError(10003, "Unknown Channel");
    await runVcExpiryScheduler(makeClient({ channelDeleteError: otherError }));

    expect(mocks.deleteSchedule).toHaveBeenCalledOnce();
    expect(mocks.deleteSchedule).toHaveBeenCalledWith("channel-1");
  });

  it("does nothing when there are no expired sessions", async () => {
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([]);

    await runVcExpiryScheduler(makeClient());

    expect(mocks.deleteSchedule).not.toHaveBeenCalled();
  });

  it("does not log an error and still calls deletePrivateVcSession when deleteSchedule returns false (row already removed)", async () => {
    // Simulates the race where runVcDeleteScheduler already removed the
    // schedule row on the same tick — deleteSchedule finds nothing and
    // returns false instead of true.  This is not an error condition.
    mocks.deleteSchedule.mockResolvedValue(false);
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([makeSession()]);

    await runVcExpiryScheduler(makeClient());

    // deleteSchedule was called (the attempt was made).
    expect(mocks.deleteSchedule).toHaveBeenCalledOnce();
    expect(mocks.deleteSchedule).toHaveBeenCalledWith("channel-1");

    // Returning false must not produce any error log.
    expect(mocks.loggerError).not.toHaveBeenCalled();

    // Session row is still cleaned up regardless.
    expect(mocks.deletePrivateVcSession).toHaveBeenCalledOnce();
    expect(mocks.deletePrivateVcSession).toHaveBeenCalledWith(1);
  });
});

// ─── Cross-session isolation ──────────────────────────────────────────────────

describe("runVcExpiryScheduler – cross-session isolation (50013 on one session does not block the other)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deletePrivateVcSession.mockResolvedValue(undefined);
    mocks.deleteSchedule.mockResolvedValue(true);
  });

  /**
   * Build a two-channel client where channel-A throws 50013 and channel-B
   * succeeds, both in the same guild.
   */
  function makeTwoSessionClient(opts: {
    channelADelete: ReturnType<typeof vi.fn>;
    channelBDelete: ReturnType<typeof vi.fn>;
  }): MockClient {
    const channelA: MockChannel = { delete: opts.channelADelete };
    const channelB: MockChannel = { delete: opts.channelBDelete };

    return {
      guilds: {
        cache: new Map<string, MockGuild>([
          [
            "guild-1",
            {
              channels: {
                cache: new Map<string, MockChannel>([
                  ["channel-A", channelA],
                  ["channel-B", channelB],
                ]),
                fetch: vi.fn().mockImplementation((id: string) => {
                  if (id === "channel-A") return Promise.resolve(channelA);
                  if (id === "channel-B") return Promise.resolve(channelB);
                  return Promise.resolve(null);
                }),
              },
            },
          ],
        ]),
      },
    };
  }

  it("calls deletePrivateVcSession exactly once (for session B) when session A throws 50013", async () => {
    const sessionA = makeSession({ id: 10, channelId: "channel-A" });
    const sessionB = makeSession({ id: 20, channelId: "channel-B" });

    const permError = makeDiscordAPIError(50013, "Missing Permissions");
    const deleteA = vi.fn().mockRejectedValue(permError);
    const deleteB = vi.fn().mockResolvedValue(undefined);

    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([sessionA, sessionB]);

    await runVcExpiryScheduler(makeTwoSessionClient({ channelADelete: deleteA, channelBDelete: deleteB }));

    // Session A's 50013 must not prevent session B from being cleaned up.
    expect(mocks.deletePrivateVcSession).toHaveBeenCalledOnce();
    expect(mocks.deletePrivateVcSession).toHaveBeenCalledWith(20);
  });

  it("does NOT call deletePrivateVcSession for session A (50013 row left for retry)", async () => {
    const sessionA = makeSession({ id: 10, channelId: "channel-A" });
    const sessionB = makeSession({ id: 20, channelId: "channel-B" });

    const permError = makeDiscordAPIError(50013, "Missing Permissions");
    const deleteA = vi.fn().mockRejectedValue(permError);
    const deleteB = vi.fn().mockResolvedValue(undefined);

    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([sessionA, sessionB]);

    await runVcExpiryScheduler(makeTwoSessionClient({ channelADelete: deleteA, channelBDelete: deleteB }));

    const calledIds = mocks.deletePrivateVcSession.mock.calls.map(([id]: [number]) => id);
    expect(calledIds).not.toContain(10);
  });

  it("cleans up session A on the next tick once permissions are restored", async () => {
    const sessionA = makeSession({ id: 10, channelId: "channel-A" });
    const sessionB = makeSession({ id: 20, channelId: "channel-B" });

    const permError = makeDiscordAPIError(50013, "Missing Permissions");
    const deleteA = vi
      .fn()
      .mockRejectedValueOnce(permError)   // tick 1: 50013
      .mockResolvedValueOnce(undefined);   // tick 2: success
    const deleteB = vi.fn().mockResolvedValue(undefined);

    const client = makeTwoSessionClient({ channelADelete: deleteA, channelBDelete: deleteB });

    // Tick 1: A fails, B succeeds.
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([sessionA, sessionB]);
    await runVcExpiryScheduler(client);

    expect(mocks.deletePrivateVcSession).toHaveBeenCalledOnce();
    expect(mocks.deletePrivateVcSession).toHaveBeenCalledWith(20);

    vi.clearAllMocks();
    mocks.deletePrivateVcSession.mockResolvedValue(undefined);
    mocks.deleteSchedule.mockResolvedValue(true);

    // Tick 2: only session A remains (B was already removed from DB).
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([sessionA]);
    await runVcExpiryScheduler(client);

    expect(mocks.deletePrivateVcSession).toHaveBeenCalledOnce();
    expect(mocks.deletePrivateVcSession).toHaveBeenCalledWith(10);
  });

  it("logs the 50013 error for session A but does not log an error for session B", async () => {
    const sessionA = makeSession({ id: 10, channelId: "channel-A" });
    const sessionB = makeSession({ id: 20, channelId: "channel-B" });

    const permError = makeDiscordAPIError(50013, "Missing Permissions");
    const deleteA = vi.fn().mockRejectedValue(permError);
    const deleteB = vi.fn().mockResolvedValue(undefined);

    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([sessionA, sessionB]);

    await runVcExpiryScheduler(makeTwoSessionClient({ channelADelete: deleteA, channelBDelete: deleteB }));

    // Exactly one error logged — for session A's 50013.
    expect(mocks.loggerError).toHaveBeenCalledOnce();
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("channel-A"),
      permError,
    );
  });
});

// ─── DB cleanup failure ───────────────────────────────────────────────────────

describe("runVcExpiryScheduler – deletePrivateVcSession failure is logged without crashing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteSchedule.mockResolvedValue(true);
  });

  it("logs an error containing the session id when deletePrivateVcSession rejects", async () => {
    const dbError = new Error("DB connection lost");
    mocks.deletePrivateVcSession.mockRejectedValueOnce(dbError);
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([makeSession({ id: 42 })]);

    await runVcExpiryScheduler(makeClient());

    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("42"),
      dbError,
    );
  });

  it("still processes subsequent sessions after a DB cleanup failure on the first session", async () => {
    const dbError = new Error("DB connection lost");
    // First call rejects, second resolves.
    mocks.deletePrivateVcSession
      .mockRejectedValueOnce(dbError)
      .mockResolvedValueOnce(undefined);

    const sessionA = makeSession({ id: 1, channelId: "channel-1" });
    const sessionB = makeSession({ id: 2, channelId: "channel-2" });

    // Build a client that has both channels available.
    const channelBDelete = vi.fn().mockResolvedValue(undefined);
    const channelB: MockChannel = { delete: channelBDelete };
    const client: MockClient = {
      guilds: {
        cache: new Map<string, MockGuild>([
          [
            "guild-1",
            {
              channels: {
                cache: new Map<string, MockChannel>([
                  ["channel-1", { delete: vi.fn().mockResolvedValue(undefined) }],
                  ["channel-2", channelB],
                ]),
                fetch: vi.fn().mockResolvedValue(null),
              },
            },
          ],
        ]),
      },
    };

    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([sessionA, sessionB]);

    await runVcExpiryScheduler(client);

    // deletePrivateVcSession must have been attempted for both sessions.
    expect(mocks.deletePrivateVcSession).toHaveBeenCalledTimes(2);
    expect(mocks.deletePrivateVcSession).toHaveBeenCalledWith(1);
    expect(mocks.deletePrivateVcSession).toHaveBeenCalledWith(2);
  });

  it("does not throw when deletePrivateVcSession rejects — scheduler run resolves normally", async () => {
    const dbError = new Error("DB connection lost");
    mocks.deletePrivateVcSession.mockRejectedValueOnce(dbError);
    mocks.getExpiredPrivateVcSessions.mockResolvedValueOnce([makeSession()]);

    // Must not throw.
    await expect(runVcExpiryScheduler(makeClient())).resolves.toBeUndefined();
  });
});
