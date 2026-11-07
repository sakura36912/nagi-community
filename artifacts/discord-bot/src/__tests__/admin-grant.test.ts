import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, pool, transactionsTable, walletsTable } from "@workspace/db";
import { grantAdminCurrency, MAX_GRANT_AMOUNT } from "../lib/adminGrant";

// Isolated development-only fixtures. Never use a real Discord guild/user.
const guildId = `test-admin-give-${randomUUID()}`;
afterAll(async () => {
  await db.delete(transactionsTable).where(eq(transactionsTable.guildId, guildId));
  await db.delete(walletsTable).where(eq(walletsTable.guildId, guildId));
  await pool.end();
});
async function balance(userId: string) {
  const rows = await db.select().from(walletsTable).where(eq(walletsTable.guildId, guildId));
  return rows.find(w => w.userId === userId)?.balance;
}
async function ledger() {
  return db.select().from(transactionsTable).where(eq(transactionsTable.guildId, guildId));
}
describe("atomic admin currency grants", () => {
  it("creates a wallet and records recipient, actor and amount without debiting the admin", async () => {
    await db.insert(walletsTable).values({ guildId, userId: "admin", balance: 400 });
    expect(await grantAdminCurrency(guildId, "new-user", "admin", 100, "new"))
      .toEqual({ balance: 100, duplicate: false });
    expect(await balance("admin")).toBe(400);
    expect((await ledger()).find(t => t.userId === "new-user")).toMatchObject({
      amount: 100, reason: "admin-give", relatedUserId: "admin",
    });
  });
  it("credits a repeated interaction only once, even concurrently", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      grantAdminCurrency(guildId, "duplicate-user", "admin", 25, "duplicate")));
    expect(results.filter(r => !r.duplicate)).toHaveLength(1);
    expect(await balance("duplicate-user")).toBe(25);
    expect((await ledger()).filter(t => t.userId === "duplicate-user")).toHaveLength(1);
  });
  it("does not lose concurrent independent grants to the same wallet", async () => {
    await Promise.all(Array.from({ length: 5 }, (_, i) =>
      grantAdminCurrency(guildId, "concurrent-user", "admin", 20, `parallel-${i}`)));
    expect(await balance("concurrent-user")).toBe(100);
  });
  it("allows the maximum balance and rolls back the ledger if adding more would overflow", async () => {
    await grantAdminCurrency(guildId, "full-user", "admin", MAX_GRANT_AMOUNT, "full");
    await expect(grantAdminCurrency(guildId, "full-user", "admin", 1, "overflow")).rejects.toThrow("上限");
    expect(await balance("full-user")).toBe(MAX_GRANT_AMOUNT);
    expect((await ledger()).some(t => t.sessionKey?.endsWith(":overflow"))).toBe(false);
    // The failed operation must not leave a reservation which silently blocks a retry.
    await db.update(walletsTable).set({ balance: 0 }).where(and(
      eq(walletsTable.guildId, guildId), eq(walletsTable.userId, "full-user"),
    ));
    expect(await grantAdminCurrency(guildId, "full-user", "admin", 1, "overflow"))
      .toEqual({ balance: 1, duplicate: false });
  });
  it.each([0, -1, 0.5, MAX_GRANT_AMOUNT + 1])("rejects invalid amount %s without writing", async amount => {
    await expect(grantAdminCurrency(guildId, "invalid-user", "admin", amount, "invalid")).rejects.toThrow("整数");
    expect(await balance("invalid-user")).toBeUndefined();
  });
});
