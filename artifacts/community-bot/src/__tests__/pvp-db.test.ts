import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  db, pvpDuelsTable as duels, pvpActiveUsersTable as slots, pvpActionsTable as actions, rpgNoticesTable as notices,
  forgeWeaponsTable as weapons, forgeActionsTable, forgeUpgradeRequestsTable, forgeUpgradeSettingsTable,
  walletsTable as wallets, transactionsTable as ledger, bossFeesTable as fees,
  createPvpDuel, performPvpAction, advancePvpGuild, duePvpGuilds, getPvpDuel,
  selectForgeWeapon, createForgeUpgradeRequest, settleForgeUpgrade, deliverRpgCard,
} from "@workspace/db";

describe.skipIf(process.env.RUN_PVP_DB_TESTS !== "1")("PvP and public RPG cards: real atomic database operations", () => {
  const guilds: string[] = [];
  const id = () => randomUUID();
  const t0 = new Date("2026-11-12T00:00:00Z");
  const seconds = (n: number) => new Date(t0.getTime() + n * 1000);
  async function balance(guildId: string, userId: string) {
    const [row] = await db.select().from(wallets).where(and(eq(wallets.guildId, guildId), eq(wallets.userId, userId)));
    return row!.balance;
  }
  async function setup(amount = 1000, prize = 100) {
    const guildId = `pvp-test-${id()}`; guilds.push(guildId);
    const input = { id: id(), guildId, channelId: "test-channel", hostId: "host", opponentId: "opponent", prize, durationMinutes: 1 };
    for (const userId of ["host", "opponent"]) {
      await selectForgeWeapon(id(), guildId, userId, userId === "host" ? "spear" : "dual");
      await db.insert(wallets).values({ guildId, userId, balance: amount });
    }
    await db.insert(fees).values({ guildId, healCost: 50 });
    return input;
  }
  async function begin(input: Awaited<ReturnType<typeof setup>>) {
    await createPvpDuel(input, t0);
    return performPvpAction(id(), input.guildId, "opponent", input.id, "accept", seconds(1));
  }
  async function saved(input: Awaited<ReturnType<typeof setup>>) {
    return (await db.select().from(duels).where(eq(duels.id, input.id)))[0]!;
  }
  afterAll(async () => {
    for (const guildId of guilds) for (const table of [slots, actions, notices, duels, forgeUpgradeRequestsTable,
      forgeActionsTable, forgeUpgradeSettingsTable, weapons, fees, ledger, wallets]) {
      await db.delete(table).where(eq(table.guildId, guildId));
    }
  });
  it("concurrent duplicate invitations debit once and queue exactly one public card", async () => {
    const input = await setup();
    await Promise.all(Array.from({ length: 5 }, () => createPvpDuel(input, t0)));
    expect(await balance(input.guildId, "host")).toBe(900);
    expect(await balance(input.guildId, "opponent")).toBe(1000);
    expect(await db.select().from(ledger).where(eq(ledger.sessionKey, `pvp-escrow:${input.id}`))).toHaveLength(1);
    expect(await db.select().from(notices).where(eq(notices.id, `pvp-create:${input.id}`))).toHaveLength(1);
    expect((await saved(input)).state.players[0]?.maxHp).toBe(1000);
  });
  it("rejects insufficient prize money without reservation, ledger or public success", async () => {
    const input = await setup(100, 101);
    await expect(createPvpDuel(input, t0)).rejects.toThrow("不足");
    expect(await balance(input.guildId, "host")).toBe(100);
    expect(await db.select().from(slots).where(eq(slots.guildId, input.guildId))).toHaveLength(0);
    expect(await db.select().from(notices).where(eq(notices.guildId, input.guildId))).toHaveLength(0);
  });
  it("rejects self invitations, invalid amounts and a second simultaneous reservation", async () => {
    const input = await setup();
    await expect(createPvpDuel({ ...input, opponentId: "host" }, t0)).rejects.toThrow("自分自身");
    await expect(createPvpDuel({ ...input, prize: 0 }, t0)).rejects.toThrow("整数");
    await createPvpDuel(input, t0);
    await expect(createPvpDuel({ ...input, id: id() }, t0)).rejects.toThrow("既に");
  });
  it("rejects unknown weapons and missing wallets before charging", async () => {
    const input = await setup();
    await db.delete(weapons).where(and(eq(weapons.guildId, input.guildId), eq(weapons.userId, "opponent")));
    await expect(createPvpDuel(input, t0)).rejects.toThrow("武器");
    expect(await balance(input.guildId, "host")).toBe(1000);
  });
  it("accepts only the named opponent; replay cannot extend the deadline", async () => {
    const input = await setup(); await createPvpDuel(input, t0);
    await expect(performPvpAction(id(), input.guildId, "host", input.id, "accept", seconds(1))).rejects.toThrow("本人");
    await expect(performPvpAction(id(), input.guildId, "stranger", input.id, "accept", seconds(1))).rejects.toThrow("操作");
    const accept = id();
    await performPvpAction(accept, input.guildId, "opponent", input.id, "accept", seconds(1));
    const repeated = await performPvpAction(accept, input.guildId, "opponent", input.id, "accept", seconds(10));
    expect(repeated.repeated).toBe(true);
    expect(repeated.duel.expiresAt).toEqual(seconds(61));
    expect(repeated.duel.state.players).toHaveLength(2);
  });
  it("cancellation refunds exactly once even under concurrent duplicate clicks", async () => {
    const input = await setup(); await createPvpDuel(input, t0);
    const cancel = id();
    await Promise.all([1, 2, 3].map(() => performPvpAction(cancel, input.guildId, "host", input.id, "cancel", seconds(1))));
    expect(await balance(input.guildId, "host")).toBe(1000);
    expect(await db.select().from(ledger).where(eq(ledger.sessionKey, `pvp-settle:${input.id}`))).toHaveLength(1);
    expect(await db.select().from(slots).where(eq(slots.guildId, input.guildId))).toHaveLength(0);
  });
  it("opponent decline refunds the host, not the opponent", async () => {
    const input = await setup(); await createPvpDuel(input, t0);
    await performPvpAction(id(), input.guildId, "opponent", input.id, "decline", seconds(1));
    expect(await balance(input.guildId, "host")).toBe(1000);
    expect(await balance(input.guildId, "opponent")).toBe(1000);
  });
  it("restores expired pending invitations from the database and refunds once", async () => {
    const input = await setup(); await createPvpDuel(input, t0);
    expect(await duePvpGuilds(seconds(121))).toContain(input.guildId);
    await advancePvpGuild(input.guildId, seconds(121));
    await advancePvpGuild(input.guildId, seconds(122));
    expect(await balance(input.guildId, "host")).toBe(1000);
    expect((await saved(input)).state.reason).toContain("対戦不成立");
  });
  it("active timeouts are draws even when remaining HP differ", async () => {
    const input = await setup(); await begin(input);
    await performPvpAction(id(), input.guildId, "host", input.id, "attack", seconds(2), () => 0.99);
    await advancePvpGuild(input.guildId, seconds(62));
    expect((await saved(input)).state.winnerId).toBeUndefined();
    expect(await balance(input.guildId, "host")).toBe(1000);
    expect(await balance(input.guildId, "opponent")).toBe(1000);
  });
  it("opponent victory pays the existing bank wallet and caps damage at actual HP", async () => {
    const input = await setup(); await begin(input);
    await db.update(weapons).set({ attack: 5000, weaponLevel: 2 }).where(and(eq(weapons.guildId, input.guildId), eq(weapons.userId, "opponent")));
    const result = await performPvpAction(id(), input.guildId, "opponent", input.id, "attack", seconds(2), () => 0.99);
    expect(result.duel.status).toBe("finished");
    expect(result.duel.state.winnerId).toBe("opponent");
    expect(result.duel.state.players.find(p => p.userId === "opponent")?.damage).toBe(1000);
    expect(await balance(input.guildId, "host")).toBe(900);
    expect(await balance(input.guildId, "opponent")).toBe(1100);
    expect(result.duel.state.lines.join("\n")).toContain("最後の一撃");
  });
  it("host victory returns only its own prize, without charging the opponent", async () => {
    const input = await setup(); await begin(input);
    await performPvpAction(id(), input.guildId, "opponent", input.id, "surrender", seconds(2));
    expect(await balance(input.guildId, "host")).toBe(1000);
    expect(await balance(input.guildId, "opponent")).toBe(1000);
    expect((await saved(input)).state.winnerId).toBe("host");
  });
  it("host surrender awards the opponent; active cancellation is disallowed", async () => {
    const input = await setup(); await begin(input);
    await expect(performPvpAction(id(), input.guildId, "host", input.id, "cancel", seconds(2))).rejects.toThrow("開始後");
    await performPvpAction(id(), input.guildId, "host", input.id, "surrender", seconds(2));
    expect(await balance(input.guildId, "opponent")).toBe(1100);
  });
  it("serializes simultaneous attacks, enforcing cooldown without money consumption", async () => {
    const input = await setup(); await begin(input);
    const results = await Promise.allSettled([1, 2].map(() => performPvpAction(id(), input.guildId, "host", input.id, "attack", seconds(2), () => 0.99)));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await balance(input.guildId, "host")).toBe(900);
    expect((await saved(input)).state.players[0]?.attackCount).toBe(1);
  });
  it("heals 10% of maximum HP, charges only once and has an independent cooldown", async () => {
    const input = await setup(); await begin(input);
    // Damage the host enough for a full 10% heal.
    await db.update(weapons).set({ attack: 200 }).where(and(eq(weapons.guildId, input.guildId), eq(weapons.userId, "opponent")));
    await performPvpAction(id(), input.guildId, "opponent", input.id, "attack", seconds(2), () => 0.99);
    const before = (await saved(input)).state.players[0]!.hp;
    const heal = id();
    await performPvpAction(heal, input.guildId, "host", input.id, "heal", seconds(3));
    await performPvpAction(heal, input.guildId, "host", input.id, "heal", seconds(3));
    expect((await saved(input)).state.players[0]!.hp).toBe(before + 100);
    expect(await balance(input.guildId, "host")).toBe(850);
    await expect(performPvpAction(id(), input.guildId, "host", input.id, "heal", seconds(4))).rejects.toThrow("待って");
    await performPvpAction(id(), input.guildId, "host", input.id, "attack", seconds(4), () => 0.99);
  });
  it("full HP and insufficient healing balance do not charge or start cooldown", async () => {
    const input = await setup(); await begin(input);
    await expect(performPvpAction(id(), input.guildId, "host", input.id, "heal", seconds(2))).rejects.toThrow("満タン");
    await performPvpAction(id(), input.guildId, "opponent", input.id, "attack", seconds(2), () => 0.99);
    await db.update(wallets).set({ balance: 0 }).where(and(eq(wallets.guildId, input.guildId), eq(wallets.userId, "host")));
    const before = (await saved(input)).state.players[0]!;
    await expect(performPvpAction(id(), input.guildId, "host", input.id, "heal", seconds(3))).rejects.toThrow("残高不足");
    expect((await saved(input)).state.players[0]).toEqual(before);
    // A zero bank balance after joining does not prevent a free attack.
    await performPvpAction(id(), input.guildId, "host", input.id, "attack", seconds(3), () => 0.99);
  });
  it("missing healing fees disable healing, not joining or attacks", async () => {
    const input = await setup(); await db.delete(fees).where(eq(fees.guildId, input.guildId));
    await begin(input);
    await expect(performPvpAction(id(), input.guildId, "host", input.id, "heal", seconds(2))).rejects.toThrow("未設定");
    await performPvpAction(id(), input.guildId, "host", input.id, "attack", seconds(2), () => 0.99);
  });
  it("cannot report a win if prize credit overflows; the lethal attack rolls back", async () => {
    const input = await setup(); await begin(input);
    await db.update(weapons).set({ attack: 5000 }).where(and(eq(weapons.guildId, input.guildId), eq(weapons.userId, "opponent")));
    await db.update(wallets).set({ balance: 2147483647 }).where(and(eq(wallets.guildId, input.guildId), eq(wallets.userId, "opponent")));
    await expect(performPvpAction(id(), input.guildId, "opponent", input.id, "attack", seconds(2), () => 0.99)).rejects.toThrow("残高上限");
    expect((await saved(input)).status).toBe("active");
    expect((await saved(input)).state.players[0]?.hp).toBe(1000);
    expect(await db.select().from(ledger).where(eq(ledger.sessionKey, `pvp-settle:${input.id}`))).toHaveLength(0);
  });
  it("ledger insert failure rolls back reward, terminal state and slot release", async () => {
    const input = await setup(); await begin(input);
    await db.insert(ledger).values({ guildId: input.guildId, userId: "host", amount: 0, reason: "failure fixture", sessionKey: `pvp-settle:${input.id}` });
    await expect(performPvpAction(id(), input.guildId, "host", input.id, "surrender", seconds(2))).rejects.toThrow();
    expect(await balance(input.guildId, "opponent")).toBe(1000);
    expect((await saved(input)).status).toBe("active");
    expect(await db.select().from(slots).where(eq(slots.guildId, input.guildId))).toHaveLength(2);
  });
  it("rejects cross-server actions and reused action IDs with different actors", async () => {
    const input = await setup(); await begin(input);
    await expect(performPvpAction(id(), "other-guild", "host", input.id, "attack", seconds(2))).rejects.toThrow("操作");
    const action = id();
    await performPvpAction(action, input.guildId, "host", input.id, "attack", seconds(2), () => 0.99);
    await expect(performPvpAction(action, input.guildId, "opponent", input.id, "attack", seconds(3))).rejects.toThrow("識別");
    expect((await getPvpDuel(input.guildId, "host")).id).toBe(input.id);
  });
  it("weapon selection and duplicate upgrades queue one card without private stats or balance", async () => {
    const input = await setup(10000);
    const userId = "smith";
    const select = id();
    await selectForgeWeapon(select, input.guildId, userId, "bow", input.channelId);
    await selectForgeWeapon(select, input.guildId, userId, "bow", input.channelId);
    await db.insert(wallets).values({ guildId: input.guildId, userId, balance: 10000 });
    const request = await createForgeUpgradeRequest(id(), input.guildId, userId);
    await Promise.all([1, 2].map(() => settleForgeUpgrade(request.id, input.guildId, userId, () => 0, input.channelId)));
    const cards = await db.select().from(notices).where(eq(notices.guildId, input.guildId));
    expect(cards).toHaveLength(2);
    const text = JSON.stringify(cards.map(c => c.card));
    expect(text).not.toMatch(/balance|attack|defense|内部|残高/);
    expect(text).toContain("武器強化成功");
    expect(text).toContain("Lv2");
    expect(await balance(input.guildId, userId)).toBe(9000);
  });
  it("a failed public send retains its card and backoff; concurrent recovery sends once", async () => {
    const input = await setup(); await createPvpDuel(input, new Date());
    const notice = `pvp-create:${input.id}`;
    const now = new Date(Date.now() + 1000);
    const failed = await deliverRpgCard(notice, async () => { throw new Error("Discord unavailable"); }, now);
    expect(failed?.error).toBeInstanceOf(Error);
    const [row] = await db.select().from(notices).where(eq(notices.id, notice));
    expect(row?.attempts).toBe(1); expect(row?.messageId).toBeNull();
    let sent = 0;
    const send = async () => { sent++; return "message"; };
    await Promise.all([1, 2].map(() => deliverRpgCard(notice, send, new Date(now.getTime() + 16000))));
    expect(sent).toBe(1);
  });
});
