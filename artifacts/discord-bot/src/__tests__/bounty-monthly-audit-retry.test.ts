import { afterEach, describe, expect, it, vi } from "vitest";
import { Collection, type Guild } from "discord.js";

const dbMocks = vi.hoisted(() => ({
  getBountySettings: vi.fn(),
  listPendingBountyAudits: vi.fn(),
  listPendingBountyMonthlyApprovalAudits: vi.fn(),
  markBountyAuditSent: vi.fn(),
  markBountyMonthlyApprovalAuditSent: vi.fn(),
  setBountyMonthlyApprovalAuditChannel: vi.fn(),
  setBountyMonthlyApprovalAuditScanCursor: vi.fn(),
}));
vi.mock("@workspace/db", () => dbMocks);

import { BOUNTY_GUILD_ID, flushPendingBountyAudits } from "../commands/bounty";

afterEach(() => vi.resetAllMocks());

describe("bounty monthly approval audit retry", () => {
  it("does not guess a destination for a pending pre-migration approval", async () => {
    const send = vi.fn();
    const guild = {
      id: BOUNTY_GUILD_ID, client: { user: { id: "bot-id" } },
      channels: { fetch: vi.fn().mockResolvedValue({ isTextBased: () => true, send, messages: { fetch: vi.fn() } }) },
    } as unknown as Guild;
    dbMocks.getBountySettings.mockResolvedValue({ logChannelId: "new-channel" });
    dbMocks.listPendingBountyAudits.mockResolvedValue([]);
    dbMocks.listPendingBountyMonthlyApprovalAudits.mockResolvedValue([{
      monthKey: "2026-09", actorId: "123456789012345678", memberCount: 3,
      queuedAt: new Date(), scanBeforeId: null, channelId: null,
    }]);
    await expect(flushPendingBountyAudits(guild)).rejects.toThrow("手動確認");
    expect(send).not.toHaveBeenCalled();
    expect(dbMocks.setBountyMonthlyApprovalAuditChannel).not.toHaveBeenCalled();
  });

  it("finds an ambiguous post in the former audit channel after settings change", async () => {
    let configuredChannel = "old-channel";
    let posted: { id: string; content: string; author: { id: string }; createdTimestamp: number } | null = null;
    const oldSend = vi.fn(async ({ content }: { content: string }) => {
      posted = { id: "123456789012345678", content, author: { id: "bot-id" }, createdTimestamp: Date.now() };
    });
    const newSend = vi.fn();
    const oldHistory = vi.fn(async () => posted
      ? new Collection([["123456789012345678", posted]])
      : new Collection());
    const newHistory = vi.fn(async () => new Collection());
    const oldChannel = { isTextBased: () => true, send: oldSend, messages: { fetch: oldHistory } };
    const newChannel = { isTextBased: () => true, send: newSend, messages: { fetch: newHistory } };
    const fetchChannel = vi.fn(async (id: string) => id === "old-channel" ? oldChannel : newChannel);
    const guild = {
      id: BOUNTY_GUILD_ID, client: { user: { id: "bot-id" } },
      channels: { fetch: fetchChannel },
    } as unknown as Guild;
    dbMocks.getBountySettings.mockImplementation(async () => ({ logChannelId: configuredChannel }));
    dbMocks.listPendingBountyAudits.mockResolvedValue([]);
    dbMocks.listPendingBountyMonthlyApprovalAudits.mockImplementation(async () => [{
      monthKey: "2026-09", actorId: "123456789012345678", memberCount: 3,
      queuedAt: new Date(Date.now() - 1_000), scanBeforeId: null, channelId: "old-channel",
    }]);
    dbMocks.markBountyMonthlyApprovalAuditSent.mockRejectedValueOnce(new Error("DB unavailable"));

    await expect(flushPendingBountyAudits(guild)).rejects.toThrow("DB unavailable");
    configuredChannel = "new-channel";
    await expect(flushPendingBountyAudits(guild)).resolves.toBe(1);
    expect(oldSend).toHaveBeenCalledOnce();
    expect(newSend).not.toHaveBeenCalled();
    expect(newHistory).not.toHaveBeenCalled();
    expect(fetchChannel).toHaveBeenCalledWith("old-channel");
    expect(dbMocks.setBountyMonthlyApprovalAuditChannel).not.toHaveBeenCalled();
    expect(dbMocks.markBountyMonthlyApprovalAuditSent).toHaveBeenCalledTimes(2);
  });

  it("checks both channels and records the new destination before a resend", async () => {
    let channelId = "old-channel";
    const oldHistory = vi.fn(async () => new Collection());
    const newHistory = vi.fn(async () => new Collection());
    const newSend = vi.fn(async () => ({ id: "sent" }));
    const guild = {
      id: BOUNTY_GUILD_ID, client: { user: { id: "bot-id" } },
      channels: { fetch: vi.fn(async (id: string) => id === "old-channel"
        ? { isTextBased: (): boolean => true, messages: { fetch: oldHistory } }
        : { isTextBased: () => true, send: newSend, messages: { fetch: newHistory } }) },
    } as unknown as Guild;
    dbMocks.getBountySettings.mockResolvedValue({ logChannelId: "new-channel" });
    dbMocks.listPendingBountyAudits.mockResolvedValue([]);
    dbMocks.listPendingBountyMonthlyApprovalAudits.mockImplementation(async () => [{
      monthKey: "2026-09", actorId: "123456789012345678", memberCount: 3,
      queuedAt: new Date(Date.now() - 1_000), scanBeforeId: "123456789012345678", channelId,
    }]);
    dbMocks.setBountyMonthlyApprovalAuditChannel.mockImplementation(async (
      _guildId: string, _monthKey: string, expected: string, next: string,
    ) => {
      expect(expected).toBe(channelId);
      channelId = next;
    });

    await expect(flushPendingBountyAudits(guild)).resolves.toBe(1);
    expect(oldHistory).toHaveBeenCalledWith({ limit: 100, before: "123456789012345678" });
    expect(newHistory).toHaveBeenCalledWith({ limit: 100 });
    expect(dbMocks.setBountyMonthlyApprovalAuditChannel).toHaveBeenCalledExactlyOnceWith(
      BOUNTY_GUILD_ID, "2026-09", "old-channel", "new-channel",
    );
    expect(dbMocks.setBountyMonthlyApprovalAuditChannel.mock.invocationCallOrder[0])
      .toBeLessThan(newSend.mock.invocationCallOrder[0]!);
    expect(newSend).toHaveBeenCalledOnce();
  });

  it("refuses a new send when the former channel's history cannot be read", async () => {
    const newSend = vi.fn();
    const guild = {
      id: BOUNTY_GUILD_ID, client: { user: { id: "bot-id" } },
      channels: { fetch: vi.fn(async (id: string) => id === "old-channel"
        ? { isTextBased: (): boolean => true, messages: { fetch: vi.fn().mockRejectedValue(new Error("Missing Read Message History")) } }
        : { isTextBased: () => true, send: newSend, messages: { fetch: vi.fn() } }) },
    } as unknown as Guild;
    dbMocks.getBountySettings.mockResolvedValue({ logChannelId: "new-channel" });
    dbMocks.listPendingBountyAudits.mockResolvedValue([]);
    dbMocks.listPendingBountyMonthlyApprovalAudits.mockResolvedValue([{
      monthKey: "2026-09", actorId: "123456789012345678", memberCount: 3,
      queuedAt: new Date(), scanBeforeId: null, channelId: "old-channel",
    }]);
    await expect(flushPendingBountyAudits(guild)).rejects.toThrow("Missing Read Message History");
    expect(newSend).not.toHaveBeenCalled();
    expect(dbMocks.setBountyMonthlyApprovalAuditChannel).not.toHaveBeenCalled();
  });

  it("waits for the old channel's full history scan before switching channels", async () => {
    const newSend = vi.fn();
    const oldHistory = vi.fn(async () => new Collection(Array.from({ length: 100 }, (_, i) => {
      const id = String(123456789012345678n - BigInt(i));
      return [id, { id, content: "unrelated", author: { id: "bot-id" }, createdTimestamp: Date.now() }] as const;
    })));
    const guild = {
      id: BOUNTY_GUILD_ID, client: { user: { id: "bot-id" } },
      channels: { fetch: vi.fn(async (id: string) => id === "old-channel"
        ? { isTextBased: (): boolean => true, messages: { fetch: oldHistory } }
        : { isTextBased: () => true, send: newSend, messages: { fetch: vi.fn() } }) },
    } as unknown as Guild;
    dbMocks.getBountySettings.mockResolvedValue({ logChannelId: "new-channel" });
    dbMocks.listPendingBountyAudits.mockResolvedValue([]);
    dbMocks.listPendingBountyMonthlyApprovalAudits.mockResolvedValue([{
      monthKey: "2026-09", actorId: "123456789012345678", memberCount: 3,
      queuedAt: new Date(Date.now() - 1_000), scanBeforeId: null, channelId: "old-channel",
    }]);
    await expect(flushPendingBountyAudits(guild)).resolves.toBe(0);
    expect(oldHistory).toHaveBeenCalledTimes(20);
    expect(dbMocks.setBountyMonthlyApprovalAuditScanCursor).toHaveBeenCalledWith(
      BOUNTY_GUILD_ID, "2026-09", "old-channel", expect.any(String),
    );
    expect(dbMocks.setBountyMonthlyApprovalAuditChannel).not.toHaveBeenCalled();
    expect(newSend).not.toHaveBeenCalled();
  });

  it("keeps a failed send queued and marks it sent only after Discord accepts it", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("Discord unavailable"))
      .mockResolvedValueOnce({ id: "message" });
    const fetch = vi.fn().mockResolvedValue(new Collection());
    const guild = {
      id: BOUNTY_GUILD_ID,
      client: { user: { id: "bot-id" } },
      channels: { fetch: vi.fn().mockResolvedValue({ isTextBased: () => true, send, messages: { fetch } }) },
    } as unknown as Guild;
    dbMocks.getBountySettings.mockResolvedValue({ logChannelId: "audit-channel" });
    dbMocks.listPendingBountyAudits.mockResolvedValue([]);
    dbMocks.listPendingBountyMonthlyApprovalAudits.mockResolvedValue([
      { monthKey: "2026-09", actorId: "123456789012345678", memberCount: 3, queuedAt: new Date(), scanBeforeId: null, channelId: "audit-channel" },
    ]);

    await expect(flushPendingBountyAudits(guild)).rejects.toThrow("Discord unavailable");
    expect(dbMocks.markBountyMonthlyApprovalAuditSent).not.toHaveBeenCalled();
    await expect(flushPendingBountyAudits(guild)).resolves.toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0].content).toContain("月初時点の対象: 3人");
    expect(send.mock.calls[1]?.[0].content).toContain("123456789012345678");
    expect(send.mock.calls[1]?.[0].enforceNonce).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(dbMocks.markBountyMonthlyApprovalAuditSent).toHaveBeenCalledExactlyOnceWith(
      BOUNTY_GUILD_ID, "2026-09",
    );
  });

  it("reconciles a successful Discord post after the DB acknowledgment fails", async () => {
    let posted: { id: string; content: string; author: { id: string }; createdTimestamp: number } | null = null;
    const send = vi.fn(async ({ content }: { content: string }) => {
      posted = { id: "message-id", content, author: { id: "bot-id" }, createdTimestamp: Date.now() };
      return posted;
    });
    const fetch = vi.fn(async () => posted ? new Collection([["message-id", posted]]) : new Collection());
    const guild = {
      id: BOUNTY_GUILD_ID,
      client: { user: { id: "bot-id" } },
      channels: { fetch: vi.fn().mockResolvedValue({ isTextBased: () => true, send, messages: { fetch } }) },
    } as unknown as Guild;
    dbMocks.getBountySettings.mockResolvedValue({ logChannelId: "audit-channel" });
    dbMocks.listPendingBountyAudits.mockResolvedValue([]);
    dbMocks.listPendingBountyMonthlyApprovalAudits.mockResolvedValue([
      { monthKey: "2026-09", actorId: "123456789012345678", memberCount: 3, queuedAt: new Date(Date.now() - 1_000), scanBeforeId: null, channelId: "audit-channel" },
    ]);
    dbMocks.markBountyMonthlyApprovalAuditSent.mockRejectedValueOnce(new Error("DB unavailable"));

    await expect(flushPendingBountyAudits(guild)).rejects.toThrow("DB unavailable");
    await expect(flushPendingBountyAudits(guild)).resolves.toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(dbMocks.markBountyMonthlyApprovalAuditSent).toHaveBeenCalledTimes(2);
  });

  it("recognizes the prior audit format when it was posted before this change", async () => {
    const legacyContent = "懸賞金月次承認 2026-09\n実行者: <@123456789012345678>\n月初時点の対象: 3人\n※承認記録です。精算結果は別途確認してください。";
    const send = vi.fn();
    const guild = {
      id: BOUNTY_GUILD_ID,
      client: { user: { id: "bot-id" } },
      channels: { fetch: vi.fn().mockResolvedValue({
        isTextBased: () => true, send,
        messages: { fetch: vi.fn().mockResolvedValue(new Collection([["old-message", {
          id: "old-message", content: legacyContent, author: { id: "bot-id" }, createdTimestamp: Date.now(),
        }]])) },
      }) },
    } as unknown as Guild;
    dbMocks.getBountySettings.mockResolvedValue({ logChannelId: "audit-channel" });
    dbMocks.listPendingBountyAudits.mockResolvedValue([]);
    dbMocks.listPendingBountyMonthlyApprovalAudits.mockResolvedValue([
      { monthKey: "2026-09", actorId: "123456789012345678", memberCount: 3, queuedAt: new Date(Date.now() - 1_000), scanBeforeId: null, channelId: "audit-channel" },
    ]);
    await expect(flushPendingBountyAudits(guild)).resolves.toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect(dbMocks.markBountyMonthlyApprovalAuditSent).toHaveBeenCalledExactlyOnceWith(
      BOUNTY_GUILD_ID, "2026-09",
    );
  });

  it("resumes a search beyond 10,000 messages and rescans from newest after an ambiguous send", async () => {
    const queuedAt = new Date(Date.now() - 2_000);
    const base = 100000000000000000n;
    let scanBeforeId: string | null = null;
    let posted: { id: string; content: string; author: { id: string }; createdTimestamp: number } | null = null;
    let completed = false;
    const send = vi.fn(async ({ content }: { content: string }) => {
      posted = { id: "200000000000000000", content, author: { id: "bot-id" }, createdTimestamp: Date.now() };
      return posted;
    });
    const fetch = vi.fn(async ({ before }: { before?: string }) => {
      if (!before && posted) return new Collection([[posted.id, posted]]);
      const page = before ? Number((base - BigInt(before) + 1n) / 100n) : 0;
      return new Collection(Array.from({ length: 100 }, (_, i) => {
        const id = String(base - BigInt(page * 100 + i));
        return [id, {
          id, content: "unrelated", author: { id: "bot-id" },
          createdTimestamp: page === 100 && i === 99 ? queuedAt.getTime() - 61_000 : Date.now(),
        }] as const;
      }));
    });
    const guild = {
      id: BOUNTY_GUILD_ID,
      client: { user: { id: "bot-id" } },
      channels: { fetch: vi.fn().mockResolvedValue({ isTextBased: () => true, send, messages: { fetch } }) },
    } as unknown as Guild;
    dbMocks.getBountySettings.mockResolvedValue({ logChannelId: "audit-channel" });
    dbMocks.listPendingBountyAudits.mockResolvedValue([]);
    dbMocks.listPendingBountyMonthlyApprovalAudits.mockImplementation(async () => completed ? [] : [{
      monthKey: "2026-09", actorId: "123456789012345678", memberCount: 3, queuedAt, scanBeforeId, channelId: "audit-channel",
    }]);
    dbMocks.setBountyMonthlyApprovalAuditScanCursor.mockImplementation(async (
      _guildId: string, _month: string, _channelId: string, beforeId: string | null,
    ) => { scanBeforeId = beforeId; });
    dbMocks.markBountyMonthlyApprovalAuditSent
      .mockRejectedValueOnce(new Error("DB unavailable"))
      .mockImplementation(async () => { completed = true; });

    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(flushPendingBountyAudits(guild)).resolves.toBe(0);
      expect(scanBeforeId).not.toBeNull();
      expect(send).not.toHaveBeenCalled();
    }
    await expect(flushPendingBountyAudits(guild)).rejects.toThrow("DB unavailable");
    expect(fetch).toHaveBeenCalledTimes(101);
    expect(send).toHaveBeenCalledTimes(1);
    expect(scanBeforeId).toBeNull();
    await expect(flushPendingBountyAudits(guild)).resolves.toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(completed).toBe(true);
  });

  it("does not risk a duplicate send when Discord history is inaccessible", async () => {
    const send = vi.fn();
    const guild = {
      id: BOUNTY_GUILD_ID,
      client: { user: { id: "bot-id" } },
      channels: { fetch: vi.fn().mockResolvedValue({
        isTextBased: () => true, send,
        messages: { fetch: vi.fn().mockRejectedValue(new Error("Missing Read Message History")) },
      }) },
    } as unknown as Guild;
    dbMocks.getBountySettings.mockResolvedValue({ logChannelId: "audit-channel" });
    dbMocks.listPendingBountyAudits.mockResolvedValue([]);
    dbMocks.listPendingBountyMonthlyApprovalAudits.mockResolvedValue([
      { monthKey: "2026-09", actorId: "123456789012345678", memberCount: 3, queuedAt: new Date(), scanBeforeId: null, channelId: "audit-channel" },
    ]);
    await expect(flushPendingBountyAudits(guild)).rejects.toThrow("Missing Read Message History");
    expect(send).not.toHaveBeenCalled();
    expect(dbMocks.markBountyMonthlyApprovalAuditSent).not.toHaveBeenCalled();
  });

  it("does not fetch a Discord channel when there are no pending audits", async () => {
    const fetch = vi.fn();
    dbMocks.listPendingBountyAudits.mockResolvedValue([]);
    dbMocks.listPendingBountyMonthlyApprovalAudits.mockResolvedValue([]);
    const guild = { id: BOUNTY_GUILD_ID, channels: { fetch } } as unknown as Guild;
    await expect(flushPendingBountyAudits(guild)).resolves.toBe(0);
    expect(dbMocks.getBountySettings).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});