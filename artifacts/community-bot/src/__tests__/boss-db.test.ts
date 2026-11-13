import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  db, ensureBossSchema, configureBossFees, createBossEvent, createBossJoinRequest, confirmBossJoin,
  cancelBossJoinRequest, advanceBossGuild, performBossAction, endBossEvent, getBossInfo,
  getBossBattleBundle, dueBossGuilds, deliverBossNotice, getBossFees, selectForgeWeapon,
  bossFeesTable, bossEventsTable, bossBattlesTable, bossMembersTable, bossActiveUsersTable,
  bossJoinRequestsTable, bossActionsTable, forgeWeaponsTable, forgeActionsTable, walletsTable, transactionsTable, generateBossCombatStats,
  type BossConfig, type BossMode,
  createForgeUpgradeRequest, settleForgeUpgrade, configureForgeSetting,
  forgeUpgradeRequestsTable, forgeUpgradeSettingsTable,
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
    counterEvery: 2, cooldownSeconds: 1, attackCooldownSeconds: 1, healCooldownSeconds: 1, criticalPercent: 0, criticalMultiplier: 2,
    levelBonusPercent: 0, special: "none", bonusRoleId: null, roleMultiplier: 1,
  };
  beforeAll(async () => { await ensureBossSchema(); });
  beforeEach(() => { guild = `boss-test-${id()}`; guilds.push(guild); });
  afterAll(async () => {
    for (const guildId of guilds) for (const table of [bossActionsTable, bossJoinRequestsTable, bossActiveUsersTable,
      bossMembersTable, bossBattlesTable, bossEventsTable, bossFeesTable, forgeWeaponsTable,
      forgeActionsTable, forgeUpgradeRequestsTable, forgeUpgradeSettingsTable,
      walletsTable, transactionsTable]) await db.delete(table).where(eq(table.guildId, guildId));
  });
  async function host(patch: Partial<BossConfig> = {}, costs = true) {
    if (costs) await configureBossFees(guild, { healCost: 20 });
    return createBossEvent(id(), guild, "channel", "kraken", { ...base, ...patch }, now);
  }
  it("persists generated stats once and preserves them on hosting retry and later reads", async () => {
    const operation = id();
    const generated = { ...base, ...generateBossCombatStats("kraken", () => 0) };
    const event = await createBossEvent(operation, guild, "channel", "kraken", generated, now);
    const retried = await createBossEvent(operation, guild, "channel", "kraken",
      { ...base, ...generateBossCombatStats("kraken", () => 0.999999) }, now);
    expect(retried.config).toEqual(event.config);
    expect(event.config.defense).toBe(0);
    expect(retried.config.defense).toBe(0); // A retry must not replace it with the new roll of 2.
    expect((await getBossInfo(guild, now))?.event.config).toEqual(generated);
  });
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
  const heal = (user: string, seconds: number, operation = id()) =>
    performBossAction(operation, guild, user, "heal", { now: at(seconds), roll: () => 0.5 });

  it.each([["kraken", 50], ["megalodon", 80], ["leviathan", 100]] as const)(
    "%s uses the solo member's snapshotted maximum HP at %s percent", async (type, percent) => {
      await createBossEvent(id(), guild, "channel", type,
        { ...base, ...generateBossCombatStats(type, () => 0) }, now);
      await prepare("a"); await wallet("a", 12345);
      const result = await join("a");
      expect(result.bossHp).toBe(Math.floor(12345 * percent / 100));
      await wallet("a", 900);
      expect((await getBossBattleBundle(result.battleId))!.battle.maxHp).toBe(result.bossHp);
    });
  it.each([2, 3, 4])("freezes the sum of %s party members' maximum HP on either start path", async count => {
    await host({ ...generateBossCombatStats("megalodon", () => 0), bossHpPercent: 50 });
    // The event type is kraken; its validated percentage is 50%.
    let battleId = "";
    for (let n = 1; n <= count; n++) {
      const user = `p${n}`; await prepare(user); await wallet(user, n * 1000);
      battleId = (await join(user, "party")).battleId;
    }
    await advanceBossGuild(guild, at(11));
    const bundle = (await getBossBattleBundle(battleId))!;
    expect(bundle.battle.status).toBe("active");
    expect(bundle.battle.maxHp).toBe((count * (count + 1) / 2) * 500);
    await wallet("p1", 50000);
    await advanceBossGuild(guild, at(12));
    expect((await getBossBattleBundle(battleId))!.battle.maxHp).toBe(bundle.battle.maxHp);
  });
  it("rejects another battle's public buttons before damage, healing or ledger changes", async () => {
    await host(); await prepare("a"); await prepare("b");
    const a = await join("a"), b = await join("b");
    for (const action of ["attack", "heal"] as const) {
      await expect(performBossAction(id(), guild, "a", action,
        { now: at(1), battleId: b.battleId })).rejects.toThrow("このカード");
    }
    expect((await getBossBattleBundle(a.battleId))!.battle.actionCount).toBe(0);
    expect((await getBossBattleBundle(b.battleId))!.battle.actionCount).toBe(0);
    expect(await balance("a")).toBe(1000);
  });
  it("old finished-battle buttons cannot act on the same user's newly joined battle", async () => {
    await host({ soloHp: 1 }); await prepare("a");
    const old = await join("a"); await attack("a");
    const current = await join("a");
    await expect(performBossAction(id(), guild, "a", "heal",
      { now: at(2), battleId: old.battleId })).rejects.toThrow("このカード");
    expect((await getBossBattleBundle(current.battleId))!.battle.actionCount).toBe(0);
  });
  it("party members share the card but attack and heal only their own character", async () => {
    await host({ counterEvery: 1 }); await prepare("a"); await prepare("b");
    const a = await join("a", "party"); await join("b", "party");
    const first = await performBossAction(id(), guild, "a", "attack",
      { now: at(11), roll: () => 0.5, battleId: a.battleId });
    const second = await performBossAction(id(), guild, "b", "attack",
      { now: at(12), roll: () => 0.5, battleId: a.battleId });
    expect(first.battleId).toBe(second.battleId);
    const bundle = (await getBossBattleBundle(a.battleId))!;
    expect(bundle.members.map(p => p.attackCount)).toEqual([1, 1]);
    const damaged = bundle.members.find(p => p.hp < p.maxHp)!;
    const other = bundle.members.find(p => p.userId !== damaged.userId)!;
    const before = await balance(damaged.userId);
    const result = await performBossAction(id(), guild, damaged.userId, "heal",
      { now: at(13), roll: () => 0.5, battleId: a.battleId });
    expect(result.paid).toBe(20);
    expect(await balance(damaged.userId)).toBe(before! - 20);
    expect(await balance(other.userId)).toBe(1000);
  });
  it("buttons and slash commands share cooldowns and idempotency; receipt IDs cannot switch battles", async () => {
    await host(); await prepare("a");
    const joined = await join("a"), operation = id();
    const first = await performBossAction(operation, guild, "a", "attack",
      { now: at(1), roll: () => 0.5, battleId: joined.battleId });
    const repeated = await performBossAction(operation, guild, "a", "attack",
      { now: at(1), roll: () => { throw new Error("must not reroll"); }, battleId: joined.battleId });
    expect(repeated).toMatchObject({ repeated: true, damage: first.damage });
    await expect(attack("a", 1)).rejects.toThrow("お待ちください");
    await expect(performBossAction(operation, guild, "a", "attack",
      { now: at(1), battleId: "other-battle" })).rejects.toThrow("討伐ID");
    expect((await getBossBattleBundle(joined.battleId))!.battle.actionCount).toBe(1);
  });
  it("commits a combo and its narration once, with one cooldown, counter and ledger action", async () => {
    await host({ soloHp: 10000, counterEvery: 1 });
    await prepare("a"); const joined = await join("a");
    const operation = id();
    const strike = () => performBossAction(operation, guild, "a", "attack", { now: at(1), roll: () => 0 });
    const results = await Promise.all([strike(), strike()]);
    const result = results.find(r => !r.repeated)!;
    expect(result.presentation!.hits).toEqual([14, 6]);
    expect(result.damage).toBe(20);
    expect(result.presentation!.hits.reduce((a, b) => a + b, 0)).toBe(result.damage);
    expect(results[0]!.presentation).toEqual(results[1]!.presentation);
    const bundle = (await getBossBattleBundle(joined.battleId))!;
    expect(bundle.battle).toMatchObject({ currentHp: 9980, actionCount: 1, counterTurn: 1 });
    expect(bundle.members[0]).toMatchObject({ damage: 20, attackCount: 1 });
    expect(bundle.members[0]!.effects.attackReadyAt).toBe(at(2).getTime());
    expect(await balance("a")).toBe(1000);
    const ledger = await db.select().from(transactionsTable)
      .where(eq(transactionsTable.sessionKey, `boss-action:${operation}`));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.amount).toBe(0);
    await expect(performBossAction(operation, guild, "a", "attack",
      { now: at(2), roll: () => { throw new Error("must not reroll"); } })).resolves.toMatchObject({
        repeated: true, presentation: result.presentation,
      });
  });
  it("stores 20-percent part HP and applies the 20-percent counterattack reduction on destruction", async () => {
    await host({ soloHp: 10000, counterEvery: 1, attackCooldownSeconds: 0 });
    await prepare("a");
    const joined = await join("a");
    const initial = (await getBossBattleBundle(joined.battleId))!.battle.parts;
    expect(initial).toMatchObject({
      left_tentacle: { hp: 2000, maxHp: 2000 },
      right_tentacle: { hp: 2000, maxHp: 2000 },
      head: { hp: 2000, maxHp: 2000 },
    });
    await db.update(bossBattlesTable).set({
      parts: { ...initial, left_tentacle: { hp: 1, maxHp: 2000 } },
    }).where(eq(bossBattlesTable.id, joined.battleId));
    const result = await performBossAction(id(), guild, "a", "attack", {
      now: at(1), roll: () => 0.5, targetPart: "left_tentacle",
    });
    const saved = (await getBossBattleBundle(joined.battleId))!;
    expect(saved.battle.parts.left_tentacle?.hp).toBe(0);
    expect(result.messages.join("\n")).toContain("左触手を破壊");
    expect(result.messages.join("\n")).toContain("現在80%");
    expect(result.messages.join("\n")).toContain("反撃威力が80%に低下");
  });
  it("saves overkill and finish narration but credits only the remaining HP and one reward", async () => {
    await host({ soloHp: 1, counterEvery: 1 });
    await prepare("a"); const joined = await join("a");
    const operation = id();
    const result = await attack("a", 1, operation);
    expect(result.damage).toBe(1);
    expect(result.presentation).toMatchObject({ hits: [1], overkill: true, finish: true });
    expect(result.presentation!.lines.join("\n")).toContain("クラーケンを討伐");
    expect(result.state).toBe("won");
    expect(await balance("a")).toBe(1101);
    expect((await getBossBattleBundle(joined.battleId))!.members[0]!.damage).toBe(1);
    const repeated = await attack("a", 2, operation);
    expect(repeated.presentation).toEqual(result.presentation);
    expect(await balance("a")).toBe(1101);
  });

  it("uses an upgrade on the next attack in an existing battle without changing HP, defense or role snapshot", async () => {
    await host({ soloHp: 10000, playerHpSource: "wallet", counterEvery: 100,
      bonusRoleId: "bonus", roleMultiplier: 2, levelBonusPercent: 10 });
    await prepare("a");
    const joined = await join("a", "solo", ["bonus"]);
    const before = (await getBossBattleBundle(joined.battleId))!.members[0]!;
    const operation = id();
    const first = await attack("a", 1, operation);
    const quote = await createForgeUpgradeRequest(id(), guild, "a");
    await settleForgeUpgrade(quote.id, guild, "a", () => 0);
    const second = await attack("a", 2);
    expect(first.damage).toBe(32);
    expect(second.damage).toBe(44); // Lv2 attack 20 * 1.1 level bonus * frozen role 2.
    const after = (await getBossBattleBundle(joined.battleId))!.members[0]!;
    expect(after.weapon).toEqual({ ...before.weapon, weaponLevel: 2, attack: 20 });
    expect(after.maxHp).toBe(before.maxHp);
    expect(after.hp).toBe(before.hp);
    expect(await balance("a")).toBe(0); // Only the upgrade cost was charged.
    // Replaying an attack from before the upgrade must not recalculate damage.
    expect(await attack("a", 3, operation)).toMatchObject({
      repeated: true, damage: first.damage, bossHp: first.bossHp, paid: 0,
    });
    expect((await getBossBattleBundle(joined.battleId))!.battle.currentHp)
      .toBe(10000 - first.damage! - second.damage!);
  });
  it("keeps attack unchanged when a paid upgrade fails", async () => {
    await host({ soloHp: 10000, counterEvery: 100 });
    await prepare("a");
    await configureForgeSetting(id(), guild, "admin", 1, { successRate: 30 });
    await join("a");
    const first = await attack("a", 1);
    const quote = await createForgeUpgradeRequest(id(), guild, "a");
    expect((await settleForgeUpgrade(quote.id, guild, "a", () => 0.99)).success).toBe(false);
    expect((await attack("a", 2)).damage).toBe(first.damage);
    expect(await balance("a")).toBe(0);
  });
  it("refreshes only the attacker's same-guild weapon and leaves party allies untouched", async () => {
    await host({ partyHp: 10000, counterEvery: 100 });
    await prepare("a"); await prepare("b");
    const joined = await join("a", "party");
    await join("b", "party");
    await advanceBossGuild(guild, at(11));
    const quote = await createForgeUpgradeRequest(id(), guild, "a");
    await settleForgeUpgrade(quote.id, guild, "a", () => 0);
    expect((await attack("a", 12)).damage).toBe(20);
    expect((await attack("b", 12)).damage).toBe(16);
    const bundle = (await getBossBattleBundle(joined.battleId))!;
    expect(bundle.members.find(p => p.userId === "a")!.weapon.weaponLevel).toBe(2);
    expect(bundle.members.find(p => p.userId === "b")!.weapon.weaponLevel).toBe(1);
  });
  it("does not replace the battle's weapon type or skill after an administrator changes the weapon", async () => {
    await host({ soloHp: 10000, counterEvery: 100 });
    await prepare("a"); const joined = await join("a");
    await db.update(forgeWeaponsTable).set({ weaponType: "staff", weaponLevel: 10, attack: 500 })
      .where(and(eq(forgeWeaponsTable.guildId, guild), eq(forgeWeaponsTable.userId, "a")));
    expect((await attack("a")).damage).toBe(16);
    expect((await getBossBattleBundle(joined.battleId))!.members[0]!.weapon)
      .toMatchObject({ weaponType: "greatsword", weaponLevel: 1, attack: 16 });
  });

  it("snapshots the wallet at confirmation, preserves it on retry, and never debits money for damage", async () => {
    await host({ soloHp: 10000, playerHpSource: "wallet", healingMode: "max_hp_10_percent", counterEvery: 1 });
    await prepare("a");
    const quote = await createBossJoinRequest(id(), guild, "a", "solo", now);
    await wallet("a", 1234);
    const joined = await confirmBossJoin(quote.request.id, guild, "a", "a", [], now);
    expect(joined.userHp).toBe(1234);
    expect((await getBossBattleBundle(joined.battleId))!.members[0]).toMatchObject({ hp: 1234, maxHp: 1234 });
    await wallet("a", 2000);
    await confirmBossJoin(quote.request.id, guild, "a", "a", [], now);
    const hit = await attack("a");
    expect(hit.userHp).toBeLessThan(1234);
    expect(await balance("a")).toBe(2000);
    expect((await getBossBattleBundle(joined.battleId))!.members[0]!.maxHp).toBe(1234);
    await db.update(bossMembersTable).set({ hp: 500 }).where(eq(bossMembersTable.battleId, joined.battleId));
    const operation = id();
    const result = await heal("a", 2, operation);
    expect(result.healed).toBe(123);
    expect(await balance("a")).toBe(1980);
    await heal("a", 2, operation);
    expect(await balance("a")).toBe(1980);
    expect((await getBossBattleBundle(joined.battleId))!.members[0]!.maxHp).toBe(1234);
  });
  it("snapshots each party member's own wallet independently", async () => {
    await host({ playerHpSource: "wallet", healingMode: "max_hp_10_percent" });
    await prepare("a"); await prepare("b"); await wallet("b", 2300);
    const a = await join("a", "party"), b = await join("b", "party");
    expect(a.battleId).toBe(b.battleId);
    const players = (await getBossBattleBundle(a.battleId))!.members;
    expect(players.find(p => p.userId === "a")!.maxHp).toBe(1000);
    expect(players.find(p => p.userId === "b")!.maxHp).toBe(2300);
    expect(await balance("a")).toBe(1000);
    expect(await balance("b")).toBe(2300);
  });
  it("blocks missing or zero wallet HP before creating a battle and allows one-dollar HP", async () => {
    await host({ playerHpSource: "wallet", healingMode: "max_hp_10_percent", counterEvery: 100 });
    await prepare("a");
    await wallet("a", 0);
    await expect(join("a")).rejects.toThrow("所持金が1以上");
    await db.delete(walletsTable).where(eq(walletsTable.guildId, guild));
    await expect(join("a")).rejects.toThrow("所持金が1以上");
    expect(await db.select().from(bossBattlesTable).where(eq(bossBattlesTable.guildId, guild))).toHaveLength(0);
    await wallet("a", 1);
    const joined = await join("a");
    expect((await getBossBattleBundle(joined.battleId))!.members[0]).toMatchObject({ hp: 1, maxHp: 1 });
    await expect(heal("a", 1)).rejects.toThrow("HPが満タン");
    expect(await balance("a")).toBe(1);
  });

  it("persists independent attack/heal deadlines and accepts exactly at each boundary", async () => {
    await host({ soloHp: 10000, attackCooldownSeconds: 5, healCooldownSeconds: 30, counterEvery: 100 });
    await prepare("a"); const joined = await join("a");
    await db.update(bossMembersTable).set({ hp: 20 }).where(eq(bossMembersTable.battleId, joined.battleId));
    await attack("a", 1);
    await heal("a", 1); // Attack cooldown never blocks healing.
    await expect(attack("a", 5)).rejects.toThrow("攻撃まで1秒");
    await attack("a", 6); // Healing cooldown never blocks attacking.
    await expect(heal("a", 30)).rejects.toThrow("回復まで1秒");
    const saved = (await getBossBattleBundle(joined.battleId))!.members[0]!.effects;
    expect(saved.attackReadyAt).toBe(at(11).getTime());
    expect(saved.healReadyAt).toBe(at(31).getTime());
    await heal("a", 31);
    expect(await balance("a")).toBe(960);
  });
  it("defaults legacy events to 5-second attacks and 30-second heals, not a shared cooldown", async () => {
    await host({ soloHp: 10000, attackCooldownSeconds: undefined, healCooldownSeconds: undefined, cooldownSeconds: 999, counterEvery: 100 });
    await prepare("a"); const joined = await join("a");
    await db.update(bossMembersTable).set({ hp: 20, actionReadyAt: at(999) }).where(eq(bossMembersTable.battleId, joined.battleId));
    await attack("a", 1); await heal("a", 1);
    const saved = (await getBossBattleBundle(joined.battleId))!.members[0]!.effects;
    expect(saved.attackReadyAt).toBe(at(6).getTime());
    expect(saved.healReadyAt).toBe(at(31).getTime());
  });
  it("charges a paid heal only once on simultaneous duplicate delivery", async () => {
    await host(); await prepare("a"); const joined = await join("a");
    await db.update(bossMembersTable).set({ hp: 20 }).where(eq(bossMembersTable.battleId, joined.battleId));
    const operation = id();
    const results = await Promise.all([heal("a", 1, operation), heal("a", 1, operation)]);
    expect(results.filter(r => r.repeated)).toHaveLength(1);
    expect(await balance("a")).toBe(980);
    expect((await getBossBattleBundle(joined.battleId))!.members[0]!.hp).toBe(45);
    const ledger = await db.select().from(transactionsTable).where(eq(transactionsTable.sessionKey, `boss-action:${operation}`));
    expect(ledger).toHaveLength(1); expect(ledger[0]!.amount).toBe(-20);
  });
  it("serializes distinct simultaneous heals to enforce the cooldown", async () => {
    await host(); await prepare("a"); const joined = await join("a");
    await db.update(bossMembersTable).set({ hp: 20 }).where(eq(bossMembersTable.battleId, joined.battleId));
    const results = await Promise.allSettled([heal("a", 1), heal("a", 1)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await balance("a")).toBe(980);
  });
  it("does not charge, heal or consume cooldown on insufficient funds; same operation can retry", async () => {
    await host(); await prepare("a"); const joined = await join("a");
    await db.update(bossMembersTable).set({ hp: 20 }).where(eq(bossMembersTable.battleId, joined.battleId));
    await wallet("a", 19);
    const operation = id();
    await expect(heal("a", 1, operation)).rejects.toThrow("残高");
    const player = (await getBossBattleBundle(joined.battleId))!.members[0]!;
    expect(player.hp).toBe(20); expect(player.effects.healReadyAt).toBeUndefined();
    expect(await balance("a")).toBe(19);
    await wallet("a", 20); await heal("a", 1, operation);
    expect(await balance("a")).toBe(0);
  });
  it("never charges attacks from old paid battles, including a missing wallet", async () => {
    await host(); await prepare("a"); const joined = await join("a");
    await db.update(bossBattlesTable).set({ attackCost: 999 }).where(eq(bossBattlesTable.id, joined.battleId));
    await db.delete(walletsTable).where(eq(walletsTable.guildId, guild));
    expect((await attack("a")).paid).toBe(0);
    expect(await balance("a")).toBeUndefined();
  });
  it("rolls back a paid heal and its cooldown when its ledger insert fails", async () => {
    await host(); await prepare("a"); const joined = await join("a");
    await db.update(bossMembersTable).set({ hp: 20 }).where(eq(bossMembersTable.battleId, joined.battleId));
    const operation = id();
    await db.insert(transactionsTable).values({ guildId: guild, userId: "a", amount: 0,
      reason: "synthetic collision", sessionKey: `boss-action:${operation}` });
    await expect(heal("a", 1, operation)).rejects.toThrow();
    const player = (await getBossBattleBundle(joined.battleId))!.members[0]!;
    expect(player.hp).toBe(20); expect(player.effects.healReadyAt).toBeUndefined();
    expect(await balance("a")).toBe(1000);
  });
  it("supports unlimited free attacks with zero attack cooldown but stops at the event deadline", async () => {
    await host({ soloHp: 10000, attackCooldownSeconds: 0, counterEvery: 100 });
    await prepare("a"); await join("a"); await wallet("a", 0);
    for (let i = 0; i < 10; i++) expect((await attack("a", 1)).paid).toBe(0);
    expect(await balance("a")).toBe(0);
    await expect(attack("a", 1000)).rejects.toThrow();
  });

  it("allows free attacks without prices but disables unconfigured healing", async () => {
    await host({}, false); await prepare("a");
    expect(await getBossFees(guild)).toEqual({ attackCost: 0, healCost: null });
    await expect(configureBossFees(guild, { attackCost: 10 })).rejects.toThrow("無料");
    await expect(configureBossFees(guild, { healCost: 0 })).rejects.toThrow("1以上");
    const joined = await join("a");
    const result = await attack("a");
    await expect(performBossAction(id(), guild, "a", "heal", { now: at(2) })).rejects.toThrow("未設定");
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
  it("damages once without charging for duplicate attack delivery", async () => {
    await host(); await prepare("a"); const joined = await join("a");
    const operation = id();
    const results = await Promise.all([attack("a", 1, operation), attack("a", 1, operation)]);
    expect(results.filter(r => r.repeated)).toHaveLength(1);
    expect(await balance("a")).toBe(1000);
    expect((await getBossBattleBundle(joined.battleId))?.battle.currentHp).toBe(84);
    const ledger = await db.select().from(transactionsTable).where(eq(transactionsTable.sessionKey, `boss-action:${operation}`));
    expect(ledger).toHaveLength(1);
  });
  it("allows attacks with insufficient balance and rejects attack cooldown without damage", async () => {
    await host(); await prepare("a"); const joined = await join("a");
    await wallet("a", 9);
    await attack("a");
    expect((await getBossBattleBundle(joined.battleId))?.battle.currentHp).toBe(84);
    await expect(attack("a", 1)).rejects.toThrow("お待ち");
    expect(await balance("a")).toBe(9);
  });
  it("charges healing only when effective and applies boss counters on paid actions", async () => {
    await host({ counterEvery: 1 }); await prepare("a"); await join("a");
    await expect(performBossAction(id(), guild, "a", "heal", { now })).rejects.toThrow("満タン");
    expect(await balance("a")).toBe(1000);
    const hit = await attack("a");
    expect(hit.userHp).toBeLessThan(100);
    const healed = await performBossAction(id(), guild, "a", "heal", { now: at(3), roll: () => 0.5 });
    expect(healed.healed).toBeGreaterThan(0);
    expect(await balance("a")).toBe(980);
  });
  it("atomically splits the reward with exact remainder and never pays twice", async () => {
    await host({ partyHp: 1 }); await prepare("a"); await prepare("b");
    const joined = await join("a", "party"); await join("b", "party");
    await advanceBossGuild(guild, at(11));
    const operation = id();
    const result = await attack("a", 12, operation);
    expect(result.state).toBe("won");
    expect(await balance("a")).toBe(1051);
    expect(await balance("b")).toBe(1050);
    const repeat = await attack("a", 13, operation);
    expect(repeat.repeated).toBe(true);
    expect(await balance("a")).toBe(1051);
    expect((await getBossBattleBundle(joined.battleId))?.battle.rewards.reduce((sum, r) => sum + r.amount, 0)).toBe(101);
    const rewardLedger = await db.select().from(transactionsTable).where(eq(transactionsTable.guildId, guild));
    expect(rewardLedger.filter(t => t.sessionKey?.startsWith("boss-reward:"))).toHaveLength(2);
  });
  it("doubles total reward, not each party member's share", async () => {
    await host({ partyHp: 1, special: "double_reward" }); await prepare("a"); await prepare("b");
    await join("a", "party"); await join("b", "party"); await advanceBossGuild(guild, at(11));
    await attack("a", 12);
    expect(await balance("a")).toBe(1101);
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
    expect(await balance("a")).toBe(1051);
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
    expect(await balance("a")).toBe(1000);
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
    expect(await balance("a")).toBe(1000);
    expect(await balance("b")).toBe(1000);
  });
  it("requires reconfirmation on heal fee changes, then keeps accepted fees fixed", async () => {
    await host(); await prepare("a");
    const quote = await createBossJoinRequest(id(), guild, "a", "solo", now);
    await configureBossFees(guild, { healCost: 100 });
    await expect(confirmBossJoin(quote.request.id, guild, "a", "a", [], now)).rejects.toThrow("料金");
    await join("a");
    await configureBossFees(guild, { healCost: 999 });
    expect((await attack("a")).paid).toBe(0);
    await attack("a", 2);
    const healed = await performBossAction(id(), guild, "a", "heal", { now: at(3), roll: () => 0.5 });
    expect(healed.paid).toBe(100);
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
    expect(await balance("a")).toBe(1101);
    expect((await getBossBattleBundle(joined.battleId))?.battle.noticeState).toBe("won");
  });
  it("keeps guild data isolated and rejects cross-guild replay", async () => {
    await host(); await prepare("a"); await join("a");
    const operation = id(); await attack("a", 1, operation);
    const other = `boss-test-${id()}`; guilds.push(other);
    await expect(performBossAction(operation, other, "a", "attack", { now: at(2) })).rejects.toThrow("識別");
    expect(await getBossFees(other)).toEqual({ attackCost: 0, healCost: null });
    expect(await balance("a")).toBe(1000);
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
    expect((await balance("a"))! + (await balance("b"))!).toBe(2101);
    const ledger = await db.select().from(transactionsTable).where(eq(transactionsTable.guildId, guild));
    expect(ledger.filter(t => t.sessionKey?.startsWith("boss-reward:"))).toHaveLength(2);
    expect(ledger.filter(t => t.sessionKey?.startsWith("boss-action:"))).toHaveLength(1);
  });
});
