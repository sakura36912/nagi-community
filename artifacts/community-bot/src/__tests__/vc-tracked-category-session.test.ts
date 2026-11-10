import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {}, communityVcSessionsTable: {}, communityVcPrivacyTable: {},
  communityVcPrivacyGlobalTable: {}, communityRankingSettingsTable: {},
  communityEventSettingsTable: {}, communityEventsTable: {},
  communityEventParticipantsTable: {}, communityTicketSettingsTable: {},
  communityTicketsTable: {}, communityTicketPanelsTable: {}, communityRoleButtonsTable: {},
}));
const log = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }));
vi.mock("../lib/logger.js", () => ({ logger: log }));
import { openVcSessionIfTracked } from "../lib/community.js";

describe("all-VC history (legacy category cannot suppress entry)", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["same category", "cat-A"],
    ["other category", "cat-B"],
    ["root VC", null],
    ["Hub child", "hub-category"],
    ["shop/private room", "private-category"],
  ])("records %s even with a legacy category setting", async (_name, parent) => {
    const deps = {
      getTrackedVcCategoryId: vi.fn().mockResolvedValue("cat-A"),
      openSession: vi.fn().mockResolvedValue({ id: 1 }),
    };
    await openVcSessionIfTracked("guild", "user", "vc", parent, false, deps);
    expect(deps.openSession).toHaveBeenCalledExactlyOnceWith("guild", "user", "vc", false);
    expect(deps.getTrackedVcCategoryId).not.toHaveBeenCalled();
  });

  it("does not consult the retired category lookup, even if it would fail", async () => {
    const deps = {
      getTrackedVcCategoryId: vi.fn(() => { throw new Error("category unavailable"); }),
      openSession: vi.fn().mockResolvedValue({ id: 1 }),
    };
    await openVcSessionIfTracked("guild", "user", "vc", null, true, deps);
    expect(deps.openSession).toHaveBeenCalledWith("guild", "user", "vc", true);
    expect(deps.getTrackedVcCategoryId).not.toHaveBeenCalled();
  });

  it("does not bypass openSession's privacy refusal or retry a refused insert", async () => {
    const deps = { getTrackedVcCategoryId: vi.fn(), openSession: vi.fn().mockResolvedValue(null) };
    await openVcSessionIfTracked("guild", "user", "vc", null, false, deps);
    expect(deps.openSession).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("opted out"));
  });

  it("logs an insert failure without crashing event dispatch", async () => {
    const error = new Error("DB unavailable");
    const deps = { getTrackedVcCategoryId: vi.fn(), openSession: vi.fn().mockRejectedValue(error) };
    await expect(openVcSessionIfTracked("guild", "user", "vc", null, false, deps)).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("openSession error"), error);
  });
});
