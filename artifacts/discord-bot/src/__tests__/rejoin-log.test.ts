import { describe, expect, it } from "vitest";
import {
  buildDepartureRoleSnapshot,
  buildRejoinLogText,
  DISCORD_MESSAGE_CONTENT_LIMIT,
} from "../lib/rejoinLog";

describe("rejoin log role tracking", () => {
  it("counts waiting and post-island states independently", () => {
    expect(buildDepartureRoleSnapshot(["入島待ち", "本船員", "新入り", "その他"])).toEqual({
      hasWaitingRole: true,
      hasPostIslandRole: true,
      roleNames: ["入島待ち", "本船員", "新入り", "その他"],
    });
  });

  it("does not count an exit without either target role", () => {
    expect(buildDepartureRoleSnapshot(["その他"])).toEqual({
      hasWaitingRole: false,
      hasPostIslandRole: false,
      roleNames: ["その他"],
    });
  });

  it("uses the exact requested labels in searchable message text", () => {
    expect(buildRejoinLogText({
      displayName: "Kano0109",
      userId: "123456789",
      waitingExitCount: 2,
      postIslandExitCount: 3,
      latestPostIslandRoles: ["本船員", "島民", "守門卿"],
    })).toBe([
      "名前: Kano0109",
      "ID: 123456789",
      "入島待ち退出回数: 2回",
      "入島後退出回数: 3回",
      "最新ロール: 本船員 / 島民 / 守門卿",
    ].join("\n"));
  });

  it("shows an explicit unavailable value when no post-island snapshot exists", () => {
    expect(buildRejoinLogText({
      displayName: "Kano0109",
      userId: "123456789",
      waitingExitCount: 0,
      postIslandExitCount: 0,
      latestPostIslandRoles: [],
    })).toContain("最新ロール: 未記録");
  });

  it("keeps outgoing content within Discord's 2,000-character limit", () => {
    const content = buildRejoinLogText({
      displayName: "名".repeat(500),
      userId: "123456789",
      waitingExitCount: 10,
      postIslandExitCount: 20,
      latestPostIslandRoles: Array.from(
        { length: 250 },
        (_, index) => `${index}-${"役".repeat(200)}`,
      ),
    });

    expect(content.length).toBeLessThanOrEqual(DISCORD_MESSAGE_CONTENT_LIMIT);
    expect(content).toContain("名前:");
    expect(content).toContain("ID:");
    expect(content).toContain("入島待ち退出回数:");
    expect(content).toContain("入島後退出回数:");
    expect(content).toContain("最新ロール:");
    expect(content).toContain("他 240件");
  });
});