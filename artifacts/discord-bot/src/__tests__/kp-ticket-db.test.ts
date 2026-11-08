import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  advanceKpTicketSession, configureKpTicket, createKpTicketSession, createAdditionalKpTicketSession, db, deliverKpTicketLog,
  ensureKpTicketSchema, getKpTicketSession, kpTicketPanelsTable, kpTicketSessionsTable, kpTicketSettingsTable,
  inventoryItemsTable, quoteKpTicket, settleKpTicket, shopItemsTable, transactionsTable, walletsTable, listPaidKpTicketOrders,
  type KpTicketSelection, type KpTicketSession,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";

// Explicit opt-in: creates only synthetic rows and removes them after the suite.
describe.skipIf(process.env.RUN_KP_TICKET_DB_TESTS !== "1")("KP ticket real database settlement", () => {
  const guild = `kp-test-${randomUUID()}`, user = "test-buyer", channel = "test-ticket";
  let product: typeof shopItemsTable.$inferSelect;
  const baseSelection = (): KpTicketSelection => ({
    castId: "test-cast", vip: false, extension: false, quantity: 2, itemId: product.id,
  });
  beforeAll(async () => {
    await ensureKpTicketSchema();
    await configureKpTicket(guild, { castRoleIds: ["black", "white"], vipPrice: 500, extensionPrice: 200 });
    [product] = await db.insert(shopItemsTable).values({ guildId: guild, name: "テストドリンク", price: 100, category: "kp" }).returning();
  });
  afterAll(async () => {
    await db.delete(transactionsTable).where(eq(transactionsTable.guildId, guild));
    await db.delete(inventoryItemsTable).where(eq(inventoryItemsTable.guildId, guild));
    await db.delete(kpTicketSessionsTable).where(eq(kpTicketSessionsTable.guildId, guild));
    await db.delete(kpTicketPanelsTable).where(eq(kpTicketPanelsTable.guildId, guild));
    await db.delete(kpTicketSettingsTable).where(eq(kpTicketSettingsTable.guildId, guild));
    await db.delete(walletsTable).where(eq(walletsTable.guildId, guild));
    await db.delete(shopItemsTable).where(eq(shopItemsTable.guildId, guild));
  });
  async function wallet(balance: number) {
    await db.insert(walletsTable).values({ guildId: guild, userId: user, balance })
      .onConflictDoUpdate({ target: [walletsTable.guildId, walletsTable.userId], set: { balance } });
  }
  async function balance() {
    const [w] = await db.select().from(walletsTable).where(and(eq(walletsTable.guildId, guild), eq(walletsTable.userId, user)));
    return w?.balance;
  }
  async function ready() {
    const session = await createKpTicketSession(randomUUID(), guild, channel, user);
    const selection = baseSelection();
    selection.quote = quoteKpTicket(product, { vipPrice: 500, extensionPrice: 200 }, selection);
    return advanceKpTicketSession(session, "confirm", selection);
  }
  const settle = (session: KpTicketSession) => settleKpTicket(session.id, session.version, user, guild, channel, ["black", "white"]);

  it("inherits only this buyer's paid cast in this ticket and keeps it locked through payment", async () => {
    await wallet(5000);
    await settle(await ready());
    const order = await createAdditionalKpTicketSession(randomUUID(), guild, channel, user);
    expect(order.phase).toBe("drink");
    expect(order.selection).toEqual({ castId: "test-cast", fixedCastId: "test-cast", vip: false, extension: false });
    await expect(createAdditionalKpTicketSession(randomUUID(), guild, channel, "other")).rejects.toThrow("支払い済み");
    await expect(createAdditionalKpTicketSession(randomUUID(), guild, "other", user)).rejects.toThrow("支払い済み");
    await expect(createAdditionalKpTicketSession(randomUUID(), `${guild}-other`, channel, user)).rejects.toThrow("支払い済み");
    await expect(advanceKpTicketSession(order, "cast", order.selection)).rejects.toThrow("変更できません");
    await expect(advanceKpTicketSession(order, "vip", {})).rejects.toThrow("変更できません");
    const selection = { ...order.selection, itemId: product.id, quantity: 2 };
    const quote = quoteKpTicket(product, { vipPrice: 500, extensionPrice: 200 }, selection);
    const confirm = await advanceKpTicketSession(order, "confirm", { ...selection, quote });
    const [beforeInventory] = await db.select().from(inventoryItemsTable).where(eq(inventoryItemsTable.guildId, guild));
    const results = await Promise.all([settle(confirm), settle(confirm)]);
    expect(results.map(result => result.status).sort()).toEqual(["already", "paid"]);
    expect(await balance()).toBe(4600);
    const [afterInventory] = await db.select().from(inventoryItemsTable).where(eq(inventoryItemsTable.guildId, guild));
    expect(afterInventory!.quantity).toBe(beforeInventory!.quantity + 2);
    expect((await listPaidKpTicketOrders(guild, channel)).some(paid => paid.id === order.id && paid.selection.quote?.total === 200)).toBe(true);
    const ledger = await db.select().from(transactionsTable).where(eq(transactionsTable.sessionKey, `kp-ticket:${order.id}`));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.amount).toBe(-200);
  });

  it("summarizes only paid orders in the exact guild and ticket without changing balances", async () => {
    const ticket = `statement-${randomUUID()}`;
    const quote = quoteKpTicket(product, { vipPrice: 500, extensionPrice: 200 }, baseSelection());
    const rows = [
      { guildId: guild, channelId: ticket, phase: "paid" as const },
      { guildId: guild, channelId: ticket, phase: "paid" as const },
      { guildId: guild, channelId: ticket, phase: "confirm" as const },
      { guildId: guild, channelId: ticket, phase: "cancelled" as const },
      { guildId: guild, channelId: `${ticket}-other`, phase: "paid" as const },
      { guildId: `${guild}-other`, channelId: ticket, phase: "paid" as const },
    ].map(row => ({ ...row, id: randomUUID(), userId: user, expiresAt: new Date(0),
      selection: { ...baseSelection(), quote }, paidAt: row.phase === "paid" ? new Date() : null }));
    try {
      await db.insert(kpTicketSessionsTable).values(rows);
      await wallet(4321);
      const orders = await listPaidKpTicketOrders(guild, ticket);
      expect(orders.map(o => o.id).sort()).toEqual(rows.slice(0, 2).map(o => o.id).sort());
      expect(await listPaidKpTicketOrders(guild, ticket)).toHaveLength(2);
      const allOrders = await listPaidKpTicketOrders(guild);
      expect(allOrders.every(order => order.guildId === guild && order.phase === "paid")).toBe(true);
      expect(allOrders.filter(order => rows.some(row => row.id === order.id)).map(order => order.id).sort())
        .toEqual([rows[0]!.id, rows[1]!.id, rows[4]!.id].sort());
      expect(await balance()).toBe(4321);
    } finally {
      await db.delete(kpTicketSessionsTable).where(eq(kpTicketSessionsTable.guildId, `${guild}-other`));
    }
  });

  it("includes deleted-ticket records by paid time in [18:00, next 10:00), never by creation time", async () => {
    const queryGuild = `${guild}-period`;
    const period = { start: new Date("2026-11-08T09:00:00Z"), end: new Date("2026-11-09T01:00:00Z") };
    const times = [
      "2026-11-08T08:59:59.999Z", // Before opening.
      "2026-11-08T09:00:00Z", // Opening included.
      "2026-11-08T15:00:00Z", // Midnight JST.
      "2026-11-09T00:59:59.999Z", // Immediately before closing.
      "2026-11-09T01:00:00Z", // Closing excluded.
      "2026-11-09T08:59:59Z", // Closed hours.
    ];
    const selection = baseSelection();
    selection.quote = quoteKpTicket(product, { vipPrice: null, extensionPrice: null }, selection);
    const rows = times.map(time => ({
      id: randomUUID(), guildId: queryGuild, userId: user, channelId: `deleted-${randomUUID()}`,
      phase: "paid" as const, paidAt: new Date(time), selection,
      createdAt: new Date("2026-10-01T00:00:00Z"), expiresAt: new Date(0),
    }));
    const extra = [
      { ...rows[1]!, id: randomUUID(), phase: "cancelled" as const },
      { ...rows[1]!, id: randomUUID(), phase: "confirm" as const },
      { ...rows[1]!, id: randomUUID(), paidAt: null },
      { ...rows[1]!, id: randomUUID(), guildId: `${guild}-other` },
    ];
    try {
      await db.insert(kpTicketSessionsTable).values([...rows, ...extra]);
      await wallet(4321);
      const result = await listPaidKpTicketOrders(queryGuild, undefined, period);
      expect(result.map(row => row.id).sort()).toEqual(rows.slice(1, 4).map(row => row.id).sort());
      expect(result.reduce((sum, row) => sum + row.selection.quote!.total, 0)).toBe(600);
      expect(await balance()).toBe(4321);
      expect(await listPaidKpTicketOrders(queryGuild, rows[2]!.channelId, period)).toHaveLength(1);
      expect(await listPaidKpTicketOrders(queryGuild, undefined, {
        start: new Date("2025-01-01T09:00:00Z"), end: new Date("2025-01-02T01:00:00Z"),
      })).toHaveLength(0);
      await expect(listPaidKpTicketOrders(queryGuild, undefined, { start: period.end, end: period.start })).rejects.toThrow("集計期間");
    } finally {
      await db.delete(kpTicketSessionsTable).where(eq(kpTicketSessionsTable.guildId, queryGuild));
      await db.delete(kpTicketSessionsTable).where(eq(kpTicketSessionsTable.guildId, `${guild}-other`));
    }
  });

  it("serializes duplicate confirmation: one debit, one ledger row, one inventory grant", async () => {
    await wallet(5000);
    const [before] = await db.select().from(inventoryItemsTable).where(and(
      eq(inventoryItemsTable.guildId, guild), eq(inventoryItemsTable.shopItemId, product.id),
    ));
    const session = await ready();
    const outcomes = await Promise.all([settle(session), settle(session)]);
    expect(outcomes.map(r => r.status).sort()).toEqual(["already", "paid"]);
    expect(await balance()).toBe(4800);
    const ledger = await db.select().from(transactionsTable).where(eq(transactionsTable.sessionKey, `kp-ticket:${session.id}`));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.amount).toBe(-200);
    const [inventory] = await db.select().from(inventoryItemsTable).where(and(eq(inventoryItemsTable.guildId, guild), eq(inventoryItemsTable.shopItemId, product.id)));
    expect(inventory!.quantity).toBe((before?.quantity ?? 0) + 2);
  });
  it("does not overspend across two different orders sharing a wallet", async () => {
    await wallet(300);
    const a = await ready(), b = await ready();
    const results = await Promise.allSettled([settle(a), settle(b)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    expect(await balance()).toBe(100);
  });
  it("leaves the order unpaid on insufficient balance and permits retry after funding", async () => {
    await wallet(0);
    const session = await ready();
    await expect(settle(session)).rejects.toThrow("残高が不足");
    expect(await balance()).toBe(0);
    expect((await getKpTicketSession(session.id))!.phase).toBe("confirm");
    const ledger = await db.select().from(transactionsTable).where(eq(transactionsTable.sessionKey, `kp-ticket:${session.id}`));
    expect(ledger).toHaveLength(0);
    await wallet(300);
    expect((await settle(session)).status).toBe("paid");
    expect(await balance()).toBe(100);
  });
  it("requires reconfirmation when a drink price changes", async () => {
    await wallet(5000);
    const session = await ready();
    await db.update(shopItemsTable).set({ price: 150 }).where(eq(shopItemsTable.id, product.id));
    const changed = await settle(session);
    expect(changed.status).toBe("changed");
    expect(changed.session.selection.quote!.total).toBe(300);
    expect(await balance()).toBe(5000);
    await expect(settle(session)).rejects.toThrow("変更");
    expect((await settle(changed.session)).status).toBe("paid");
    expect(await balance()).toBe(4700);
    await db.update(shopItemsTable).set({ price: 100 }).where(eq(shopItemsTable.id, product.id));
  });
  it("rejects old unpaid VIP orders without debiting money", async () => {
    await wallet(5000);
    const session = await ready();
    await db.update(kpTicketSessionsTable).set({ selection: { ...session.selection, vip: true } })
      .where(eq(kpTicketSessionsTable.id, session.id));
    await expect(settle(session)).rejects.toThrow("受付は終了");
    expect(await balance()).toBe(5000);
  });
  it("rejects another owner, guild, channel, changed roles, cancelled and expired sessions", async () => {
    await wallet(5000);
    const session = await ready();
    await expect(settleKpTicket(session.id, session.version, "other", guild, channel, ["black", "white"])).rejects.toThrow("操作できません");
    await expect(settleKpTicket(session.id, session.version, user, "other", channel, ["black", "white"])).rejects.toThrow("操作できません");
    await expect(settleKpTicket(session.id, session.version, user, guild, "other", ["black", "white"])).rejects.toThrow("操作できません");
    await expect(settleKpTicket(session.id, session.version, user, guild, channel, ["other"])).rejects.toThrow("ロールが変更");
    const cancelled = await advanceKpTicketSession(session, "cancelled", session.selection);
    await expect(settle(cancelled)).rejects.toThrow();
    const expired = await ready();
    await db.update(kpTicketSessionsTable).set({ expiresAt: new Date(0) }).where(eq(kpTicketSessionsTable.id, expired.id));
    await expect(settle(expired)).rejects.toThrow("期限切れ");
    expect(await balance()).toBe(5000);
  });
  it("keeps a failed log pending; serializes retries without charging again", async () => {
    await wallet(5000);
    const { session } = await settle(await ready());
    await expect(deliverKpTicketLog(session.id, async () => { throw new Error("Discord unavailable"); })).rejects.toThrow();
    expect((await getKpTicketSession(session.id))!.logMessageId).toBeNull();
    let sends = 0;
    const send = async () => { sends++; return "test-log"; };
    expect(await Promise.all([deliverKpTicketLog(session.id, send), deliverKpTicketLog(session.id, send)]))
      .toEqual(["test-log", "test-log"]);
    expect(sends).toBe(1);
    expect((await settle(session)).status).toBe("already");
    expect(await balance()).toBe(4800);
  });
});
