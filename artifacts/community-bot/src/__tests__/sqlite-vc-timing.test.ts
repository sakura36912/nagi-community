import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, communityVcSessionsTable, communityTavernChannelsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getVcRanking, getVcTimeInPeriod, getAllTempVcDeletions } from "../lib/community";

describe("SQLite VC timing and raw column conversion", () => {
  it("clamps durations in microseconds and returns real dates and booleans", async () => {
    const guildId = `sqlite-vc-${randomUUID()}`;
    const start = new Date("2026-09-01T00:00:00.000Z");
    const end = new Date("2026-09-01T01:00:00.000Z");
    try {
      await db.insert(communityTavernChannelsTable).values({ guildId, channelId: "tavern", hubName: "fixture" });
      await db.insert(communityVcSessionsTable).values({
        guildId, userId: "user", channelId: "tavern",
        joinedAt: new Date(start.getTime() - 1800_000), leftAt: new Date(end.getTime() + 1800_000),
      });
      expect(await getVcTimeInPeriod(guildId, "user", start, end)).toBe(3600);
      const exportRows = await getAllTempVcDeletions(guildId);
      expect(exportRows[0]?.joinedAt).toEqual(new Date(start.getTime() - 1800_000));
      expect(exportRows[0]?.optedOut).toBe(false);
      const ranking = await getVcRanking(guildId);
      expect(ranking[0]).toMatchObject({ userId: "user", totalSeconds: 7200, isLive: false });
    } finally {
      await db.delete(communityVcSessionsTable).where(eq(communityVcSessionsTable.guildId, guildId));
      await db.delete(communityTavernChannelsTable).where(eq(communityTavernChannelsTable.guildId, guildId));
    }
  });
});
