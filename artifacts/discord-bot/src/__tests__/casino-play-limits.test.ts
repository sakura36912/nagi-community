import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  casinoDailyPlayCountsTable,
  casinoPlayLimitsTable,
  db,
  walletsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  jstDateString,
  nextJstMidnight,
  setCasinoPlayLimit,
  tryStartCasinoPlay,
} from "../lib/casinoPlayLimits.js";

const guildId = `test-casino-limit-${randomUUID()}`;
const userId = `test-user-${randomUUID()}`;

async function setBalance(balance: number): Promise<void> {
  await db
    .insert(walletsTable)
    .values({ guildId, userId, balance })
    .onConflictDoUpdate({
      target: [walletsTable.guildId, walletsTable.userId],
      set: { balance },
    });
}

afterEach(async () => {
  await db.delete(casinoDailyPlayCountsTable).where(
    and(
      eq(casinoDailyPlayCountsTable.guildId, guildId),
      eq(casinoDailyPlayCountsTable.userId, userId),
    ),
  );
  await db.delete(casinoPlayLimitsTable).where(eq(casinoPlayLimitsTable.guildId, guildId));
  await db.delete(walletsTable).where(
    and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId)),
  );
});

describe("casino daily play limits", () => {
  it("uses the JST calendar date and next JST midnight", () => {
    expect(jstDateString(new Date("2026-08-20T14:59:59.999Z"))).toBe("2026-08-20");
    expect(jstDateString(new Date("2026-08-20T15:00:00.000Z"))).toBe("2026-08-21");
    expect(nextJstMidnight(new Date("2026-08-20T14:59:59.999Z")).toISOString())
      .toBe("2026-08-20T15:00:00.000Z");
  });

  it("stops after the configured cap and debits only successful starts", async () => {
    await setBalance(100);
    await setCasinoPlayLimit(guildId, "slot", 2);

    const first = await tryStartCasinoPlay(guildId, userId, "slot", 10);
    const second = await tryStartCasinoPlay(guildId, userId, "slot", 10);
    const third = await tryStartCasinoPlay(guildId, userId, "slot", 10);

    expect(first).toMatchObject({ ok: true, balance: 90, used: 1, limit: 2 });
    expect(second).toMatchObject({ ok: true, balance: 80, used: 2, limit: 2 });
    expect(third).toMatchObject({ ok: false, reason: "daily_limit_reached", limit: 2 });
  });

  it("does not consume a play slot when the wallet cannot cover the bet", async () => {
    await setBalance(5);
    await setCasinoPlayLimit(guildId, "blackjack", 1);

    expect(await tryStartCasinoPlay(guildId, userId, "blackjack", 10))
      .toMatchObject({ ok: false, reason: "insufficient_funds" });

    await setBalance(20);
    expect(await tryStartCasinoPlay(guildId, userId, "blackjack", 10))
      .toMatchObject({ ok: true, balance: 10, used: 1, limit: 1 });
  });

  it("never exceeds the cap when starts arrive concurrently", async () => {
    await setBalance(100);
    await setCasinoPlayLimit(guildId, "baccarat", 3);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => tryStartCasinoPlay(guildId, userId, "baccarat", 10)),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(3);
    expect(results.filter((result) => !result.ok && result.reason === "daily_limit_reached")).toHaveLength(5);
  });

  it("allows all starts when the cap is unset", async () => {
    await setBalance(100);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => tryStartCasinoPlay(guildId, userId, "poker", 10)),
    );

    expect(results.every((result) => result.ok)).toBe(true);
  });

  it("restores unlimited play after an administrator clears a finite cap", async () => {
    await setBalance(100);
    await setCasinoPlayLimit(guildId, "poker", 1);

    expect(await tryStartCasinoPlay(guildId, userId, "poker", 10))
      .toMatchObject({ ok: true, used: 1, limit: 1 });
    expect(await tryStartCasinoPlay(guildId, userId, "poker", 10))
      .toMatchObject({ ok: false, reason: "daily_limit_reached" });

    await setCasinoPlayLimit(guildId, "poker", null);
    expect(await tryStartCasinoPlay(guildId, userId, "poker", 10))
      .toMatchObject({ ok: true, used: null, limit: null });
  });

  it("starts a fresh count after midnight in Japan", async () => {
    await setBalance(100);
    await setCasinoPlayLimit(guildId, "slot", 1);
    const beforeMidnight = new Date("2026-08-20T14:59:59.999Z");
    const afterMidnight = new Date("2026-08-20T15:00:00.000Z");

    expect(await tryStartCasinoPlay(guildId, userId, "slot", 10, beforeMidnight))
      .toMatchObject({ ok: true, used: 1, limit: 1 });
    expect(await tryStartCasinoPlay(guildId, userId, "slot", 10, beforeMidnight))
      .toMatchObject({ ok: false, reason: "daily_limit_reached" });
    expect(await tryStartCasinoPlay(guildId, userId, "slot", 10, afterMidnight))
      .toMatchObject({ ok: true, used: 1, limit: 1 });
  });
});
