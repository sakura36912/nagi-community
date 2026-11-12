import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  db, walletsTable, transactionsTable, petAccountsTable, petActionsTable, petSettingsTable,
  communityVcPrivacyTable, communityVcPrivacyGlobalTable,
  getPetAccount, getPetSettings, configurePet, grantPetReward, hatchPet, buyPetItem, carePet, removePet,
  awardPetMessage, observePetVoice, cancelPetPurchase, type PetSettingKey,
  createPetTreatment, getPetTreatment, settlePetTreatment, petTreatmentRequestsTable,
} from "@workspace/db";

describe.skipIf(process.env.RUN_PET_DB_TESTS !== "1")("pet durable atomic flows", () => {
  const guilds: string[] = [];
  const globalUsers: string[] = [];
  let guild: string;
  const id = () => randomUUID();
  const now = Date.parse("2026-11-12T12:00:00Z");
  beforeEach(() => { guild = `pet-test-${id()}`; guilds.push(guild); });
  afterAll(async () => {
    for (const guildId of guilds) for (const table of [petTreatmentRequestsTable, petActionsTable, petAccountsTable, petSettingsTable,
      transactionsTable, walletsTable, communityVcPrivacyTable]) await db.delete(table).where(eq(table.guildId, guildId));
    for (const user of globalUsers) await db.delete(communityVcPrivacyGlobalTable).where(eq(communityVcPrivacyGlobalTable.userId, user));
  });
  const set = async (key: PetSettingKey, value: number) => configurePet(id(), guild, "admin", { key, value });
  async function setup(user = "user") {
    await grantPetReward(id(), guild, user, "admin", "rare", 3);
    await hatchPet(id(), guild, user, "rare", now);
  }
  async function growth() {
    await set("xp_base", 10); await set("xp_multiplier", 1);
  }
  async function wallet(user = "user", balance = 1000) {
    await db.insert(walletsTable).values({ guildId: guild, userId: user, balance });
  }
  async function balance() {
    const [w] = await db.select().from(walletsTable).where(and(eq(walletsTable.guildId, guild), eq(walletsTable.userId, "user")));
    return w?.balance;
  }
  it("persists inventory and a level-one individual across independent reads", async () => {
    await setup();
    const a = await getPetAccount(guild, "user", now);
    const b = await getPetAccount(guild, "user", now);
    expect(a).toEqual(b);
    expect(a.eggs.rare).toBe(2);
    expect(a.pet).toMatchObject({ level: 1, xp: 0, hunger: 100, bond: 0, rarity: "rare", bornAt: now });
    expect(a.pet?.id).toBeTruthy();
  });
  it("allows only one concurrent hatch and consumes exactly one egg", async () => {
    await grantPetReward(id(), guild, "user", "admin", "rare", 2);
    const results = await Promise.allSettled([hatchPet(id(), guild, "user", "rare", now), hatchPet(id(), guild, "user", "rare", now)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((await getPetAccount(guild, "user", now)).eggs.rare).toBe(1);
  });
  it("does not hatch missing eggs or an unconfigured normal species", async () => {
    await expect(hatchPet(id(), guild, "user", "rare")).rejects.toThrow("所持");
    await grantPetReward(id(), guild, "user", "admin", "normal", 1);
    await expect(hatchPet(id(), guild, "user", "normal")).rejects.toThrow("未登録");
    expect((await getPetAccount(guild, "user")).eggs.normal).toBe(1);
  });
  it("supports configured normal eggs and retains hatch receipts", async () => {
    await configurePet(id(), guild, "admin", { rarity: "normal", species: ["指定ペット"] });
    await grantPetReward(id(), guild, "user", "admin", "normal", 1);
    const operation = id();
    expect(await hatchPet(operation, guild, "user", "normal")).toContain("指定ペット");
    await hatchPet(operation, guild, "user", "normal");
    expect((await getPetAccount(guild, "user")).pet?.species).toBe("指定ペット");
    expect((await getPetAccount(guild, "user")).eggs.normal).toBe(0);
  });
  it("charges once for concurrent retries and writes one wallet ledger entry", async () => {
    await wallet(); await set("rare_price", 100);
    const operation = id();
    await Promise.all([buyPetItem(operation, guild, "user", "rare", 2, 100), buyPetItem(operation, guild, "user", "rare", 2, 100)]);
    expect(await balance()).toBe(800);
    expect((await getPetAccount(guild, "user")).eggs.rare).toBe(2);
    const rows = await db.select().from(transactionsTable).where(eq(transactionsTable.guildId, guild));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe(-200);
  });
  it("leaves both wallet and stock unchanged for stale prices", async () => {
    await wallet(); await set("rare_price", 101);
    await expect(buyPetItem(id(), guild, "user", "rare", 2, 100)).rejects.toThrow("価格が変更");
    expect(await balance()).toBe(1000);
    expect((await getPetAccount(guild, "user")).eggs.rare).toBeUndefined();
  });
  it("refuses missing prices and insufficient balance without any ledger", async () => {
    await wallet("user", 10);
    await expect(buyPetItem(id(), guild, "user", "food", 1, 0)).rejects.toThrow("未設定");
    await set("food_price", 20);
    await expect(buyPetItem(id(), guild, "user", "food", 1, 20)).rejects.toThrow("不足");
    expect(await balance()).toBe(10);
    expect(await db.select().from(transactionsTable).where(eq(transactionsTable.guildId, guild))).toHaveLength(0);
  });
  it("prevents overspending on different concurrent purchases", async () => {
    await wallet("user", 100); await set("food_price", 70);
    const results = await Promise.allSettled([buyPetItem(id(), guild, "user", "food", 1, 70), buyPetItem(id(), guild, "user", "food", 1, 70)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await balance()).toBe(30);
    expect((await getPetAccount(guild, "user")).food).toBe(1);
  });
  it("persists purchase cancellation so late confirmation cannot charge", async () => {
    await wallet(); await set("food_price", 10);
    const operation = id();
    await cancelPetPurchase(operation, guild, "user");
    expect(await buyPetItem(operation, guild, "user", "food", 1, 10)).toContain("キャンセル");
    expect(await balance()).toBe(1000);
    expect((await getPetAccount(guild, "user")).food).toBe(0);
  });
  it("serializes cancellation racing with payment without inconsistent stock", async () => {
    await wallet(); await set("food_price", 10);
    const operation = id();
    await Promise.all([cancelPetPurchase(operation, guild, "user"), buyPetItem(operation, guild, "user", "food", 1, 10)]);
    const a = await getPetAccount(guild, "user");
    expect(await balance()).toBe(1000 - a.food * 10);
    expect(a.food).toBeLessThanOrEqual(1);
  });
  it("enforces persistent daily pet/play limits and JST reset", async () => {
    await setup(); await growth();
    await grantPetReward(id(), guild, "user", "admin", "toy", 3);
    await set("pet_bond", 5); await set("play_bond", 2); await set("play_xp", 1);
    await carePet(id(), guild, "user", "pet", now);
    await expect(carePet(id(), guild, "user", "pet", now + 1)).rejects.toThrow("1日1回");
    for (let n = 0; n < 3; n++) await carePet(id(), guild, "user", "play", now);
    await expect(carePet(id(), guild, "user", "play", now)).rejects.toThrow("1日3回");
    expect((await getPetAccount(guild, "user", now)).pet?.bond).toBe(11);
    expect((await getPetAccount(guild, "user", now)).toys).toBe(0);
    await carePet(id(), guild, "user", "pet", Date.parse("2026-11-12T15:00:00Z"));
    expect((await getPetAccount(guild, "user", Date.parse("2026-11-12T15:00:00Z"))).petsToday).toBe(1);
  });
  it("serializes simultaneous daily pet actions", async () => {
    await setup(); await set("pet_bond", 2);
    const results = await Promise.allSettled([carePet(id(), guild, "user", "pet", now), carePet(id(), guild, "user", "pet", now)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((await getPetAccount(guild, "user", now)).pet?.bond).toBe(2);
  });
  it("does not consume food when any required growth setting is missing", async () => {
    await setup(); await grantPetReward(id(), guild, "user", "admin", "food", 1);
    await set("feed_hunger", 20); await set("feed_bond", 3); await set("feed_xp", 5);
    await expect(carePet(id(), guild, "user", "feed", now)).rejects.toThrow("未設定");
    expect((await getPetAccount(guild, "user", now)).food).toBe(1);
    await growth();
    await carePet(id(), guild, "user", "feed", now);
    const a = await getPetAccount(guild, "user", now);
    expect([a.food, a.pet?.hunger, a.pet?.bond, a.pet?.xp]).toEqual([0, 100, 3, 5]);
  });
  it("deduplicates admin/event rewards by durable reference", async () => {
    const operation = id();
    await grantPetReward(operation, guild, "user", "admin", "mythic", 2);
    await grantPetReward(operation, guild, "user", "admin", "mythic", 2);
    expect((await getPetAccount(guild, "user")).eggs.mythic).toBe(2);
    await expect(grantPetReward(operation, guild, "other", "admin", "mythic", 2)).rejects.toThrow("一致");
  });
  it("requires the exact pet when deleting and keeps egg inventory", async () => {
    await setup();
    const a = await getPetAccount(guild, "user");
    await expect(removePet(id(), guild, "user", "user", "stale")).rejects.toThrow("変更");
    await removePet(id(), guild, "user", "user", a.pet!.id);
    const b = await getPetAccount(guild, "user");
    expect(b.pet).toBeNull(); expect(b.eggs.rare).toBe(2);
    await hatchPet(id(), guild, "user", "rare");
    await expect(removePet(id(), guild, "user", "user", a.pet!.id)).rejects.toThrow("変更");
  });
  it("grants message XP at configured intervals only, without retaining content", async () => {
    await setup(); await growth(); await set("message_xp", 3); await set("message_interval", 60);
    const msg = id();
    await awardPetMessage(msg, guild, "user", now);
    await awardPetMessage(msg, guild, "user", now);
    await awardPetMessage(id(), guild, "user", now + 1000);
    await awardPetMessage(id(), guild, "user", now + 60000);
    expect((await getPetAccount(guild, "user", now + 60000)).pet?.xp).toBe(6);
  });
  it("does not award any XP for unconfigured message/VC gains", async () => {
    await setup();
    await awardPetMessage(id(), guild, "user", now);
    await observePetVoice(guild, "user", "vc", "epoch", now);
    await observePetVoice(guild, "user", "vc", "epoch", now + 60000);
    expect((await getPetAccount(guild, "user", now + 60000)).pet?.xp).toBe(0);
  });
  it("counts observed VC time only; restart and outages are not backfilled", async () => {
    await setup(); await growth(); await set("vc_xp", 3); await set("vc_interval", 60);
    await observePetVoice(guild, "user", "vc", "epoch", now);
    await observePetVoice(guild, "user", "vc", "epoch", now + 60000);
    expect((await getPetAccount(guild, "user", now + 60000)).pet?.xp).toBe(3);
    await observePetVoice(guild, "user", "vc", "restart", now + 120000);
    await observePetVoice(guild, "user", "vc", "restart", now + 600000);
    expect((await getPetAccount(guild, "user", now + 600000)).pet?.xp).toBe(3);
  });
  it("honours guild and global VC opt-outs", async () => {
    await setup(); await growth(); await set("vc_xp", 3); await set("vc_interval", 60);
    await db.insert(communityVcPrivacyTable).values({ guildId: guild, userId: "user", optedOut: true });
    await observePetVoice(guild, "user", "vc", "epoch", now);
    await observePetVoice(guild, "user", "vc", "epoch", now + 60000);
    expect((await getPetAccount(guild, "user", now + 60000)).vc).toBeUndefined();
    const user = `global-pet-${id()}`; globalUsers.push(user);
    await setup(user);
    await db.insert(communityVcPrivacyGlobalTable).values({ userId: user, optedOut: true });
    await observePetVoice(guild, user, "vc", "epoch", now);
    expect((await getPetAccount(guild, user, now)).vc).toBeUndefined();
  });
  it("keeps observed partial VC intervals across moves, leave and restart without counting absence", async () => {
    await setup(); await growth(); await set("vc_xp", 3); await set("vc_interval", 60);
    await observePetVoice(guild, "user", "vc-a", "epoch", now);
    await observePetVoice(guild, "user", "vc-a", "epoch", now + 30000);
    await observePetVoice(guild, "user", null, "epoch", now + 30000);
    await observePetVoice(guild, "user", "vc-b", "restart", now + 3600000);
    await observePetVoice(guild, "user", "vc-b", "restart", now + 3630000);
    const a = await getPetAccount(guild, "user", now + 3630000);
    expect(a.pet?.xp).toBe(3);
    expect(a.vc?.seconds).toBe(0);
  });
  it("configurations are isolated per guild and invalid settings roll back", async () => {
    await set("rare_price", 20);
    await expect(set("level_cap", 101)).rejects.toThrow();
    expect((await getPetSettings(guild)).level_cap).toBeUndefined();
    expect(await getPetSettings(`unused-${id()}`)).toEqual({});
  });
  it("buys toys through the same atomic wallet and inventory path", async () => {
    await wallet(); await set("toy_price", 40);
    const operation = id();
    await buyPetItem(operation, guild, "user", "toy", 3, 40);
    await buyPetItem(operation, guild, "user", "toy", 3, 40);
    expect((await getPetAccount(guild, "user")).toys).toBe(3);
    expect(await balance()).toBe(880);
  });
  it("requires a toy for every play without losing daily allowance on failure", async () => {
    await setup(); await growth(); await set("play_xp", 1); await set("play_bond", 2);
    await expect(carePet(id(), guild, "user", "play", now)).rejects.toThrow("おもちゃ");
    expect((await getPetAccount(guild, "user", now)).playsToday).toBe(0);
    await grantPetReward(id(), guild, "user", "admin", "toy", 1);
    await carePet(id(), guild, "user", "play", now);
    const a = await getPetAccount(guild, "user", now);
    expect([a.toys, a.playsToday]).toEqual([0, 1]);
  });
  it("does not consume a toy for missing growth settings", async () => {
    await setup(); await grantPetReward(id(), guild, "user", "admin", "toy", 1);
    await expect(carePet(id(), guild, "user", "play", now)).rejects.toThrow("未設定");
    expect((await getPetAccount(guild, "user", now)).toys).toBe(1);
  });
  async function clinic() {
    await setup(); await wallet();
    await set("feed_neglect_interval", 60); await set("play_neglect_interval", 120);
    await set("vet_price", 50); await set("vet_hunger", 10);
  }
  it("does not charge when a vet proposes treatment, and binds it to the owner", async () => {
    await clinic();
    const r = await createPetTreatment(id(), guild, "user", "vet", now + 61000);
    expect(await balance()).toBe(1000);
    expect(r).toMatchObject({ price: 50, hunger: 10, state: "pending", vetId: "vet" });
    await expect(getPetTreatment(r.id, guild, "other")).rejects.toThrow("操作できません");
    await expect(settlePetTreatment(r.id, guild, "other", false, now + 62000)).rejects.toThrow("飼い主のみ");
    expect(await balance()).toBe(1000);
  });
  it("charges exactly once and clears weakness only on confirmed veterinary treatment", async () => {
    await clinic();
    const r = await createPetTreatment(id(), guild, "user", "vet", now + 61000);
    await Promise.all([settlePetTreatment(r.id, guild, "user", false, now + 62000),
      settlePetTreatment(r.id, guild, "user", false, now + 62000)]);
    expect(await balance()).toBe(950);
    const a = await getPetAccount(guild, "user", now + 62000);
    expect(a.pet?.weak).toBeUndefined();
    expect(a.pet?.treatedAt).toBe(now + 62000);
    expect((await getPetTreatment(r.id, guild, "user")).state).toBe("paid");
    expect(await db.select().from(transactionsTable).where(eq(transactionsTable.guildId, guild))).toHaveLength(1);
  });
  it("rejects treating healthy pets or missing treatment prices", async () => {
    await setup();
    await expect(createPetTreatment(id(), guild, "user", "vet", now)).rejects.toThrow("未設定");
    await set("vet_price", 1); await set("vet_hunger", 1);
    await expect(createPetTreatment(id(), guild, "user", "vet", now)).rejects.toThrow("弱っていない");
  });
  it("never charges stale, expired or replaced-pet treatment approvals", async () => {
    await clinic();
    const r = await createPetTreatment(id(), guild, "user", "vet", now + 61000);
    await expect(settlePetTreatment(r.id, guild, "user", false, now + 182000)).rejects.toThrow("期限切れ");
    await set("vet_price", 60);
    await expect(settlePetTreatment(r.id, guild, "user", false, now + 62000)).rejects.toThrow("設定が変更");
    await set("vet_price", 50);
    await removePet(id(), guild, "user", "user", r.petId);
    await hatchPet(id(), guild, "user", "rare", now + 62000);
    await expect(settlePetTreatment(r.id, guild, "user", false, now + 63000)).rejects.toThrow("変更");
    expect(await balance()).toBe(1000);
  });
  it("rolls back insufficient-balance treatment and persists cancellation", async () => {
    await clinic(); await set("vet_price", 1001);
    const r = await createPetTreatment(id(), guild, "user", "vet", now + 61000);
    await expect(settlePetTreatment(r.id, guild, "user", false, now + 62000)).rejects.toThrow("不足");
    expect((await getPetAccount(guild, "user", now + 62000)).pet?.weak).toBeTruthy();
    await settlePetTreatment(r.id, guild, "user", true, now + 62000);
    expect(await settlePetTreatment(r.id, guild, "user", false, now + 63000)).toContain("キャンセル");
    expect(await balance()).toBe(1000);
  });
  it("prevents two vets' requests from charging twice for the same weakness", async () => {
    await clinic();
    const r1 = await createPetTreatment(id(), guild, "user", "vet-a", now + 61000);
    const r2 = await createPetTreatment(id(), guild, "user", "vet-b", now + 61000);
    const results = await Promise.allSettled([settlePetTreatment(r1.id, guild, "user", false, now + 62000),
      settlePetTreatment(r2.id, guild, "user", false, now + 62000)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await balance()).toBe(950);
  });
  it("normal feeding cannot replace a vet once weakness has occurred", async () => {
    await clinic(); await growth();
    await set("feed_xp", 1); await set("feed_hunger", 1); await set("feed_bond", 1);
    await grantPetReward(id(), guild, "user", "admin", "food", 1);
    await carePet(id(), guild, "user", "feed", now + 61000);
    const a = await getPetAccount(guild, "user", now + 61000);
    expect(a.pet?.lastFeedAt).toBe(now + 61000);
    expect(a.pet?.weak).toBeTruthy();
  });
});
