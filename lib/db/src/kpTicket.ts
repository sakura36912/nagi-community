import { and, desc, eq, gt, gte, lt, or, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { db } from "./index";
import { inventoryItemsTable, shopItemsTable, transactionsTable, walletsTable } from "./schema/economy";
import { kpTicketPanelsTable, kpTicketSessionsTable, kpTicketSettingsTable,
  type KpTicketPhase, type KpTicketSelection, type KpTicketSession } from "./schema/kpTicket";
import { KpTicketError, KP_TICKET_MAX_PRICE, quoteKpTicket } from "./kpTicketPricing";

let schemaReady: Promise<void> | undefined;
/** Additive, idempotent migration; never changes existing wallets or shop data. */
export function ensureKpTicketSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('kp-ticket-schema'))`);
      await tx.execute(sql`
        CREATE TABLE IF NOT EXISTS kp_ticket_settings (
          guild_id text PRIMARY KEY, cast_role_ids text[] NOT NULL DEFAULT '{}',
          vip_price integer, extension_price integer
        );
        CREATE TABLE IF NOT EXISTS kp_ticket_panels (
          message_id text PRIMARY KEY, guild_id text NOT NULL, channel_id text NOT NULL
        );
        CREATE TABLE IF NOT EXISTS kp_ticket_sessions (
          id text PRIMARY KEY, guild_id text NOT NULL, channel_id text NOT NULL, user_id text NOT NULL,
          phase text NOT NULL DEFAULT 'cast', version integer NOT NULL DEFAULT 0,
          selection jsonb NOT NULL DEFAULT '{}', expires_at timestamptz NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(), paid_at timestamptz, log_message_id text
        )
      `);
    }).catch(error => { schemaReady = undefined; throw error; });
  }
  return schemaReady;
}

export async function getKpTicketSettings(guildId: string) {
  await ensureKpTicketSchema();
  const [settings] = await db.select().from(kpTicketSettingsTable).where(eq(kpTicketSettingsTable.guildId, guildId));
  return settings;
}

export async function configureKpTicket(guildId: string, patch: {
  castRoleIds?: string[]; vipPrice?: number | null; extensionPrice?: number | null;
}) {
  await ensureKpTicketSchema();
  for (const fee of [patch.vipPrice, patch.extensionPrice]) {
    if (fee !== null && fee !== undefined && (!Number.isInteger(fee) || fee < 0 || fee > KP_TICKET_MAX_PRICE)) {
      throw new KpTicketError("料金は0〜2,147,483,647の整数で指定してください。");
    }
  }
  const [settings] = await db.insert(kpTicketSettingsTable).values({ guildId, ...patch })
    .onConflictDoUpdate({ target: kpTicketSettingsTable.guildId, set: patch }).returning();
  return settings!;
}

export async function registerKpTicketPanel(messageId: string, guildId: string, channelId: string) {
  await ensureKpTicketSchema();
  await db.insert(kpTicketPanelsTable).values({ messageId, guildId, channelId }).onConflictDoNothing();
}

export async function isKpTicketPanel(messageId: string, guildId: string, channelId: string) {
  await ensureKpTicketSchema();
  const [panel] = await db.select().from(kpTicketPanelsTable).where(and(
    eq(kpTicketPanelsTable.messageId, messageId), eq(kpTicketPanelsTable.guildId, guildId), eq(kpTicketPanelsTable.channelId, channelId),
  ));
  return !!panel;
}

export async function createKpTicketSession(id: string, guildId: string, channelId: string, userId: string) {
  const [session] = await db.insert(kpTicketSessionsTable).values({
    id, guildId, channelId, userId, selection: { serviceVersion: 2 },
    expiresAt: new Date(Date.now() + 20 * 60_000),
  }).returning();
  return session!;
}

export async function createAdditionalKpTicketSession(id: string, guildId: string, channelId: string, userId: string) {
  await ensureKpTicketSchema();
  const [previous] = await db.select().from(kpTicketSessionsTable).where(and(
    eq(kpTicketSessionsTable.guildId, guildId), eq(kpTicketSessionsTable.channelId, channelId),
    eq(kpTicketSessionsTable.userId, userId), eq(kpTicketSessionsTable.phase, "paid"),
  )).orderBy(desc(kpTicketSessionsTable.paidAt), desc(kpTicketSessionsTable.id)).limit(1);
  if (!previous?.selection.castId) {
    throw new KpTicketError("このチケットでご自身が支払い済みの注文がありません。先に「注文する」から注文してください。");
  }
  const castId = previous.selection.castId;
  const paid = await listPaidKpTicketOrders(guildId, channelId);
  const vipActive = paid.some(order => order.selection.vip
    && (order.userId === userId || order.selection.guestId === userId));
  const [session] = await db.insert(kpTicketSessionsTable).values({
    id, guildId, channelId, userId, phase: vipActive ? "drink" : "vip",
    selection: { castId, fixedCastId: castId, vip: false, extension: false,
      serviceVersion: 2, baseOrderId: previous.id, vipActive },
    expiresAt: new Date(Date.now() + 20 * 60_000),
  }).returning();
  return session!;
}

export async function getKpTicketSession(id: string) {
  await ensureKpTicketSchema();
  const [session] = await db.select().from(kpTicketSessionsTable).where(eq(kpTicketSessionsTable.id, id));
  return session;
}

/** Read-only settled orders, including expired sessions. Omit channelId for this guild's full statement. */
export async function listPaidKpTicketOrders(guildId: string, channelId?: string, period?: { start: Date; end: Date }) {
  if (period && (!Number.isFinite(period.start.getTime()) || !Number.isFinite(period.end.getTime())
    || period.start.getTime() >= period.end.getTime())) {
    throw new KpTicketError("集計期間が不正です。");
  }
  await ensureKpTicketSchema();
  return db.select().from(kpTicketSessionsTable).where(and(
    eq(kpTicketSessionsTable.guildId, guildId),
    channelId === undefined ? undefined : eq(kpTicketSessionsTable.channelId, channelId),
    eq(kpTicketSessionsTable.phase, "paid"),
    period ? gte(kpTicketSessionsTable.paidAt, period.start) : undefined,
    period ? lt(kpTicketSessionsTable.paidAt, period.end) : undefined,
  )).orderBy(kpTicketSessionsTable.createdAt, kpTicketSessionsTable.id);
}

export async function advanceKpTicketSession(session: KpTicketSession, phase: KpTicketPhase, selection: KpTicketSelection) {
  if (session.selection.fixedCastId && (phase === "cast" || selection.castId !== session.selection.fixedCastId
    || selection.fixedCastId !== session.selection.fixedCastId)) {
    throw new KpTicketError("追加注文の指名キャストは変更できません。");
  }
  if (session.selection.fixedCastId && (selection.baseOrderId !== session.selection.baseOrderId
    || selection.vipActive !== session.selection.vipActive)) {
    throw new KpTicketError("追加注文の利用条件は変更できません。");
  }
  const [next] = await db.update(kpTicketSessionsTable).set({ phase, selection, version: session.version + 1 })
    .where(and(eq(kpTicketSessionsTable.id, session.id), eq(kpTicketSessionsTable.userId, session.userId),
      eq(kpTicketSessionsTable.phase, session.phase), eq(kpTicketSessionsTable.version, session.version),
      gt(kpTicketSessionsTable.expiresAt, new Date()))).returning();
  if (!next) throw new KpTicketError("この操作は既に処理済みか期限切れです。最新の画面から操作してください。");
  return next;
}

export async function settleKpTicket(
  id: string, version: number, userId: string, guildId: string, channelId: string, validatedRoleIds: string[],
): Promise<{ status: "paid" | "already" | "changed"; session: KpTicketSession }> {
  return db.transaction(async tx => {
    // One ticket lock also serializes VIP purchases and extensions from different sessions.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`kp-ticket:${guildId}:${channelId}`}))`);
    const [session] = await tx.select().from(kpTicketSessionsTable)
      .where(eq(kpTicketSessionsTable.id, id)).for("update");
    if (!session || session.userId !== userId || session.guildId !== guildId || session.channelId !== channelId) {
      throw new KpTicketError("この注文は操作できません。");
    }
    if (session.phase === "paid") return { status: "already", session };
    if (session.expiresAt.getTime() <= Date.now() || session.phase !== "confirm" || session.version !== version) {
      throw new KpTicketError("注文が期限切れか、既に変更されています。最新の画面から操作してください。");
    }
    const [settings] = await tx.select().from(kpTicketSettingsTable)
      .where(eq(kpTicketSettingsTable.guildId, guildId)).for("share");
    const [item] = session.selection.itemId === undefined ? [] : await tx.select().from(shopItemsTable)
      .where(and(eq(shopItemsTable.guildId, guildId), eq(shopItemsTable.id, session.selection.itemId))).for("share");
    if (!settings || (session.selection.itemId !== undefined && !item)) {
      throw new KpTicketError("商品または設定が削除されています。最初から選び直してください。");
    }
    if (JSON.stringify([...settings.castRoleIds].sort()) !== JSON.stringify([...validatedRoleIds].sort())) {
      throw new KpTicketError("キャスト対象ロールが変更されました。最初から選び直してください。");
    }
    const s = session.selection;
    if (s.fixedCastId) {
      const [base] = await tx.select().from(kpTicketSessionsTable).where(and(
        eq(kpTicketSessionsTable.id, s.baseOrderId ?? ""),
        eq(kpTicketSessionsTable.guildId, guildId), eq(kpTicketSessionsTable.channelId, channelId),
        eq(kpTicketSessionsTable.userId, userId), eq(kpTicketSessionsTable.phase, "paid"),
      ));
      if (!base || base.selection.castId !== s.castId) throw new KpTicketError("追加注文の元の支払い済み注文を確認できません。");
    }
    if (s.vip || s.extension) {
      const paid = await tx.select().from(kpTicketSessionsTable).where(and(
        eq(kpTicketSessionsTable.guildId, guildId), eq(kpTicketSessionsTable.channelId, channelId),
        eq(kpTicketSessionsTable.phase, "paid"),
      ));
      const customers = [userId, ...(s.vipTier === "shared" ? [s.guestId] : [])];
      if (paid.some(order => order.selection.vip && customers.some(id => id
        && (order.userId === id || order.selection.guestId === id)))) {
        throw new KpTicketError("VIP利用者はVIPの重複購入・延長を行えません。");
      }
      if (s.vip && s.vipTier === "shared" && s.guestId === userId) throw new KpTicketError("同伴者に購入者本人は指定できません。");
    }
    const quote = quoteKpTicket(item ?? null, settings, session.selection);
    if (!isDeepStrictEqual(quote, session.selection.quote)) {
      const [changed] = await tx.update(kpTicketSessionsTable).set({
        selection: { ...session.selection, quote }, version: session.version + 1,
      }).where(eq(kpTicketSessionsTable.id, id)).returning();
      return { status: "changed", session: changed! };
    }
    await tx.insert(walletsTable).values({ guildId, userId, balance: 0 }).onConflictDoNothing();
    const [wallet] = await tx.update(walletsTable).set({
      balance: sql`${walletsTable.balance} - ${quote.total}`,
    }).where(and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId),
      sql`${walletsTable.balance} >= ${quote.total}`)).returning();
    if (!wallet) throw new KpTicketError("残高が不足しています。引き落としは行っていません。");
    if (item) {
      await tx.insert(inventoryItemsTable).values({ guildId, userId, shopItemId: item.id, quantity: quote.quantity })
        .onConflictDoUpdate({ target: [inventoryItemsTable.guildId, inventoryItemsTable.userId, inventoryItemsTable.shopItemId],
          set: { quantity: sql`${inventoryItemsTable.quantity} + ${quote.quantity}` } });
    }
    await tx.insert(transactionsTable).values({
      guildId, userId, amount: -quote.total, relatedUserId: session.selection.castId,
      sessionKey: `kp-ticket:${id}`,
      reason: `kp-ticket:${quote.itemName} x${quote.quantity}; VIP=${session.selection.vip}; 延長=${session.selection.extension}; ticket=${channelId}`,
    });
    const [paid] = await tx.update(kpTicketSessionsTable).set({ phase: "paid", paidAt: new Date() })
      .where(eq(kpTicketSessionsTable.id, id)).returning();
    return { status: "paid", session: paid! };
  });
}

