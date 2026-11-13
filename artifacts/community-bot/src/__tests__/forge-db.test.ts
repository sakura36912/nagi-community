import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  db, ensureForgeSchema, forgeWeaponsTable, forgeUpgradeSettingsTable, forgeUpgradeRequestsTable, forgeActionsTable,
  walletsTable, transactionsTable, selectForgeWeapon, getForgeWeapon, getForgeSetting,
  createForgeUpgradeRequest, settleForgeUpgrade, cancelForgeUpgrade, adminForgeWeapon, adminSetForgeLevel,
  configureForgeSetting, resetForgeSettings, listForgeSettings,
} from "@workspace/db";

describe.skipIf(process.env.RUN_FORGE_DB_TESTS !== "1")("forge atomic database operations", () => {
  const guild = `forge-test-${randomUUID()}`;
  const otherGuild = `${guild}-other`;
  const id = () => randomUUID();
  const freshUser = () => `forge-user-${id()}`;
  beforeAll(async () => { await ensureForgeSchema(); });
  afterAll(async () => {
    for (const guildId of [guild, otherGuild]) {
      for (const table of [forgeUpgradeRequestsTable, forgeActionsTable, forgeUpgradeSettingsTable,
        forgeWeaponsTable, transactionsTable, walletsTable]) await db.delete(table).where(eq(table.guildId, guildId));
    }
  });
  async function wallet(user: string, balance: number, guildId = guild) {
    await db.insert(walletsTable).values({ guildId, userId: user, balance })
      .onConflictDoUpdate({ target: [walletsTable.guildId, walletsTable.userId], set: { balance } });
  }
  async function balance(user: string, guildId = guild) {
    const [row] = await db.select().from(walletsTable).where(and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, user)));
    return row?.balance;
  }
  async function ready(user: string, amount = 10000) {
    await selectForgeWeapon(id(), guild, user, "greatsword");
    await wallet(user, amount);
    return createForgeUpgradeRequest(id(), guild, user);
  }
  it("enforces one weapon per guild/user even under concurrent selection", async () => {
    const user = freshUser();
    const results = await Promise.allSettled([
      selectForgeWeapon(id(), guild, user, "bow"), selectForgeWeapon(id(), guild, user, "staff"),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    await selectForgeWeapon(id(), otherGuild, user, "spear");
    expect((await getForgeWeapon(otherGuild, user))?.weaponType).toBe("spear");
  });
  it("charges and advances exactly once for concurrent duplicate confirmations", async () => {
    const user = freshUser(), quote = await ready(user);
    const results = await Promise.all([
      settleForgeUpgrade(quote.id, guild, user, () => 0),
      settleForgeUpgrade(quote.id, guild, user, () => 0),
    ]);
    expect(results.map(r => r.repeated).sort()).toEqual([false, true]);
    expect(await balance(user)).toBe(9000);
    expect((await getForgeWeapon(guild, user))?.weaponLevel).toBe(2);
    const ledger = await db.select().from(transactionsTable).where(eq(transactionsTable.sessionKey, `forge:${quote.id}`));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.amount).toBe(-1000);
  });
  it("rejects a stale second quote rather than spending twice", async () => {
    const user = freshUser(), first = await ready(user);
    const second = await createForgeUpgradeRequest(id(), guild, user);
    const results = await Promise.allSettled([
      settleForgeUpgrade(first.id, guild, user, () => 0),
      settleForgeUpgrade(second.id, guild, user, () => 0),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await balance(user)).toBe(9000);
  });
  it("does not change money or weapon when balance is insufficient; permits retry after funding", async () => {
    const user = freshUser(), quote = await ready(user, 999);
    const before = await getForgeWeapon(guild, user);
    await expect(settleForgeUpgrade(quote.id, guild, user)).rejects.toThrow("残高");
    expect(await balance(user)).toBe(999);
    expect(await getForgeWeapon(guild, user)).toEqual(before);
    await wallet(user, 1000);
    await settleForgeUpgrade(quote.id, guild, user, () => 0);
    expect(await balance(user)).toBe(0);
  });
  it("charges on failed upgrades without decreasing level, attack or defense", async () => {
    const user = freshUser();
    await ready(user);
    await db.update(forgeWeaponsTable).set({ weaponLevel: 2 })
      .where(and(eq(forgeWeaponsTable.guildId, guild), eq(forgeWeaponsTable.userId, user)));
    const quote = await createForgeUpgradeRequest(id(), guild, user);
    const before = await getForgeWeapon(guild, user);
    const result = await settleForgeUpgrade(quote.id, guild, user, () => 0.99);
    const after = await getForgeWeapon(guild, user);
    expect(result.success).toBe(false);
    expect(await balance(user)).toBe(7000);
    expect([after?.weaponLevel, after?.attack, after?.defense]).toEqual([before?.weaponLevel, before?.attack, before?.defense]);
  });
  it("rejects cross-user and cross-guild confirms without charging", async () => {
    const user = freshUser(), quote = await ready(user);
    await expect(settleForgeUpgrade(quote.id, guild, freshUser())).rejects.toThrow();
    await expect(settleForgeUpgrade(quote.id, otherGuild, user)).rejects.toThrow();
    await expect(cancelForgeUpgrade(quote.id, guild, freshUser())).rejects.toThrow();
    expect(await balance(user)).toBe(10000);
  });
  it("cancelled and expired requests do not charge", async () => {
    const user = freshUser(), quote = await ready(user);
    await cancelForgeUpgrade(quote.id, guild, user);
    await expect(settleForgeUpgrade(quote.id, guild, user)).rejects.toThrow();
    const expired = await createForgeUpgradeRequest(id(), guild, user);
    await db.update(forgeUpgradeRequestsTable).set({ expiresAt: new Date(0) }).where(eq(forgeUpgradeRequestsTable.id, expired.id));
    await expect(settleForgeUpgrade(expired.id, guild, user)).rejects.toThrow();
    expect(await balance(user)).toBe(10000);
  });
  it("admin change keeps level; reset enables reselection and invalidates old confirms", async () => {
    const user = freshUser(), quote = await ready(user);
    await adminForgeWeapon(id(), guild, user, "admin", "staff");
    expect((await getForgeWeapon(guild, user))?.weaponLevel).toBe(1);
    await expect(settleForgeUpgrade(quote.id, guild, user)).rejects.toThrow();
    const second = await createForgeUpgradeRequest(id(), guild, user);
    await adminForgeWeapon(id(), guild, user, "admin", null);
    expect(await getForgeWeapon(guild, user)).toBeUndefined();
    await selectForgeWeapon(id(), guild, user, "greatsword");
    await expect(settleForgeUpgrade(second.id, guild, user)).rejects.toThrow();
    expect(await balance(user)).toBe(10000);
  });
  it("admin level setting recalculates stats, preserves balance, and invalidates pending upgrades", async () => {
    const user = freshUser(), quote = await ready(user);
    const result = await adminSetForgeLevel(id(), guild, user, "admin", 4);
    const weapon = await getForgeWeapon(guild, user);
    const [request] = await db.select().from(forgeUpgradeRequestsTable).where(eq(forgeUpgradeRequestsTable.id, quote.id));
    expect(result).toMatchObject({ action: "set-level", weaponType: "greatsword", level: 4 });
    expect(weapon).toMatchObject({ weaponLevel: 4, attack: 28, defense: 16 });
    expect(await balance(user)).toBe(10000);
    expect(request?.state).toBe("cancelled");
    await expect(settleForgeUpgrade(quote.id, guild, user)).rejects.toThrow();
    await expect(adminSetForgeLevel(id(), guild, user, "admin", 0)).rejects.toThrow();
  });
  it("rolls back weapon and debit if ledger insertion fails", async () => {
    const user = freshUser(), quote = await ready(user);
    await db.insert(transactionsTable).values({ guildId: guild, userId: user, amount: 0, reason: "synthetic collision", sessionKey: `forge:${quote.id}` });
    const before = await getForgeWeapon(guild, user);
    await expect(settleForgeUpgrade(quote.id, guild, user, () => 0)).rejects.toThrow();
    expect(await balance(user)).toBe(10000);
    expect(await getForgeWeapon(guild, user)).toEqual(before);
    const [request] = await db.select().from(forgeUpgradeRequestsTable).where(eq(forgeUpgradeRequestsTable.id, quote.id));
    expect(request?.state).toBe("pending");
  });
  it("supports zero fees, independent guild settings, and reset of each setting field", async () => {
    await configureForgeSetting(id(), guild, "admin", 8, { cost: 0 });
    await configureForgeSetting(id(), guild, "admin", 8, { successRate: 80 });
    expect(await getForgeSetting(guild, 8)).toEqual({ level: 8, cost: 0, successRate: 80 });
    expect((await getForgeSetting(otherGuild, 8)).cost).toBeNull();
    await resetForgeSettings(id(), guild, "admin", "cost");
    expect(await getForgeSetting(guild, 8)).toEqual({ level: 8, cost: null, successRate: 80 });
    await resetForgeSettings(id(), guild, "admin", "successRate");
    expect((await getForgeSetting(guild, 8)).successRate).toBe(65);
    expect((await listForgeSettings(guild)).map(s => s.level)).toEqual([1, 2, 3, 8]);
  });
  it("requires reconfirmation when price or chance changes", async () => {
    const user = freshUser(), quote = await ready(user);
    await configureForgeSetting(id(), guild, "admin", 1, { cost: 2000 });
    await expect(settleForgeUpgrade(quote.id, guild, user)).rejects.toThrow("変更");
    expect(await balance(user)).toBe(10000);
    const next = await createForgeUpgradeRequest(id(), guild, user);
    await configureForgeSetting(id(), guild, "admin", 1, { successRate: 30 });
    await expect(settleForgeUpgrade(next.id, guild, user)).rejects.toThrow("変更");
    expect(await balance(user)).toBe(10000);
    await resetForgeSettings(id(), guild, "admin", "cost");
    await resetForgeSettings(id(), guild, "admin", "successRate");
  });
  it("blocks unset fees and rejects invalid configuration", async () => {
    const user = freshUser();
    await selectForgeWeapon(id(), guild, user, "bow");
    await db.update(forgeWeaponsTable).set({ weaponLevel: 4 })
      .where(and(eq(forgeWeaponsTable.guildId, guild), eq(forgeWeaponsTable.userId, user)));
    await expect(createForgeUpgradeRequest(id(), guild, user)).rejects.toThrow("未設定");
    await expect(configureForgeSetting(id(), guild, "admin", 4, { cost: -1 })).rejects.toThrow();
    await expect(configureForgeSetting(id(), guild, "admin", 4, { successRate: 29 })).rejects.toThrow();
    await configureForgeSetting(id(), guild, "admin", 4, { cost: 0 });
    const quote = await createForgeUpgradeRequest(id(), guild, user);
    await settleForgeUpgrade(quote.id, guild, user, () => 0);
    expect(await balance(user)).toBe(0);
  });
});
