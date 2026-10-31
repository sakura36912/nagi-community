import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Collection, type Guild } from "discord.js";
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
  tryStartCasinoMemberPlay,
  casinoRoleDailyLimit,
  CASINO_LIMITED_GAMES,
  type CasinoLimitedGame,
} from "../lib/casinoPlayLimits.js";

const guildId = `test-casino-limit-${randomUUID()}`;
const userId = `test-user-${randomUUID()}`;

function memberGuild(roles: string[]) {
  const fetch = vi.fn(async () => ({ roles: { cache: new Collection(roles.map((name, i) => [String(i), { name }])) } }));
  return { guild: { id: guildId, members: { fetch } } as unknown as Guild, fetch };
}
async function seedCount(game: CasinoLimitedGame, count: number, now = new Date()) {
  await db.insert(casinoDailyPlayCountsTable).values({ guildId, userId, game, date: jstDateString(now), playCount: count });
}

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
  it.each([
    [["本船員"], 150], [["新入り"], 100], [["漂流者"], 100],
    [["本船員", "新入り", "漂流者"], 150], [["漂流者", "本船員"], 150],
    [["新入り", "漂流者"], 100], [["管理者"], null], [[], null], [["本船員見習い"], null],
  ] as const)("resolves the exact role names %j to %s", (names, expected) => {
    expect(casinoRoleDailyLimit(names)).toBe(expected);
  });

  it.each(CASINO_LIMITED_GAMES.flatMap(game =>
    (["本船員", "新入り", "漂流者"] as const).map(role => ({ game, role, limit: role === "本船員" ? 150 : 100 })),
  ))("enforces $role's $limit cap for $game without debiting a blocked start", async ({ game, role, limit }) => {
    await setBalance(100);
    // A role's explicit cap supersedes the old generic cap.
    await setCasinoPlayLimit(guildId, game, 1);
    await seedCount(game, limit - 1);
    const { guild, fetch } = memberGuild([role]);
    expect(await tryStartCasinoMemberPlay(guild, userId, game, 10)).toMatchObject({ ok: true, used: limit, limit, balance: 90 });
    expect(await tryStartCasinoMemberPlay(guild, userId, game, 10)).toMatchObject({ ok: false, reason: "daily_limit_reached", limit });
    expect(fetch).toHaveBeenCalledWith({ user: userId, force: true });
    const [wallet] = await db.select().from(walletsTable).where(and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId)));
    expect(wallet!.balance).toBe(90);
  });

  it("resolves fresh role changes without resetting today's usage and gives 本船員 priority", async () => {
    await setBalance(100); await seedCount("slot", 100);
    const roles = ["新入り"], { guild, fetch } = memberGuild(roles);
    expect(await tryStartCasinoMemberPlay(guild, userId, "slot", 10)).toMatchObject({ ok: false, limit: 100 });
    roles.push("本船員");
    expect(await tryStartCasinoMemberPlay(guild, userId, "slot", 10)).toMatchObject({ ok: true, used: 101, limit: 150 });
    roles.pop();
    expect(await tryStartCasinoMemberPlay(guild, userId, "slot", 10)).toMatchObject({ ok: false, limit: 100 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("keeps counters separate per game and resets role caps at JST midnight", async () => {
    await setBalance(100);
    const before = new Date("2026-11-01T14:59:59.999Z"), after = new Date("2026-11-01T15:00:00.000Z");
    await seedCount("slot", 100, before);
    const { guild } = memberGuild(["漂流者"]);
    expect(await tryStartCasinoMemberPlay(guild, userId, "slot", 10, before)).toMatchObject({ ok: false, limit: 100 });
    expect(await tryStartCasinoMemberPlay(guild, userId, "poker", 10, before)).toMatchObject({ ok: true, used: 1, limit: 100 });
    expect(await tryStartCasinoMemberPlay(guild, userId, "slot", 10, after)).toMatchObject({ ok: true, used: 1, limit: 100 });
  });

  it("counts otherwise-unlimited rounds so a newly acquired role cannot bypass its cap", async () => {
    await setBalance(100); await seedCount("slot", 99);
    const roles: string[] = [], { guild } = memberGuild(roles);
    expect(await tryStartCasinoMemberPlay(guild, userId, "slot", 10)).toMatchObject({ ok: true, used: null, limit: null });
    roles.push("新入り");
    expect(await tryStartCasinoMemberPlay(guild, userId, "slot", 10)).toMatchObject({ ok: false, limit: 100 });
  });

  it("does not bypass the role cap when the generic cap is cleared", async () => {
    await setBalance(100); await seedCount("highlow", 150);
    await setCasinoPlayLimit(guildId, "highlow", 10);
    await setCasinoPlayLimit(guildId, "highlow", null);
    expect(await tryStartCasinoMemberPlay(memberGuild(["本船員"]).guild, userId, "highlow", 10))
      .toMatchObject({ ok: false, reason: "daily_limit_reached", limit: 150 });
  });

  it("preserves the generic cap for other roles", async () => {
    await setBalance(100); await seedCount("poker", 3); await setCasinoPlayLimit(guildId, "poker", 3);
    expect(await tryStartCasinoMemberPlay(memberGuild(["その他"]).guild, userId, "poker", 10))
      .toMatchObject({ ok: false, limit: 3 });
  });

  it("fails closed when current roles cannot be fetched, without reserving or debiting", async () => {
    await setBalance(100);
    const { guild, fetch } = memberGuild(["本船員"]);
    fetch.mockRejectedValueOnce(new Error("Discord unavailable"));
    await expect(tryStartCasinoMemberPlay(guild, userId, "slot", 10)).rejects.toThrow("Discord unavailable");
    expect(await db.select().from(casinoDailyPlayCountsTable).where(eq(casinoDailyPlayCountsTable.guildId, guildId))).toHaveLength(0);
    const [wallet] = await db.select().from(walletsTable).where(and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId)));
    expect(wallet!.balance).toBe(100);
  });

  it("reserves only the final available role-based slot when new rounds arrive simultaneously", async () => {
    await setBalance(100); await seedCount("slot", 149);
    const { guild } = memberGuild(["本船員", "新入り"]);
    const results = await Promise.all(Array.from({ length: 6 }, () => tryStartCasinoMemberPlay(guild, userId, "slot", 10)));
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => !r.ok && r.reason === "daily_limit_reached")).toHaveLength(5);
  });

  it("does not spend the final role-based slot on insufficient funds", async () => {
    await setBalance(5); await seedCount("blackjack", 99);
    const { guild } = memberGuild(["新入り"]);
    expect(await tryStartCasinoMemberPlay(guild, userId, "blackjack", 10)).toMatchObject({ ok: false, reason: "insufficient_funds" });
    await setBalance(20);
    expect(await tryStartCasinoMemberPlay(guild, userId, "blackjack", 10)).toMatchObject({ ok: true, used: 100, limit: 100 });
  });

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