/** Paid VIP entitlement only. A ticket must still exist; the Discord caller checks that live. */
export async function listKpVipOrders(guildId: string, memberId?: string, roomId?: string) {
  return db.select().from(kpTicketSessionsTable).where(and(
    eq(kpTicketSessionsTable.guildId, guildId), eq(kpTicketSessionsTable.phase, "paid"),
    sql`${kpTicketSessionsTable.selection}->>'serviceVersion' = '2'`,
    sql`${kpTicketSessionsTable.selection}->>'vip' = 'true'`,
    memberId ? or(eq(kpTicketSessionsTable.userId, memberId),
      sql`${kpTicketSessionsTable.selection}->>'guestId' = ${memberId}`,
      sql`${kpTicketSessionsTable.selection}->>'castId' = ${memberId}`) : undefined,
    roomId ? sql`${kpTicketSessionsTable.selection}->>'vipRoomId' = ${roomId}` : undefined,
  )).orderBy(desc(kpTicketSessionsTable.paidAt));
}

/** Persist room association across restarts; serialize buyer/guest/cast arriving together. */
export async function deliverKpVipRoom(id: string, guildId: string, useRoom: (order: KpTicketSession) => Promise<string>) {
  return db.transaction(async tx => {
    const [order] = await tx.select().from(kpTicketSessionsTable).where(and(
      eq(kpTicketSessionsTable.id, id), eq(kpTicketSessionsTable.guildId, guildId),
    )).for("update");
    if (!order || order.phase !== "paid" || !order.selection.vip || order.selection.serviceVersion !== 2) {
      throw new KpTicketError("支払い済みVIPを確認できませんでした。");
    }
    const vipRoomId = await useRoom(order);
    await tx.update(kpTicketSessionsTable).set({ selection: { ...order.selection, vipRoomId } })
      .where(eq(kpTicketSessionsTable.id, id));
    return vipRoomId;
  });
}

/** Row lock serializes log retries; a send failure keeps the receipt pending. */
export async function deliverKpTicketLog(id: string, send: (session: KpTicketSession) => Promise<string>) {
  return db.transaction(async tx => {
    const [session] = await tx.select().from(kpTicketSessionsTable)
      .where(eq(kpTicketSessionsTable.id, id)).for("update");
    if (!session || session.phase !== "paid") throw new KpTicketError("支払い済みの注文ではありません。");
    if (session.logMessageId) return session.logMessageId;
    const messageId = await send(session);
    await tx.update(kpTicketSessionsTable).set({ logMessageId: messageId }).where(eq(kpTicketSessionsTable.id, id));
    return messageId;
  });
}
