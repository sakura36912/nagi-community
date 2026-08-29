import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import {
  getRejoinLogStats,
  recordMemberJoin,
  recordMemberLeave,
} from "../lib/economy";

describe("rejoin log persistence", () => {
  it("includes the current departures and returns the latest post-island roles", async () => {
    const guildId = `test-rejoin-${randomUUID()}`;
    const userId = "test-user";

    try {
      await recordMemberJoin(guildId, userId);
      await recordMemberLeave(guildId, userId, {
        hasWaitingRole: true,
        hasPostIslandRole: false,
        roleNames: ["入島待ち"],
      });
      expect(await getRejoinLogStats(guildId, userId)).toEqual({
        waitingExitCount: 1,
        postIslandExitCount: 0,
        latestPostIslandRoles: [],
      });

      await recordMemberJoin(guildId, userId);
      await recordMemberLeave(guildId, userId, {
        hasWaitingRole: false,
        hasPostIslandRole: true,
        roleNames: ["本船員", "島民"],
      });
      expect(await getRejoinLogStats(guildId, userId)).toEqual({
        waitingExitCount: 1,
        postIslandExitCount: 1,
        latestPostIslandRoles: ["本船員", "島民"],
      });
    } finally {
      await pool.query(
        "DELETE FROM member_join_history WHERE guild_id = $1",
        [guildId],
      );
    }
  });
});