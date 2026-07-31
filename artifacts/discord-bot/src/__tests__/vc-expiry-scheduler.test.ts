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
                (await guild.channels.fetch(settings.uraChannelId).catch(() => null));
              if (accessCh && "permissionOverwrites" in accessCh && accessCh.permissionOverwrites) {
                await accessCh.permissionOverwrites.delete(session.userId, "裏フリールームVC期限切れ");
                logger.info(
                  `[vc-expiry] Revoked ura channel access for user ${session.userId}`,
                );
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

    // Skip DB cleanup when the channel is still alive but we lack permission —
    // leave the row so the session is retried on the next tick.
    if (missingPermissions) continue;

    // Remove the session record (channel was deleted or was already gone).
    await deletePrivateVcSession(session.id).catch((err: unknown) =>
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

  const channelCacheEntries: Array<[string, MockChannel]> = [
    ["channel-1", vcChannel],
    ...(opts.uraChannelId ? [[opts.uraChannelId, uraChannel] as [string, MockChannel]] : []),
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
                      if (opts.uraChannelId && id === opts.uraChannelId)
                        return Promise.resolve(uraChannel);
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

  it("logs an error when ura permission revocation fails, but still calls deletePrivateVcSession", async () => {
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
    // The outer try/catch swallows the ura error; session cleanup must still run.
    expect(mocks.deletePrivateVcSession).toHaveBeenCalledOnce();
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
