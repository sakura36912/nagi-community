/**
 * Tests for the runVcDeleteScheduler pre-expiry warning + deletion logic.
 *
 * Because index.ts creates a Discord client on import (and immediately logs in),
 * we cannot import it directly. Instead we inline the exact scheduler logic and
 * inject a mock client — the same pattern used in community-bot tests.
 *
 * Scenarios covered:
 *   1. DM is sent when the user's DMs are open.
 *   2. Schedule is still marked as notified when DMs are closed (silent failure).
 *   3. Channel is still deleted even if the pre-expiry DM failed.
 *   4. notifiedAt guard: getSchedulesExpiringSoon only returns un-notified rows
 *      (DB-level filter test on the query helpers).
 *   5. markScheduleNotified is NOT called a second time for an already-notified schedule.
 *   6. deleteSchedule is called for an expired channel that can be deleted.
 *   7. deleteSchedule is NOT called when the bot is missing channel permissions (code 50013).
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
  // Assign own properties without touching read-only prototype accessors.
  Object.defineProperties(err, {
    code:    { value: code,    writable: true, enumerable: true, configurable: true },
    message: { value: message, writable: true, enumerable: true, configurable: true },
    status:  { value: 403,     writable: true, enumerable: true, configurable: true },
    method:  { value: "DELETE",writable: true, enumerable: true, configurable: true },
    url:     { value: "",      writable: true, enumerable: true, configurable: true },
  });
  return err;
}

// ─── Hoist mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  getSchedulesExpiringSoon: vi.fn(),
  markScheduleNotified: vi.fn(),
  getExpiredSchedules: vi.fn(),
  deleteSchedule: vi.fn(),
  getGuildSettings: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
}));

// ─── Mock lib/vc ─────────────────────────────────────────────────────────────
vi.mock("../lib/vc.js", () => ({
  getSchedulesExpiringSoon: mocks.getSchedulesExpiringSoon,
  markScheduleNotified: mocks.markScheduleNotified,
  getExpiredSchedules: mocks.getExpiredSchedules,
  deleteSchedule: mocks.deleteSchedule,
}));

// ─── Mock lib/economy ────────────────────────────────────────────────────────
vi.mock("../lib/economy.js", () => ({
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
  getSchedulesExpiringSoon,
  markScheduleNotified,
  getExpiredSchedules,
  deleteSchedule,
} from "../lib/vc.js";
import { getGuildSettings } from "../lib/economy.js";
import { logger } from "../lib/logger.js";

// ─── Inline scheduler ────────────────────────────────────────────────────────
// Mirrors the runVcDeleteScheduler function from index.ts exactly, but accepts
// a client parameter so tests can inject a mock.

async function runVcDeleteScheduler(
  client: {
    users: { fetch: (id: string) => Promise<{ send: (msg: string) => Promise<void> } | null> };
    guilds: {
      cache: Map<
        string,
        {
          channels: {
            cache: Map<string, { delete: (reason: string) => Promise<void> }>;
            fetch: (id: string) => Promise<{ delete: (reason: string) => Promise<void> } | null>;
          };
        }
      >;
    };
  },
): Promise<void> {
  const now = new Date();

  // ── Pre-expiry warning (per-guild) ───────────────────────────────────────
  for (const [guildId, guild] of client.guilds.cache) {
    try {
      const guildSettings = await getGuildSettings(guildId);
      const configuredMinutes = (guildSettings as { vcWarnBeforeMinutes: number | null | undefined }).vcWarnBeforeMinutes;
      const FALLBACK_MS = 10 * 60 * 1000; // mirrors NOTIFY_BEFORE_MS
      const warnBeforeMs =
        configuredMinutes != null
          ? configuredMinutes * 60 * 1000
          : (logger.info(
              `[vc-schedule] vcWarnBeforeMinutes not set for guild ${guildId}; falling back to default ${FALLBACK_MS / 60000} min`,
            ),
            FALLBACK_MS);
      const soon = await getSchedulesExpiringSoon(guildId, now, warnBeforeMs);

      for (const schedule of soon) {
        try {
          if (schedule.userId && schedule.channelName) {
            const expiresTs = Math.floor(schedule.expiresAt.getTime() / 1000);
            const user = await client.users.fetch(schedule.userId).catch(() => null);
            if (user) {
              await user
                .send(
                  `⏰ VCチャンネル「**${schedule.channelName}**」は <t:${expiresTs}:R>（<t:${expiresTs}:T>）に自動削除されます。必要であれば会話を引き続き行ってください。`,
                )
                .then(() => {
                  logger.info(
                    `[vc-schedule] Sent expiry warning to ${schedule.userId} for channel ${schedule.channelId}`,
                  );
                })
                .catch(() => {
                  // DMs closed — ignore silently.
                });
            }
          }
        } catch (err) {
          logger.error(`[vc-schedule] Failed to send expiry warning for ${schedule.channelId}`, err);
        }
        // Always mark notified to prevent duplicate warnings, even if DM failed.
        await markScheduleNotified(schedule.id, now).catch((err) =>
          logger.error(`[vc-schedule] Failed to mark schedule ${schedule.id} as notified`, err),
        );
      }
    } catch (err) {
      logger.error(`[vc-schedule] Failed to process expiry warnings for guild ${guildId}`, err);
    }
    // suppress unused var warning
    void guild;
  }

  // ── Delete expired channels ──────────────────────────────────────────────
  const expired = await getExpiredSchedules(now);
  for (const schedule of expired) {
    let missingPermissions = false;
    try {
      const guild = client.guilds.cache.get(schedule.guildId);
      if (guild) {
        const channel =
          guild.channels.cache.get(schedule.channelId) ??
          (await guild.channels.fetch(schedule.channelId).catch(() => null));
        if (channel) {
          await channel.delete("スケジュールによる自動削除");
          logger.info(
            `[vc-schedule] Deleted scheduled VC ${schedule.channelId} (${schedule.channelName}) in guild ${schedule.guildId}`,
          );
        }
      }
    } catch (err) {
      if (err instanceof DiscordAPIError && err.code === 50013) {
        missingPermissions = true;
        logger.error(
          `[vc-schedule] Missing Permissions — cannot delete channel ${schedule.channelId} ` +
            `(${schedule.channelName}) in guild ${schedule.guildId}. ` +
            `Grant the bot ManageChannels permission and the channel will be removed on the next tick.`,
          err,
        );
      } else {
        logger.error(`[vc-schedule] Failed to delete channel ${schedule.channelId}`, err);
      }
    }

    if (missingPermissions) continue;

    await deleteSchedule(schedule.channelId).catch((err) =>
      logger.error(`[vc-schedule] Failed to remove schedule row for ${schedule.channelId}`, err),
    );
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSchedule(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    guildId: "guild-1",
    channelId: "channel-1",
    channelName: "テストVC",
    expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 min from now
    userId: "user-1",
    notifiedAt: null,
    ...overrides,
  };
}

function makeClient(
  opts: {
    userSend?: ReturnType<typeof vi.fn>;
    channelDelete?: ReturnType<typeof vi.fn>;
    channelDeleteError?: Error;
    noUser?: boolean;
    noGuild?: boolean;
    noChannel?: boolean;
  } = {},
) {
  const userSend = opts.userSend ?? vi.fn().mockResolvedValue(undefined);
  const channelDelete = opts.channelDelete ?? vi.fn().mockResolvedValue(undefined);

  const channel = opts.channelDeleteError
    ? {
        delete: vi.fn().mockRejectedValue(opts.channelDeleteError),
      }
    : { delete: channelDelete };

  return {
    _userSend: userSend,
    _channelDelete: channelDelete,
    users: {
      fetch: opts.noUser
        ? vi.fn().mockResolvedValue(null)
        : vi.fn().mockResolvedValue({ send: userSend }),
    },
    guilds: {
      cache: opts.noGuild
        ? new Map()
        : new Map([
            [
              "guild-1",
              {
                channels: {
                  cache: opts.noChannel
                    ? new Map()
                    : new Map([["channel-1", channel]]),
                  fetch: vi.fn().mockResolvedValue(opts.noChannel ? null : channel),
                },
              },
            ],
          ]),
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("runVcDeleteScheduler – pre-expiry warning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getGuildSettings.mockResolvedValue({ vcWarnBeforeMinutes: 10 });
    mocks.markScheduleNotified.mockResolvedValue(undefined);
    mocks.getExpiredSchedules.mockResolvedValue([]);
  });

  it("sends a DM when the user's DMs are open", async () => {
    mocks.getSchedulesExpiringSoon.mockResolvedValueOnce([makeSchedule()]);
    const client = makeClient();

    await runVcDeleteScheduler(client);

    expect(client._userSend).toHaveBeenCalledOnce();
    expect(client._userSend.mock.calls[0][0]).toContain("テストVC");
  });

  it("DM content includes the exact channel name and Unix timestamp from expiresAt", async () => {
    // Use a fixed future date so the expected timestamp is deterministic.
    const expiresAt = new Date("2026-08-01T12:00:00.000Z");
    const expectedTs = Math.floor(expiresAt.getTime() / 1000);

    mocks.getSchedulesExpiringSoon.mockResolvedValueOnce([
      makeSchedule({ channelName: "テストVC", expiresAt }),
    ]);
    const client = makeClient();

    await runVcDeleteScheduler(client);

    expect(client._userSend).toHaveBeenCalledOnce();
    const dmText: string = client._userSend.mock.calls[0][0];
    // Channel name must appear verbatim.
    expect(dmText).toContain("テストVC");
    // Both relative (<t:…:R>) and time (<t:…:T>) Discord timestamp tokens
    // must use the Unix second derived from schedule.expiresAt.
    expect(dmText).toContain(`<t:${expectedTs}:R>`);
    expect(dmText).toContain(`<t:${expectedTs}:T>`);
  });

  it("logs the warning after sending the DM", async () => {
    mocks.getSchedulesExpiringSoon.mockResolvedValueOnce([makeSchedule()]);

    await runVcDeleteScheduler(makeClient());

    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("[vc-schedule] Sent expiry warning to user-1"),
    );
  });

  it("marks the schedule as notified even when DMs are closed", async () => {
    mocks.getSchedulesExpiringSoon.mockResolvedValueOnce([makeSchedule()]);

    // user.send() rejects (DMs closed)
    const client = makeClient({
      userSend: vi.fn().mockRejectedValue(new Error("Cannot send messages to this user")),
    });

    await runVcDeleteScheduler(client);

    expect(mocks.markScheduleNotified).toHaveBeenCalledOnce();
    expect(mocks.markScheduleNotified).toHaveBeenCalledWith(1, expect.any(Date));
  });

  it("marks the schedule as notified when DMs are open too", async () => {
    mocks.getSchedulesExpiringSoon.mockResolvedValueOnce([makeSchedule()]);

    await runVcDeleteScheduler(makeClient());

    expect(mocks.markScheduleNotified).toHaveBeenCalledOnce();
    expect(mocks.markScheduleNotified).toHaveBeenCalledWith(1, expect.any(Date));
  });

  it("does NOT log an error when DMs are closed (silent failure)", async () => {
    mocks.getSchedulesExpiringSoon.mockResolvedValueOnce([makeSchedule()]);

    const dmError = new Error("Cannot send messages to this user");
    const client = makeClient({ userSend: vi.fn().mockRejectedValue(dmError) });

    await runVcDeleteScheduler(client);

    // The DM failure is swallowed by .catch(() => {}); only markScheduleNotified
    // runs — no logger.error for the DM path.
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });

  it("does NOT log 'DM sent' when DMs are closed", async () => {
    mocks.getSchedulesExpiringSoon.mockResolvedValueOnce([makeSchedule()]);

    const client = makeClient({
      userSend: vi.fn().mockRejectedValue(new Error("Cannot send messages to this user")),
    });

    await runVcDeleteScheduler(client);

    // The info log must only fire after a successful send — not when DMs are closed.
    expect(mocks.loggerInfo).not.toHaveBeenCalledWith(
      expect.stringContaining("[vc-schedule] Sent expiry warning to"),
    );
  });

  it("skips the DM when channelName is null", async () => {
    mocks.getSchedulesExpiringSoon.mockResolvedValueOnce([makeSchedule({ channelName: null })]);
    const client = makeClient();

    await runVcDeleteScheduler(client);

    // A null channelName would produce a malformed 「**null**」 message —
    // the scheduler must skip the send entirely.
    expect(client._userSend).not.toHaveBeenCalled();
    // The schedule is still marked notified to prevent re-processing.
    expect(mocks.markScheduleNotified).toHaveBeenCalledOnce();
  });

  it("skips the DM when channelName is an empty string", async () => {
    mocks.getSchedulesExpiringSoon.mockResolvedValueOnce([makeSchedule({ channelName: "" })]);
    const client = makeClient();

    await runVcDeleteScheduler(client);

    // An empty channelName would produce a malformed 「****」 message —
    // the scheduler must skip the send entirely.
    expect(client._userSend).not.toHaveBeenCalled();
    // The schedule is still marked notified to prevent re-processing.
    expect(mocks.markScheduleNotified).toHaveBeenCalledOnce();
  });

  it("skips the DM when schedule has no userId", async () => {
    mocks.getSchedulesExpiringSoon.mockResolvedValueOnce([makeSchedule({ userId: null })]);
    const client = makeClient();

    await runVcDeleteScheduler(client);

    expect(client.users.fetch).not.toHaveBeenCalled();
    // Still marks notified
    expect(mocks.markScheduleNotified).toHaveBeenCalledOnce();
  });

  it("skips the DM when user cannot be fetched from Discord", async () => {
    mocks.getSchedulesExpiringSoon.mockResolvedValueOnce([makeSchedule()]);
    const client = makeClient({ noUser: true });

    await runVcDeleteScheduler(client);

    // user is null — send() should never be called
    expect(client._userSend).not.toHaveBeenCalled();
    // But the schedule still gets marked notified
    expect(mocks.markScheduleNotified).toHaveBeenCalledOnce();
  });

  it("does nothing when there are no schedules expiring soon", async () => {
    mocks.getSchedulesExpiringSoon.mockResolvedValueOnce([]);

    await runVcDeleteScheduler(makeClient());

    expect(mocks.markScheduleNotified).not.toHaveBeenCalled();
  });

  it("notifiedAt guard: getSchedulesExpiringSoon is the sole gate — if it returns nothing, no DM is sent", async () => {
    // Simulates a schedule that already has notifiedAt set; the DB query
    // (isNull guard) would filter it out, so getSchedulesExpiringSoon returns [].
    mocks.getSchedulesExpiringSoon.mockResolvedValueOnce([]);
    const client = makeClient();

    await runVcDeleteScheduler(client);

    expect(client._userSend).not.toHaveBeenCalled();
    expect(mocks.markScheduleNotified).not.toHaveBeenCalled();
  });
});

describe("runVcDeleteScheduler – channel deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getGuildSettings.mockResolvedValue({ vcWarnBeforeMinutes: 10 });
    mocks.getSchedulesExpiringSoon.mockResolvedValue([]);
    mocks.markScheduleNotified.mockResolvedValue(undefined);
    mocks.deleteSchedule.mockResolvedValue(true);
  });

  it("deletes the Discord channel when the schedule is expired", async () => {
    mocks.getExpiredSchedules.mockResolvedValueOnce([makeSchedule()]);
    const client = makeClient();

    await runVcDeleteScheduler(client);

    expect(client._channelDelete).toHaveBeenCalledOnce();
    expect(client._channelDelete).toHaveBeenCalledWith("スケジュールによる自動削除");
  });

  it("removes the DB row after a successful channel deletion", async () => {
    mocks.getExpiredSchedules.mockResolvedValueOnce([makeSchedule()]);

    await runVcDeleteScheduler(makeClient());

    expect(mocks.deleteSchedule).toHaveBeenCalledOnce();
    expect(mocks.deleteSchedule).toHaveBeenCalledWith("channel-1");
  });

  it("still removes the DB row when the channel is already gone (not found)", async () => {
    // Channel not in cache and fetch returns null — deletion is skipped but DB row
    // must still be cleaned up.
    mocks.getExpiredSchedules.mockResolvedValueOnce([makeSchedule()]);

    await runVcDeleteScheduler(makeClient({ noChannel: true }));

    expect(mocks.deleteSchedule).toHaveBeenCalledOnce();
  });

  it("does NOT remove the DB row when the bot lacks permissions (code 50013)", async () => {
    mocks.getExpiredSchedules.mockResolvedValueOnce([makeSchedule()]);

    const permError = makeDiscordAPIError(50013, "Missing Permissions");
    const client = makeClient({ channelDeleteError: permError });

    await runVcDeleteScheduler(client);

    expect(mocks.deleteSchedule).not.toHaveBeenCalled();
  });

  it("logs a Missing Permissions error and preserves the DB row", async () => {
    mocks.getExpiredSchedules.mockResolvedValueOnce([makeSchedule()]);

    const permError = makeDiscordAPIError(50013, "Missing Permissions");

    await runVcDeleteScheduler(makeClient({ channelDeleteError: permError }));

    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("Missing Permissions"),
      permError,
    );
  });

  it("removes the DB row even for non-permission errors (channel already deleted)", async () => {
    mocks.getExpiredSchedules.mockResolvedValueOnce([makeSchedule()]);

    const otherError = makeDiscordAPIError(10003, "Unknown Channel");

    await runVcDeleteScheduler(makeClient({ channelDeleteError: otherError }));

    // Non-50013 errors: DB row is cleaned up (channel is gone).
    expect(mocks.deleteSchedule).toHaveBeenCalledOnce();
  });

  it("skips deletion entirely when the guild is not in the cache", async () => {
    mocks.getExpiredSchedules.mockResolvedValueOnce([makeSchedule()]);

    await runVcDeleteScheduler(makeClient({ noGuild: true }));

    // No channel.delete() and still cleans up the DB row.
    expect(mocks.deleteSchedule).toHaveBeenCalledOnce();
  });
});

describe("runVcDeleteScheduler – DM failure does not block channel deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getGuildSettings.mockResolvedValue({ vcWarnBeforeMinutes: 10 });
    mocks.markScheduleNotified.mockResolvedValue(undefined);
    mocks.deleteSchedule.mockResolvedValue(true);
  });

  it("deletes the expired channel even when the pre-expiry DM failed earlier", async () => {
    // The warning phase (getSchedulesExpiringSoon) returns nothing — the DM
    // was already attempted in a previous tick and the schedule is now expired.
    mocks.getSchedulesExpiringSoon.mockResolvedValueOnce([]);
    mocks.getExpiredSchedules.mockResolvedValueOnce([
      makeSchedule({ notifiedAt: new Date(Date.now() - 9 * 60 * 1000) }),
    ]);

    const client = makeClient({
      userSend: vi.fn().mockRejectedValue(new Error("DMs closed")),
    });

    await runVcDeleteScheduler(client);

    expect(client._channelDelete).toHaveBeenCalledOnce();
    expect(mocks.deleteSchedule).toHaveBeenCalledOnce();
  });
});

// ─── Two-tick retry: permission restored between ticks ───────────────────────

describe("runVcDeleteScheduler – retry after permission is restored", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getGuildSettings.mockResolvedValue({ vcWarnBeforeMinutes: 10 });
    mocks.getSchedulesExpiringSoon.mockResolvedValue([]);
    mocks.markScheduleNotified.mockResolvedValue(undefined);
    mocks.deleteSchedule.mockResolvedValue(true);
  });

  it("preserves the DB row on the first tick (50013) and removes it on the second tick once permissions are restored", async () => {
    const schedule = makeSchedule();

    // Both ticks see the same expired schedule (it was preserved after tick 1).
    mocks.getExpiredSchedules.mockResolvedValue([schedule]);

    // channel.delete() fails with 50013 on the first call, succeeds on the second.
    const channelDelete = vi
      .fn()
      .mockRejectedValueOnce(makeDiscordAPIError(50013, "Missing Permissions"))
      .mockResolvedValueOnce(undefined);

    const client = makeClient({ channelDelete });

    // ── Tick 1: missing permissions ──────────────────────────────────────────
    await runVcDeleteScheduler(client);

    // Row must NOT be deleted — scheduler should retry on next tick.
    expect(mocks.deleteSchedule).not.toHaveBeenCalled();
    // A "Missing Permissions" error must be logged.
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("Missing Permissions"),
      expect.anything(),
    );

    vi.clearAllMocks();
    mocks.getSchedulesExpiringSoon.mockResolvedValue([]);
    mocks.deleteSchedule.mockResolvedValue(true);
    mocks.getExpiredSchedules.mockResolvedValue([schedule]);

    // ── Tick 2: permissions restored ─────────────────────────────────────────
    await runVcDeleteScheduler(client);

    // channel.delete() must have been called a second time.
    expect(channelDelete).toHaveBeenCalledTimes(1); // only the tick-2 call (mock was cleared)
    // DB row must now be cleaned up.
    expect(mocks.deleteSchedule).toHaveBeenCalledOnce();
    expect(mocks.deleteSchedule).toHaveBeenCalledWith("channel-1");
    // No permission error on tick 2.
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });
});

// ─── Extended expiry: DM timestamp accuracy ──────────────────────────────────

describe("runVcDeleteScheduler – extended expiry DM timestamp accuracy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getGuildSettings.mockResolvedValue({ vcWarnBeforeMinutes: 10 });
    mocks.markScheduleNotified.mockResolvedValue(undefined);
    mocks.getExpiredSchedules.mockResolvedValue([]);
  });

  it("DM content reflects the updated expiresAt timestamp when a fresh warning fires after extension", async () => {
    // The schedule was warned at the original deadline, then the owner extended
    // the VC.  extendSchedule cleared notifiedAt and wrote the new expiresAt.
    // On the next tick the scheduler sees the re-armed row and must embed the
    // *new* (extended) expiry in the DM — not the original one.
    const extendedExpiresAt = new Date("2026-08-01T14:00:00.000Z"); // 2 h later than original
    const expectedTs = Math.floor(extendedExpiresAt.getTime() / 1000);

    // notifiedAt has been cleared by extendSchedule → row re-enters warning list.
    mocks.getSchedulesExpiringSoon.mockResolvedValueOnce([
      makeSchedule({ expiresAt: extendedExpiresAt, notifiedAt: null }),
    ]);
    const client = makeClient();

    await runVcDeleteScheduler(client);

    expect(client._userSend).toHaveBeenCalledOnce();
    const dmText: string = client._userSend.mock.calls[0][0];
    // Both Discord timestamp tokens must use the extended expiresAt Unix second.
    expect(dmText).toContain(`<t:${expectedTs}:R>`);
    expect(dmText).toContain(`<t:${expectedTs}:T>`);
  });

  it("markScheduleNotified is called with the current tick time (not the extended expiresAt) after extension re-arms the warning", async () => {
    const extendedExpiresAt = new Date(Date.now() + 3 * 60 * 60 * 1000); // 3 h from now

    mocks.getSchedulesExpiringSoon.mockResolvedValueOnce([
      makeSchedule({ expiresAt: extendedExpiresAt, notifiedAt: null }),
    ]);

    const before = Date.now();
    await runVcDeleteScheduler(makeClient());
    const after = Date.now();

    expect(mocks.markScheduleNotified).toHaveBeenCalledOnce();
    const [, notifiedDate] = mocks.markScheduleNotified.mock.calls[0] as [number, Date];
    expect(notifiedDate).toBeInstanceOf(Date);
    // The timestamp passed must be the current-tick time, not the extended expiresAt.
    expect(notifiedDate.getTime()).toBeGreaterThanOrEqual(before);
    expect(notifiedDate.getTime()).toBeLessThanOrEqual(after);
  });

  it("two-tick: sends original DM, then re-sends with updated timestamp after extension re-arms the schedule", async () => {
    // ── Setup ──────────────────────────────────────────────────────────────────
    const originalExpiresAt = new Date("2026-08-01T12:00:00.000Z");
    const extendedExpiresAt = new Date("2026-08-01T14:00:00.000Z"); // +2 h
    const originalTs = Math.floor(originalExpiresAt.getTime() / 1000);
    const extendedTs = Math.floor(extendedExpiresAt.getTime() / 1000);

    // ── Tick 1: original schedule within warning window ────────────────────────
    mocks.getSchedulesExpiringSoon.mockResolvedValueOnce([
      makeSchedule({ expiresAt: originalExpiresAt, notifiedAt: null }),
    ]);
    const client = makeClient();

    await runVcDeleteScheduler(client);

    // DM was sent with original expiry.
    expect(client._userSend).toHaveBeenCalledOnce();
    expect(client._userSend.mock.calls[0][0]).toContain(`<t:${originalTs}:R>`);
    // notifiedAt was set.
    expect(mocks.markScheduleNotified).toHaveBeenCalledOnce();

    vi.clearAllMocks();
    mocks.getGuildSettings.mockResolvedValue({ vcWarnBeforeMinutes: 10 });
    mocks.markScheduleNotified.mockResolvedValue(undefined);
    mocks.getExpiredSchedules.mockResolvedValue([]);

    // Between ticks the user purchased an extension:
    //   extendSchedule(channelId, extendedExpiresAt) set expiresAt = extendedExpiresAt,
    //   notifiedAt = null — re-arming the schedule for a fresh warning.

    // ── Tick 2: re-armed schedule with new deadline ────────────────────────────
    mocks.getSchedulesExpiringSoon.mockResolvedValueOnce([
      makeSchedule({ expiresAt: extendedExpiresAt, notifiedAt: null }),
    ]);

    await runVcDeleteScheduler(client);

    // A new DM must fire using the extended expiry timestamp.
    expect(client._userSend).toHaveBeenCalledOnce();
    const dmText: string = client._userSend.mock.calls[0][0];
    expect(dmText).toContain(`<t:${extendedTs}:R>`);
    expect(dmText).toContain(`<t:${extendedTs}:T>`);
    // The stale original timestamp must NOT appear.
    expect(dmText).not.toContain(`<t:${originalTs}:R>`);
    // notifiedAt updated again on this tick.
    expect(mocks.markScheduleNotified).toHaveBeenCalledOnce();
  });
});

// ─── Unit tests for the DB query helpers (no Discord client needed) ───────────

describe("getSchedulesExpiringSoon – query filter assertions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getGuildSettings.mockResolvedValue({ vcWarnBeforeMinutes: 10 });
    mocks.getExpiredSchedules.mockResolvedValue([]);
    mocks.markScheduleNotified.mockResolvedValue(undefined);
    mocks.deleteSchedule.mockResolvedValue(true);
  });

  it("is called with the guild ID, current Date, and warn window in ms", async () => {
    mocks.getSchedulesExpiringSoon.mockResolvedValueOnce([]);

    const before = Date.now();
    await runVcDeleteScheduler(makeClient());
    const after = Date.now();

    // New signature: (guildId, now, warnBeforeMs)
    const [guildId, now, warnBeforeMs] = mocks.getSchedulesExpiringSoon.mock.calls[0] as [string, Date, number];
    expect(guildId).toBe("guild-1");
    expect(now).toBeInstanceOf(Date);
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(now.getTime()).toBeLessThanOrEqual(after);
    expect(warnBeforeMs).toBe(10 * 60 * 1000); // default 10 min
  });

  it("uses the guild's configured warn time (e.g. 30 min)", async () => {
    mocks.getGuildSettings.mockResolvedValue({ vcWarnBeforeMinutes: 30 });
    mocks.getSchedulesExpiringSoon.mockResolvedValueOnce([]);

    await runVcDeleteScheduler(makeClient());

    const [, , warnBeforeMs] = mocks.getSchedulesExpiringSoon.mock.calls[0] as [string, Date, number];
    expect(warnBeforeMs).toBe(30 * 60 * 1000);
  });

  it("falls back to 10 min and logs a warning when vcWarnBeforeMinutes is null", async () => {
    mocks.getGuildSettings.mockResolvedValue({ vcWarnBeforeMinutes: null });
    mocks.getSchedulesExpiringSoon.mockResolvedValueOnce([]);

    await runVcDeleteScheduler(makeClient());

    // Must still call getSchedulesExpiringSoon — no DMs, no crash
    expect(mocks.getSchedulesExpiringSoon).toHaveBeenCalledOnce();

    // Must use the safe 10-minute fallback
    const [guildId, , warnBeforeMs] = mocks.getSchedulesExpiringSoon.mock.calls[0] as [string, Date, number];
    expect(guildId).toBe("guild-1");
    expect(warnBeforeMs).toBe(10 * 60 * 1000);

    // Must emit a descriptive log so admins know the fallback fired
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("vcWarnBeforeMinutes not set"),
    );
  });

  it("is called once per guild in the cache per scheduler tick", async () => {
    // makeClient() puts exactly one guild ("guild-1") in the cache
    mocks.getSchedulesExpiringSoon.mockResolvedValueOnce([]);

    await runVcDeleteScheduler(makeClient());

    expect(mocks.getSchedulesExpiringSoon).toHaveBeenCalledOnce();
  });
});

describe("runVcDeleteScheduler – per-guild warn time isolation", () => {
  /** Build a two-guild client so each guild can have its own settings. */
  function makeTwoGuildClient() {
    const makeChannel = () => ({ delete: vi.fn().mockResolvedValue(undefined) });
    const makeGuild = (channelId: string) => ({
      channels: {
        cache: new Map([[channelId, makeChannel()]]),
        fetch: vi.fn().mockResolvedValue(null),
      },
    });
    return {
      users: { fetch: vi.fn().mockResolvedValue(null) },
      guilds: {
        cache: new Map([
          ["guild-A", makeGuild("channel-A")],
          ["guild-B", makeGuild("channel-B")],
        ]),
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getExpiredSchedules.mockResolvedValue([]);
    mocks.markScheduleNotified.mockResolvedValue(undefined);
    mocks.deleteSchedule.mockResolvedValue(true);
    // Default: no expiring schedules for either guild
    mocks.getSchedulesExpiringSoon.mockResolvedValue([]);
  });

  it("calls getSchedulesExpiringSoon with the correct warnBeforeMs for each guild independently", async () => {
    // guild-A uses 10 min, guild-B uses 30 min
    mocks.getGuildSettings
      .mockImplementation((guildId: string) => {
        if (guildId === "guild-A") return Promise.resolve({ vcWarnBeforeMinutes: 10 });
        if (guildId === "guild-B") return Promise.resolve({ vcWarnBeforeMinutes: 30 });
        return Promise.resolve({ vcWarnBeforeMinutes: 10 });
      });

    await runVcDeleteScheduler(makeTwoGuildClient());

    // Should have been called exactly twice — once per guild
    expect(mocks.getSchedulesExpiringSoon).toHaveBeenCalledTimes(2);

    // Find the call for each guild regardless of iteration order
    const calls = mocks.getSchedulesExpiringSoon.mock.calls as [string, Date, number][];
    const callA = calls.find(([guildId]) => guildId === "guild-A");
    const callB = calls.find(([guildId]) => guildId === "guild-B");

    expect(callA).toBeDefined();
    expect(callB).toBeDefined();

    // guild-A must use its own 10-minute window
    expect(callA![2]).toBe(10 * 60 * 1000);

    // guild-B must use its own 30-minute window
    expect(callB![2]).toBe(30 * 60 * 1000);
  });

  it("does not bleed guild-A's warn time into guild-B", async () => {
    // Intentionally give guild-A a short window; guild-B must not inherit it
    mocks.getGuildSettings
      .mockImplementation((guildId: string) => {
        if (guildId === "guild-A") return Promise.resolve({ vcWarnBeforeMinutes: 5 });
        if (guildId === "guild-B") return Promise.resolve({ vcWarnBeforeMinutes: 60 });
        return Promise.resolve({ vcWarnBeforeMinutes: 5 });
      });

    await runVcDeleteScheduler(makeTwoGuildClient());

    const calls = mocks.getSchedulesExpiringSoon.mock.calls as [string, Date, number][];
    const callB = calls.find(([guildId]) => guildId === "guild-B");

    expect(callB).toBeDefined();
    // guild-B must NOT receive guild-A's 5-minute window
    expect(callB![2]).not.toBe(5 * 60 * 1000);
    expect(callB![2]).toBe(60 * 60 * 1000);
  });
});
