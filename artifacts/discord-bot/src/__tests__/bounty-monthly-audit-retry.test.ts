import { afterEach, describe, expect, it, vi } from "vitest";
import type { Guild } from "discord.js";

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
    const guild = {
      id: BOUNTY_GUILD_ID,
      channels: { fetch: vi.fn().mockResolvedValue({ isTextBased: () => true, send }) },
    } as unknown as Guild;
    dbMocks.getBountySettings.mockResolvedValue({ logChannelId: "audit-channel" });
    dbMocks.listPendingBountyAudits.mockResolvedValue([]);
    dbMocks.listPendingBountyMonthlyApprovalAudits.mockResolvedValue([
      { monthKey: "2026-09", actorId: "123456789012345678", memberCount: 3 },
    ]);

    await expect(flushPendingBountyAudits(guild)).rejects.toThrow("Discord unavailable");
    expect(dbMocks.markBountyMonthlyApprovalAuditSent).not.toHaveBeenCalled();
    await expect(flushPendingBountyAudits(guild)).resolves.toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0].content).toContain("月初時点の対象: 3人");
    expect(send.mock.calls[1]?.[0].content).toContain("123456789012345678");
    expect(dbMocks.markBountyMonthlyApprovalAuditSent).toHaveBeenCalledExactlyOnceWith(
      BOUNTY_GUILD_ID, "2026-09",
    );
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