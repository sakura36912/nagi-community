import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, pool, walletsTable, slotSettingsTable, checkSchemaDrift, acquireProcessLock } from "@workspace/db";
import { addSlotEmoji, removeSlotEmoji, setSlotEmojiWeight, setSlotPayout, getSlotSettings } from "../lib/slot";

describe("SQLite runtime invariants", () => {
  it("keeps required indexes and int32 overflow guards", async () => {
    expect((await checkSchemaDrift(pool)).ok).toBe(true);
    const guildId = `sqlite-range-${randomUUID()}`;
    try {
      await db.insert(walletsTable).values({ guildId, userId: "user", balance: 2_147_483_647 });
      await expect(db.transaction(async (tx) => {
        await tx.update(walletsTable).set({ balance: sql`${walletsTable.balance} + 1` })
          .where(and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, "user")));
      })).rejects.toThrow();
      expect((await db.select().from(walletsTable).where(eq(walletsTable.guildId, guildId)))[0]?.balance).toBe(2_147_483_647);
    } finally { await db.delete(walletsTable).where(eq(walletsTable.guildId, guildId)); }
  });

  it("edits JSON-backed arrays and objects without losing unrelated settings", async () => {
    const guildId = `sqlite-json-${randomUUID()}`;
    try {
      await getSlotSettings(guildId);
      await Promise.all([addSlotEmoji(guildId, "111"), addSlotEmoji(guildId, "222")]);
      await addSlotEmoji(guildId, "111");
      await setSlotEmojiWeight(guildId, "111", 5);
      await setSlotPayout(guildId, 2, 7);
      const before = await getSlotSettings(guildId);
      expect(before.fixedEmojiIds).toEqual(["111", "222"]);
      expect(before.emojiWeights).toEqual({ "111": 5 });
      expect(before.payoutMultipliers).toEqual([-1, 1, 7, 11, 19, 34]);
      expect(before.updatedAt).toBeInstanceOf(Date);
      await removeSlotEmoji(guildId, "111");
      const after = await getSlotSettings(guildId);
      expect(after.fixedEmojiIds).toEqual(["222"]);
      expect(after.emojiWeights).toEqual({});
    } finally { await db.delete(slotSettingsTable).where(eq(slotSettingsTable.guildId, guildId)); }
  });

  it("does not allow a second same-bot OS lock against one database", async () => {
    const first = await acquireProcessLock("discord-bot");
    expect(first).not.toBeNull();
    try { expect(await acquireProcessLock("discord-bot")).toBeNull(); }
    finally { first?.release(); }
  });
});
