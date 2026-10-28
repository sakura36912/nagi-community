import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  db, ensureBossSchema, configureBossFees, createBossEvent, createBossJoinRequest, confirmBossJoin,
  cancelBossJoinRequest, advanceBossGuild, performBossAction, endBossEvent, getBossInfo,
  getBossBattleBundle, dueBossGuilds, deliverBossNotice, getBossFees, selectForgeWeapon,
  bossFeesTable, bossEventsTable, bossBattlesTable, bossMembersTable, bossActiveUsersTable,
  bossJoinRequestsTable, bossActionsTable, forgeWeaponsTable, forgeActionsTable, walletsTable, transactionsTable,
  type BossConfig, type BossMode,
} from "@workspace/db";

describe.skipIf(process.env.RUN_BOSS_DB_TESTS !== "1")("boss persistent atomic flow", () => {
  const guilds: string[] = [];
  let guild: string;
  const now = new Date();
  const at = (seconds: number) => new Date(now.getTime() + seconds * 1000);
  const id = () => randomUUID();
  const base: BossConfig = {
    soloHp: 100, partyHp: 200, attack: 10, defense: 0, reward: 101,
    durationSeconds: 1000, lobbySeconds: 10, playerHp: 100, healAmount: 25,
    counterEvery: 2, cooldownSeconds: 1, criticalPercent: 0, criticalMultiplier: 2,
    levelBonusPercent: 0, special: "none", bonusRoleId: null, roleMultiplier: 1,
  };
  beforeAll(async () => { await ensureBossSchema(); });
  beforeEach(() => { guild = `boss-test-${id()}`; guilds.push(guild); });
  afterAll(async () => {
    for (const guildId of guilds) for (const table of [bossActionsTable, bossJoinRequestsTable, bossActiveUsersTable,
      bossMembersTable, bossBattlesTable, bossEventsTable, bossFeesTable, forgeWeaponsTable,
      forgeActionsTable, walletsTable, transactionsTable]) await db.delete(table).where(eq(table.guildId, guildId));
  });
  async function host(patch: Partial<BossConfig> = {}, costs = true) {
    if (costs) await configureBossFees(guild, { attackCost: 10, healCost: 20 });
    return createBossEvent(id(), guild, "channel", "kraken", { ...base, ...patch }, now);
  }
  async function wallet(user: string, balance: number) {
    await db.insert(walletsTable).values({ guildId: guild, userId: user, balance })
      .onConflictDoUpdate({ target: [walletsTable.guildId, walletsTable.userId], set: { balance } });
  }
  async function balance(user: string) {
    const [row] = await db.select().from(walletsTable).where(and(eq(walletsTable.guildId, guild), eq(walletsTable.userId, user)));
    return row?.balance;
  }
  async function prepare(user: string) {
    await selectForgeWeapon(id(), guild, user, "greatsword");
    await wallet(user, 1000);
  }
  async function join(user: string, mode: BossMode = "solo", roles: string[] = []) {
    const quote = await createBossJoinRequest(id(), guild, user, mode, now);
    return confirmBossJoin(quote.request.id, guild, user, `名前-${user}`, roles, now);
  }
  const attack = (user: string, seconds = 1, operation = id()) => performBossAction(operation, guild, user, "attack", { now: at(seconds), roll: () => 0.5 });

  it("allows hosting without prices but blocks participation until both fees are set", async () => {
    await host({}, false); await prepare("a");
    expect(await getBossFees(guild)).toEqual({ attackCost: null, healCost: null });
    await expect(createBossJoinRequest(id(), guild, "a", "solo", now)).rejects.toThrow("未設定");
    await configureBossFees(guild, { attackCost: 0 });
    await expect(createBossJoinRequest(id(), guild, "a", "solo", now)).rejects.toThrow("未設定");
    await configureBossFees(guild, { healCost: 0 });
    const joined = await join("a");
    const result = await attack("a");
    expect(joined.state).toBe("active");
    expect(result.paid).toBe(0);
    expect(await balance("a")).toBe(1000);
  });
  it("requires weapons, distinct active membership, and explicit participant ownership", async () => {
    await host(); await prepare("a");
    await expect(createBossJoinRequest(id(), guild, "missing", "solo", now)).rejects.toThrow("武器");
    const quote = await createBossJoinRequest(id(), guild, "a", "solo", now);
    await expect(confirmBossJoin(quote.request.id, guild, "other", "other", [], now)).rejects.toThrow();
    await confirmBossJoin(quote.request.id, guild, "a", "a", [], now);
    await expect(createBossJoinRequest(id(), guild, "a", "party", now)).rejects.toThrow("参加中");
  });
  it("starts solo immediately with solo HP and stores a role/weapon snapshot", async () => {
    await host({ bonusRoleId: "bonus", roleMultiplier: 2 }); await prepare("a");
    const result = await join("a", "solo", ["bonus"]);
    const bundle = await getBossBattleBundle(result.battleId);
    expect(bundle?.battle.currentHp).toBe(100);
    expect(bundle?.members[0]?.weapon.roleMultiplier).toBe(2);
    expect(bundle?.members[0]?.displayName).toBe("名前-a");
    expect((await attack("a")).damage).toBe(32);
  });
  it("starts a full party automatically and never creates a party above four", async () => {
    await host();
    for (const user of ["a", "b", "c", "d", "e"]) await prepare(user);
    const quotes = await Promise.all(["a", "b", "c", "d", "e"].map(user => createBossJoinRequest(id(), guild, user, "party", now)));
    const joined = await Promise.all(quotes.map((quote, i) => confirmBossJoin(quote.request.id, guild, ["a", "b", "c", "d", "e"][i]!, "name", [], now)));
    const info = await getBossInfo(guild, now);
    expect(info?.battles).toHaveLength(2);
    expect(info?.battles.filter(b => b.status === "active")).toHaveLength(1);
    const activeBattle = info!.battles.find(b => b.status === "active")!;
    expect(info!.members.filter(m => m.battleId === activeBattle.id)).toHaveLength(4);
    expect(activeBattle.currentHp).toBe(200);
    expect(new Set(joined.map(r => r.battleId)).size).toBe(2);
  });
  it("starts two or three participants when registration expires, and cancels a single participant", async () => {
    await host(); await prepare("a"); await prepare("b");
    const first = await join("a", "party"); await join("b", "party");
    await advanceBossGuild(guild, at(11));
    expect((await getBossBattleBundle(first.battleId))?.battle.status).toBe("active");
    await prepare("c"); const soloLobby = await join("c", "party");
    await advanceBossGuild(guild, at(11));
    expect((await getBossBattleBundle(soloLobby.battleId))?.battle.status).toBe("cancelled");
    const membership = await db.select().from(bossActiveUsersTable).where(and(eq(bossActiveUsersTable.guildId, guild), eq(bossActiveUsersTable.userId, "c")));
    expect(membership).toHaveLength(0);
    expect(await balance("c")).toBe(1000);
  });
  it("rejects duplicate membership even when different modes confirm concurrently", async () => {
    await host(); await prepare("a");
    const solo = await createBossJoinRequest(id(), guild, "a", "solo", now);
    const party = await createBossJoinRequest(id(), guild, "a", "party", now);
    const results = await Promise.allSettled([confirmBossJoin(solo.request.id, guild, "a", "a", [], now), confirmBossJoin(party.request.id, guild, "a", "a", [], now)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  });
  it("charges and damages once for duplicate action delivery", async () => {
    await host(); await prepare("a"); const joined = await join("a");
    const operation = id();
    const results = await Promise.all([attack("a", 1, operation), attack("a", 1, operation)]);
    expect(results.filter(r => r.repeated)).toHaveLength(1);
    expect(await balance("a")).toBe(990);
    expect((await getBossBattleBundle(joined.battleId))?.battle.currentHp).toBe(84);
    const ledger = await db.select().from(transactionsTable).where(eq(transactionsTable.sessionKey, `boss-action:${operation}`));
    expect(ledger).toHaveLength(1);
  });
  it("does not charge or advance combat for insufficient balance or cooldown", async () => {
    await host(); await prepare("a"); const joined = await join("a");
    await wallet("a", 9);
    await expect(attack("a")).rejects.toThrow("残高");
    expect((await getBossBattleBundle(joined.battleId))?.battle.currentHp).toBe(100);
    await wallet("a", 1000); await attack("a");
    await expect(attack("a", 1)).rejects.toThrow("お待ち");
    expect(await balance("a")).toBe(990);
  });
  it("charges healing only when effective and applies boss counters on paid actions", async () => {
    await host({ counterEvery: 1 }); await prepare("a"); await join("a");
    await expect(performBossAction(id(), guild, "a", "heal", { now })).rejects.toThrow("満タン");
    expect(await balance("a")).toBe(1000);
    const hit = await attack("a");
    expect(hit.userHp).toBeLessThan(100);
    const healed = await performBossAction(id(), guild, "a", "heal", { now: at(3), roll: () => 0.5 });
    expect(healed.healed).toBeGreaterThan(0);
    expect(await balance("a")).toBe(970);
  });
  it("atomically splits the reward with exact remainder and never pays twice", async () => {
    await host({ partyHp: 1 }); await prepare("a"); await prepare("b");
    const joined = await join("a", "party"); await join("b", "party");
    await advanceBossGuild(guild, at(11));
    const operation = id();
    const result = await attack("a", 12, operation);
    expect(result.state).toBe("won");
    expect(await balance("a")).toBe(1041);
    expect(await balance("b")).toBe(1050);
    const repeat = await attack("a", 13, operation);
    expect(repeat.repeated).toBe(true);
    expect(await balance("a")).toBe(1041);
    expect((await getBossBattleBundle(joined.battleId))?.battle.rewards.reduce((sum, r) => sum + r.amount, 0)).toBe(101);
    const rewardLedger = await db.select().from(transactionsTable).where(eq(transactionsTable.guildId, guild));
    expect(rewardLedger.filter(t => t.sessionKey?.startsWith("boss-reward:"))).toHaveLength(2);
  });
  it("doubles total reward, not each party member's share", async () => {
    await host({ partyHp: 1, special: "double_reward" }); await prepare("a"); await prepare("b");
    await join("a", "party"); await join("b", "party"); await advanceBossGuild(guild, at(11));
    await attack("a", 12);
    expect(await balance("a")).toBe(1091);
    expect(await balance("b")).toBe(1101);
  });
  it("rolls back debit, boss HP and reward if any reward recipient overflows", async () => {
    await host({ partyHp: 1 }); await prepare("a"); await prepare("b");
    const joined = await join("a", "party"); await join("b", "party"); await advanceBossGuild(guild, at(11));
    await wallet("b", 2147483647);
    await expect(attack("a", 12)).rejects.toThrow("残高上限");
    expect(await balance("a")).toBe(1000);
    const bundle = await getBossBattleBundle(joined.battleId);
    expect(bundle?.battle.status).toBe("active");
    expect(bundle?.battle.currentHp).toBe(1);
    await wallet("b", 1000);
    await attack("a", 13);
    expect(await balance("a")).toBe(1041);
  });
  it("rolls back combat and money if ledger insertion fails", async () => {
    await host(); await prepare("a"); const joined = await join("a");
    const operation = id();
    await db.insert(transactionsTable).values({ guildId: guild, userId: "a", amount: 0, reason: "synthetic collision", sessionKey: `boss-action:${operation}` });
    await expect(attack("a", 1, operation)).rejects.toThrow();
    expect(await balance("a")).toBe(1000);
    expect((await getBossBattleBundle(joined.battleId))?.battle.currentHp).toBe(100);
  });
  it("marks total defeat and prevents defeated players from buying heals", async () => {
    await host({ attack: 1000, counterEvery: 1 }); await prepare("a"); const joined = await join("a");
    expect((await attack("a")).state).toBe("failed");
    await expect(performBossAction(id(), guild, "a", "heal", { now: at(5) })).rejects.toThrow();
    expect(await balance("a")).toBe(990);
    expect((await getBossBattleBundle(joined.battleId))?.battle.reason).toContain("戦闘不能");
  });
  it("restores deadline processing from DB and never charges after expiry", async () => {
    await host(); await prepare("a"); const joined = await join("a");
    expect(await dueBossGuilds(at(1001))).toContain(guild);
    await advanceBossGuild(guild, at(1001));
    expect((await getBossBattleBundle(joined.battleId))?.battle.status).toBe("failed");
    expect(await getBossInfo(guild, at(1001))).toBeUndefined();
    await expect(attack("a", 1002)).rejects.toThrow();
    expect(await balance("a")).toBe(1000);
  });
  it("force-end cancels queues, fails active fights and does not refund past actions", async () => {
    await host(); await prepare("a"); await prepare("b");
    const solo = await join("a"); const lobby = await join("b", "party");
    await attack("a");
    await endBossEvent(guild, at(2));
    expect((await getBossBattleBundle(solo.battleId))?.battle.status).toBe("failed");
    expect((await getBossBattleBundle(lobby.battleId))?.battle.status).toBe("cancelled");
    expect(await balance("a")).toBe(990);
    expect(await balance("b")).toBe(1000);
  });
  it("requires reconfirmation on fee changes, then keeps accepted fees fixed", async () => {
    await host(); await prepare("a");
    const quote = await createBossJoinRequest(id(), guild, "a", "solo", now);
    await configureBossFees(guild, { attackCost: 100 });
    await expect(confirmBossJoin(quote.request.id, guild, "a", "a", [], now)).rejects.toThrow("料金");
    await join("a");
    await configureBossFees(guild, { attackCost: 999 });
    expect((await attack("a")).paid).toBe(100);
  });
  it("cancels pending join confirmations without touching money", async () => {
    await host(); await prepare("a");
    const quote = await createBossJoinRequest(id(), guild, "a", "solo", now);
    await expect(cancelBossJoinRequest(quote.request.id, guild, "other")).rejects.toThrow();
    await cancelBossJoinRequest(quote.request.id, guild, "a");
    await expect(confirmBossJoin(quote.request.id, guild, "a", "a", [], now)).rejects.toThrow();
    expect(await balance("a")).toBe(1000);
  });
  it("retries announcements without re-running payouts and serializes duplicate deliveries", async () => {
    await host({ soloHp: 1 }); await prepare("a"); const joined = await join("a");
    await attack("a");
    const failed = await deliverBossNotice(joined.battleId, async () => { throw new Error("temporary send failure"); }, at(2));
    expect(failed?.error).toBeInstanceOf(Error);
    let sent = 0;
    await Promise.all([1, 2].map(() => deliverBossNotice(joined.battleId, async bundle => {
      expect(bundle.battle.status).toBe("won"); sent++; return "notice";
    }, at(100))));
    expect(sent).toBe(1);
    expect(await balance("a")).toBe(1091);
    expect((await getBossBattleBundle(joined.battleId))?.battle.noticeState).toBe("won");
  });
  it("keeps guild data isolated and rejects cross-guild replay", async () => {
    await host(); await prepare("a"); await join("a");
    const operation = id(); await attack("a", 1, operation);
    const other = `boss-test-${id()}`; guilds.push(other);
    await expect(performBossAction(operation, other, "a", "attack", { now: at(2) })).rejects.toThrow("識別");
    expect(await getBossFees(other)).toEqual({ attackCost: null, healCost: null });
    expect(await balance("a")).toBe(990);
  });
  it("does not stop a newer event when the same admin end operation is replayed", async () => {
    await host();
    const operation = { id: id(), actorId: "admin" };
    const ended = await endBossEvent(guild, at(1), operation);
    const next = await createBossEvent(id(), guild, "channel", "kraken", base, at(2));
    const repeated = await endBossEvent(guild, at(3), operation);
    expect(repeated.id).toBe(ended.id);
    expect((await getBossInfo(guild, at(3)))?.event.id).toBe(next.id);
  });
  it("serializes simultaneous killing actions and settles the winning party only once", async () => {
    await host({ partyHp: 1 }); await prepare("a"); await prepare("b");
    await join("a", "party"); await join("b", "party"); await advanceBossGuild(guild, at(11));
    const results = await Promise.allSettled([attack("a", 12), attack("b", 12)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((await balance("a"))! + (await balance("b"))!).toBe(2091);
    const ledger = await db.select().from(transactionsTable).where(eq(transactionsTable.guildId, guild));
    expect(ledger.filter(t => t.sessionKey?.startsWith("boss-reward:"))).toHaveLength(2);
    expect(ledger.filter(t => t.sessionKey?.startsWith("boss-action:"))).toHaveLength(1);
  });
});
