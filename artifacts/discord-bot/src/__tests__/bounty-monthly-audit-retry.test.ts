import { afterEach, describe, expect, it, vi } from "vitest";
import { Collection, type Guild } from "discord.js";

const dbMocks = vi.hoisted(() => ({
  getBountySettings: vi.fn(),
  listPendingBountyAudits: vi.fn(),
  listPendingBountyMonthlyApprovalAudits: vi.fn(),
  markBountyAuditSent: vi.fn(),
  markBountyMonthlyApprovalAuditSent: vi.fn(),
}));
vi.mock("@workspace/db", () => dbMocks);

import { BOUNTY_GUILD_ID, flushPendingBountyAudits } from "../commands/bounty";

afterEach(() => vi.resetAllMocks());

describe("bounty monthly approval audit retry", () => {
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
      { monthKey: "2026-09", actorId: "123456789012345678", memberCount: 3, queuedAt: new Date() },
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
      { monthKey: "2026-09", actorId: "123456789012345678", memberCount: 3, queuedAt: new Date(Date.now() - 1_000) },
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
      { monthKey: "2026-09", actorId: "123456789012345678", memberCount: 3, queuedAt: new Date(Date.now() - 1_000) },
    ]);
    await expect(flushPendingBountyAudits(guild)).resolves.toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect(dbMocks.markBountyMonthlyApprovalAuditSent).toHaveBeenCalledExactlyOnceWith(
      BOUNTY_GUILD_ID, "2026-09",
    );
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
      { monthKey: "2026-09", actorId: "123456789012345678", memberCount: 3, queuedAt: new Date() },
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