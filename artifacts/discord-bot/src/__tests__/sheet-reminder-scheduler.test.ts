/**
 * Tests for the runSheetReminderScheduler logic.
 *
 * Because index.ts creates a Discord client on import (and immediately logs in),
 * we cannot import it directly.  Instead we inline the exact scheduler logic and
 * inject a mock bot — the same pattern used in vc-delete-scheduler tests.
 *
 * Scenarios covered:
 *   1. logger.info fires after a successful thread.send().
 *   2. logger.info does NOT fire when thread.send() rejects.
 *   3. markSheetReminderSent is called even when send() rejects (no retry-spam).
 *   4. markSheetReminderSent is called when the sheet has no messageId.
 *   5. markSheetReminderSent is called when the thread cannot be fetched.
 *   6. markSheetReminderSent is called when the channel has no send method.
 *   7. logger.error fires (not logger.info) when send() rejects.
 *   8. Nothing happens when there are no sheets needing reminders.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ─── Hoist mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  listSheetsNeedingReminder: vi.fn(),
  markSheetReminderSent: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
}));

// ─── Mock lib/economy ────────────────────────────────────────────────────────
vi.mock("../lib/economy.js", () => ({
  listSheetsNeedingReminder: mocks.listSheetsNeedingReminder,
  markSheetReminderSent: mocks.markSheetReminderSent,
}));

// ─── Mock logger ─────────────────────────────────────────────────────────────
vi.mock("../lib/logger.js", () => ({
  logger: {
    info: mocks.loggerInfo,
    error: mocks.loggerError,
  },
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────
import { listSheetsNeedingReminder, markSheetReminderSent } from "../lib/economy.js";
import { logger } from "../lib/logger.js";

// ─── Minimal EmbedBuilder stub ───────────────────────────────────────────────
// We don't need a real Discord embed in unit tests — just a chainable stub.
class StubEmbedBuilder {
  setTitle(_: string) { return this; }
  setColor(_: number) { return this; }
  setDescription(_: string) { return this; }
  setTimestamp() { return this; }
}

// ─── Inline scheduler ────────────────────────────────────────────────────────
// Mirrors runSheetReminderScheduler from index.ts exactly, replacing
// discord.js EmbedBuilder with the stub and accepting a bot parameter so
// tests can inject a mock.

type MockThread = {
  isTextBased: () => boolean;
  send?: (opts: unknown) => Promise<void>;
};

type MockBot = {
  channels: {
    fetch: (id: string) => Promise<MockThread | null>;
  };
};

async function runSheetReminderScheduler(bot: MockBot): Promise<void> {
  const sheets = await listSheetsNeedingReminder();
  for (const sheet of sheets) {
    try {
      // messageId holds the forum thread ID (thread.id == starterMessage.id).
      if (!sheet.messageId) {
        await markSheetReminderSent(sheet.id);
        continue;
      }

      const thread = await bot.channels.fetch(sheet.messageId).catch(() => null);
      if (!thread?.isTextBased()) {
        await markSheetReminderSent(sheet.id);
        continue;
      }

      const endTs = Math.floor(sheet.endDate.getTime() / 1000);
      const embed = new StubEmbedBuilder()
        .setTitle("⏰ 評価期間が終了しました")
        .setColor(0xe74c3c)
        .setDescription(
          `<@${sheet.userId}> さんの評価期間（〜<t:${endTs}:D>）が終了しました。\n` +
          `評価を締めくくって結果を記録してください。`,
        )
        .setTimestamp();

      if (!thread.send) {
        await markSheetReminderSent(sheet.id);
        continue;
      }

      await thread.send({ content: `<@${sheet.userId}>`, embeds: [embed] })
        .then(() => {
          logger.info(`[sheet-reminder] Sent reminder for sheet ${sheet.id} (user ${sheet.userId})`);
        });
    } catch (err) {
      logger.error(`[sheet-reminder] Failed to send reminder for sheet ${sheet.id}`, err);
    }
    // Always mark as sent (even on error) to avoid retry-spamming.
    await markSheetReminderSent(sheet.id).catch((e) =>
      logger.error(`[sheet-reminder] Failed to mark sheet ${sheet.id} as reminded`, e),
    );
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSheet(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    userId: "user-1",
    messageId: "thread-1",
    endDate: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makeBot(opts: {
  threadSend?: ReturnType<typeof vi.fn>;
  noThread?: boolean;
  noSendMethod?: boolean;
} = {}): MockBot {
  const threadSend = opts.threadSend ?? vi.fn().mockResolvedValue(undefined);

  const thread: MockThread = opts.noSendMethod
    ? { isTextBased: () => true }
    : { isTextBased: () => true, send: threadSend };

  return {
    channels: {
      fetch: opts.noThread
        ? vi.fn().mockResolvedValue(null)
        : vi.fn().mockResolvedValue(thread),
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("runSheetReminderScheduler – success logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.markSheetReminderSent.mockResolvedValue(undefined);
  });

  it("logs 'Sent reminder' after a successful thread.send()", async () => {
    mocks.listSheetsNeedingReminder.mockResolvedValueOnce([makeSheet()]);

    await runSheetReminderScheduler(makeBot());

    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("[sheet-reminder] Sent reminder for sheet 1"),
    );
  });

  it("does NOT log 'Sent reminder' when thread.send() rejects", async () => {
    mocks.listSheetsNeedingReminder.mockResolvedValueOnce([makeSheet()]);

    const bot = makeBot({
      threadSend: vi.fn().mockRejectedValue(new Error("Unknown channel")),
    });

    await runSheetReminderScheduler(bot);

    expect(mocks.loggerInfo).not.toHaveBeenCalledWith(
      expect.stringContaining("[sheet-reminder] Sent reminder"),
    );
  });

  it("logs an error (not info) when thread.send() rejects", async () => {
    mocks.listSheetsNeedingReminder.mockResolvedValueOnce([makeSheet()]);

    const sendError = new Error("Unknown channel");
    const bot = makeBot({
      threadSend: vi.fn().mockRejectedValue(sendError),
    });

    await runSheetReminderScheduler(bot);

    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("[sheet-reminder] Failed to send reminder for sheet 1"),
      sendError,
    );
  });
});

describe("runSheetReminderScheduler – markSheetReminderSent always called", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.markSheetReminderSent.mockResolvedValue(undefined);
  });

  it("calls markSheetReminderSent after a successful send", async () => {
    mocks.listSheetsNeedingReminder.mockResolvedValueOnce([makeSheet()]);

    await runSheetReminderScheduler(makeBot());

    expect(mocks.markSheetReminderSent).toHaveBeenCalledOnce();
    expect(mocks.markSheetReminderSent).toHaveBeenCalledWith(1);
  });

  it("calls markSheetReminderSent even when thread.send() rejects", async () => {
    mocks.listSheetsNeedingReminder.mockResolvedValueOnce([makeSheet()]);

    const bot = makeBot({
      threadSend: vi.fn().mockRejectedValue(new Error("Unknown channel")),
    });

    await runSheetReminderScheduler(bot);

    expect(mocks.markSheetReminderSent).toHaveBeenCalledOnce();
    expect(mocks.markSheetReminderSent).toHaveBeenCalledWith(1);
  });

  it("calls markSheetReminderSent when the sheet has no messageId", async () => {
    mocks.listSheetsNeedingReminder.mockResolvedValueOnce([makeSheet({ messageId: null })]);

    await runSheetReminderScheduler(makeBot());

    expect(mocks.markSheetReminderSent).toHaveBeenCalledOnce();
    expect(mocks.markSheetReminderSent).toHaveBeenCalledWith(1);
  });

  it("calls markSheetReminderSent when the thread cannot be fetched", async () => {
    mocks.listSheetsNeedingReminder.mockResolvedValueOnce([makeSheet()]);

    await runSheetReminderScheduler(makeBot({ noThread: true }));

    expect(mocks.markSheetReminderSent).toHaveBeenCalledOnce();
    expect(mocks.markSheetReminderSent).toHaveBeenCalledWith(1);
  });

  it("calls markSheetReminderSent when the channel has no send method", async () => {
    mocks.listSheetsNeedingReminder.mockResolvedValueOnce([makeSheet()]);

    await runSheetReminderScheduler(makeBot({ noSendMethod: true }));

    expect(mocks.markSheetReminderSent).toHaveBeenCalledOnce();
    expect(mocks.markSheetReminderSent).toHaveBeenCalledWith(1);
  });
});

describe("runSheetReminderScheduler – no-op when list is empty", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.markSheetReminderSent.mockResolvedValue(undefined);
  });

  it("does nothing when there are no sheets needing reminders", async () => {
    mocks.listSheetsNeedingReminder.mockResolvedValueOnce([]);

    await runSheetReminderScheduler(makeBot());

    expect(mocks.markSheetReminderSent).not.toHaveBeenCalled();
    expect(mocks.loggerInfo).not.toHaveBeenCalled();
    expect(mocks.loggerError).not.toHaveBeenCalled();
  });
});

describe("runSheetReminderScheduler – multiple sheets are processed independently", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.markSheetReminderSent.mockResolvedValue(undefined);
  });

  it("sends reminders to all sheets and marks each as sent", async () => {
    mocks.listSheetsNeedingReminder.mockResolvedValueOnce([
      makeSheet({ id: 1, messageId: "thread-1" }),
      makeSheet({ id: 2, messageId: "thread-2" }),
    ]);

    const threadSend = vi.fn().mockResolvedValue(undefined);
    const bot: MockBot = {
      channels: {
        fetch: vi.fn().mockResolvedValue({ isTextBased: () => true, send: threadSend }),
      },
    };

    await runSheetReminderScheduler(bot);

    expect(threadSend).toHaveBeenCalledTimes(2);
    expect(mocks.markSheetReminderSent).toHaveBeenCalledTimes(2);
    expect(mocks.markSheetReminderSent).toHaveBeenCalledWith(1);
    expect(mocks.markSheetReminderSent).toHaveBeenCalledWith(2);
  });

  it("processes the second sheet even when the first send() fails", async () => {
    mocks.listSheetsNeedingReminder.mockResolvedValueOnce([
      makeSheet({ id: 1, messageId: "thread-1" }),
      makeSheet({ id: 2, messageId: "thread-2" }),
    ]);

    let callCount = 0;
    const threadSend = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error("send failed"));
      return Promise.resolve();
    });

    const bot: MockBot = {
      channels: {
        fetch: vi.fn().mockResolvedValue({ isTextBased: () => true, send: threadSend }),
      },
    };

    await runSheetReminderScheduler(bot);

    // Both sheets are marked as sent despite the first failure.
    expect(mocks.markSheetReminderSent).toHaveBeenCalledTimes(2);
    expect(mocks.markSheetReminderSent).toHaveBeenCalledWith(1);
    expect(mocks.markSheetReminderSent).toHaveBeenCalledWith(2);
    // Only the second sheet logs info.
    expect(mocks.loggerInfo).toHaveBeenCalledTimes(1);
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("sheet 2"),
    );
  });
});
