import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "./index";
import { walletsTable, transactionsTable } from "./schema/economy";
import { forgeWeaponsTable as weapons, forgeUpgradeSettingsTable as settings,
  forgeUpgradeRequestsTable as requests, forgeActionsTable as actions,
  type ForgeActionResult } from "./schema/forge";
import { ensureForgeSchema } from "./forgeSchema";
import { queueForgeCard } from "./rpgNotices";
import { ForgeError, forgeInteger, forgeStats, isForgeWeaponType, resolveForgeSetting, forgeRoll,
  type ForgeWeaponType } from "./forgeRules";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const weaponWhere = (guildId: string, userId: string) => and(eq(weapons.guildId, guildId), eq(weapons.userId, userId));
async function lockWeapon(tx: Tx, guildId: string, userId: string) {
  // 新規登録・リセットも含めて同じロックを取る（行がまだなくても排他できる）。
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["forge-user", guildId, userId])}, 0))`);
}
async function lockSettings(tx: Tx, guildId: string, exclusive = false) {
  const key = JSON.stringify(["forge-settings", guildId]);
  if (exclusive) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  else await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`);
}
async function readSetting(tx: Tx | typeof db, guildId: string, level: number) {
  const [row] = await tx.select().from(settings).where(and(eq(settings.guildId, guildId), eq(settings.level, level)));
  return resolveForgeSetting(level, row);
}
async function previousAction(tx: Tx, id: string, guildId: string, userId: string, actorId: string, action: string) {
  const [row] = await tx.select().from(actions).where(eq(actions.id, id));
  if (!row) return undefined;
  if (row.guildId !== guildId || row.userId !== userId || row.actorId !== actorId || row.action !== action) {
    throw new ForgeError("操作の識別情報が一致しません。");
  }
  return row.result;
}
async function recordAction(tx: Tx, id: string, guildId: string, userId: string, actorId: string, result: ForgeActionResult) {
  await tx.insert(actions).values({ id, guildId, userId, actorId, action: result.action, result });
  return result;
}
export async function getForgeWeapon(guildId: string, userId: string) {
  await ensureForgeSchema();
  const [weapon] = await db.select().from(weapons).where(weaponWhere(guildId, userId));
  return weapon;
}
/** ボス側は公開表示用データではなく、こちらの内部データを取得する。 */
export const getForgeCombatant = getForgeWeapon;
export async function getForgeSetting(guildId: string, level: number) {
  await ensureForgeSchema();
  forgeInteger(level, 1);
  return readSetting(db, guildId, level);
}
export async function listForgeSettings(guildId: string) {
  await ensureForgeSchema();
  const overrides = await db.select().from(settings).where(eq(settings.guildId, guildId)).orderBy(asc(settings.level));
  const levels = [...new Set([1, 2, 3, ...overrides.map(row => row.level)])].sort((a, b) => a - b);
  return levels.map(level => resolveForgeSetting(level, overrides.find(row => row.level === level)));
}
export async function selectForgeWeapon(id: string, guildId: string, userId: string, type: ForgeWeaponType, channelId?: string) {
  await ensureForgeSchema();
  if (!isForgeWeaponType(type)) throw new ForgeError("未対応の武器です。");
  return db.transaction(async tx => {
    await lockWeapon(tx, guildId, userId);
    const previous = await previousAction(tx, id, guildId, userId, userId, "select");
    if (previous) return previous;
    const [exists] = await tx.select().from(weapons).where(weaponWhere(guildId, userId));
    if (exists) throw new ForgeError("武器は既に選択済みです。変更・リセットは管理者に依頼してください。");
    await tx.insert(weapons).values({ guildId, userId, weaponType: type, weaponLevel: 1, ...forgeStats(type, 1) });
    const result = await recordAction(tx, id, guildId, userId, userId, { action: "select", weaponType: type, level: 1 });
    if (channelId) await queueForgeCard(tx, id, guildId, userId, channelId, result);
    return result;
  });
}
export async function createForgeUpgradeRequest(id: string, guildId: string, userId: string) {
  await ensureForgeSchema();
  return db.transaction(async tx => {
    await lockSettings(tx, guildId);
    await lockWeapon(tx, guildId, userId);
    const [weapon] = await tx.select().from(weapons).where(weaponWhere(guildId, userId));
    if (!weapon) throw new ForgeError("先に /武器選択 で武器を選んでください。");
    const setting = await readSetting(tx, guildId, weapon.weaponLevel);
    if (setting.cost === null) throw new ForgeError("このレベルの強化費用は未設定です。管理者に設定を依頼してください。");
    const [request] = await tx.insert(requests).values({
      id, guildId, userId, weaponVersion: weapon.version, weaponType: weapon.weaponType,
      weaponLevel: weapon.weaponLevel, cost: setting.cost, successRate: setting.successRate,
      expiresAt: new Date(Date.now() + 120_000),
    }).returning();
    return request!;
  });
}
export async function cancelForgeUpgrade(id: string, guildId: string, userId: string) {
  await ensureForgeSchema();
  return db.transaction(async tx => {
    await lockWeapon(tx, guildId, userId);
    const [row] = await tx.select().from(requests).where(eq(requests.id, id)).for("update");
    if (!row || row.guildId !== guildId || row.userId !== userId) throw new ForgeError("この確認画面は操作できません。");
    if (row.state === "paid") throw new ForgeError("この強化は既に処理済みです。再度課金はされません。");
    await tx.update(requests).set({ state: "cancelled" }).where(eq(requests.id, id));
  });
}
export async function settleForgeUpgrade(id: string, guildId: string, userId: string, roll: () => number = forgeRoll, channelId?: string) {
  await ensureForgeSchema();
  return db.transaction(async tx => {
    await lockSettings(tx, guildId);
    await lockWeapon(tx, guildId, userId);
    const previous = await previousAction(tx, `forge:${id}`, guildId, userId, userId, "upgrade");
    if (previous) return { ...previous, repeated: true };
    const [request] = await tx.select().from(requests).where(eq(requests.id, id)).for("update");
    if (!request || request.guildId !== guildId || request.userId !== userId) throw new ForgeError("この確認画面は操作できません。");
    if (request.state !== "pending" || request.expiresAt.getTime() <= Date.now()) throw new ForgeError("この確認はキャンセル済みか期限切れです。/強化 からやり直してください。");
    const [weapon] = await tx.select().from(weapons).where(weaponWhere(guildId, userId)).for("update");
    if (!weapon || weapon.version !== request.weaponVersion || weapon.weaponType !== request.weaponType || weapon.weaponLevel !== request.weaponLevel) {
      throw new ForgeError("武器の状態が変更されています。/強化 から確認し直してください。");
    }
    const setting = await readSetting(tx, guildId, weapon.weaponLevel);
    if (setting.cost !== request.cost || setting.successRate !== request.successRate) {
      throw new ForgeError("費用または成功率が変更されました。課金せず停止しました。/強化 から確認し直してください。");
    }
    const random = roll();
    if (!Number.isFinite(random) || random < 0 || random >= 1) throw new ForgeError("乱数が不正です。");
    const success = random < request.successRate / 100;
    const level = weapon.weaponLevel + (success ? 1 : 0);
    if (!isForgeWeaponType(weapon.weaponType)) throw new ForgeError("武器設定が不正です。");
    const stats = success ? forgeStats(weapon.weaponType, level) : { attack: weapon.attack, defense: weapon.defense, skill: weapon.skill };
    await tx.insert(walletsTable).values({ guildId, userId, balance: 0 }).onConflictDoNothing();
    const [wallet] = await tx.update(walletsTable).set({
      balance: sql`${walletsTable.balance} - ${request.cost}`, updatedAt: new Date(),
    }).where(and(eq(walletsTable.guildId, guildId), eq(walletsTable.userId, userId),
      sql`${walletsTable.balance} >= ${request.cost}`)).returning();
    if (!wallet) throw new ForgeError("残高が不足しています。課金・武器変更は行っていません。");
    await tx.update(weapons).set({ weaponLevel: level, ...stats, version: weapon.version + 1, updatedAt: new Date() })
      .where(weaponWhere(guildId, userId));
    await tx.insert(transactionsTable).values({ guildId, userId, amount: -request.cost, sessionKey: `forge:${id}`,
      reason: `武器強化 ${weapon.weaponType} Lv${weapon.weaponLevel}→${level} ${success ? "成功" : "失敗"}` });
    await tx.update(requests).set({ state: "paid" }).where(eq(requests.id, id));
    const result = await recordAction(tx, `forge:${id}`, guildId, userId, userId,
      { action: "upgrade", weaponType: weapon.weaponType, level, success, cost: request.cost, balance: wallet.balance });
    if (channelId) await queueForgeCard(tx, id, guildId, userId, channelId, result);
    return { ...result, repeated: false };
  });
}
export async function adminForgeWeapon(id: string, guildId: string, userId: string, actorId: string, type: ForgeWeaponType | null) {
  await ensureForgeSchema();
  if (type !== null && !isForgeWeaponType(type)) throw new ForgeError("未対応の武器です。");
  return db.transaction(async tx => {
    await lockWeapon(tx, guildId, userId);
    const action = type === null ? "reset" : "change";
    const previous = await previousAction(tx, id, guildId, userId, actorId, action);
    if (previous) return previous;
    const [weapon] = await tx.select().from(weapons).where(weaponWhere(guildId, userId));
    if (!weapon) throw new ForgeError("このユーザーは武器を持っていません。");
    // 古い確認画面を管理操作の後に再利用させない。
    await tx.update(requests).set({ state: "cancelled" }).where(and(eq(requests.guildId, guildId),
      eq(requests.userId, userId), eq(requests.state, "pending")));
    if (type === null) await tx.delete(weapons).where(weaponWhere(guildId, userId));
    else await tx.update(weapons).set({ weaponType: type, ...forgeStats(type, weapon.weaponLevel),
      version: weapon.version + 1, updatedAt: new Date() }).where(weaponWhere(guildId, userId));
    return recordAction(tx, id, guildId, userId, actorId,
      { action, weaponType: type ?? weapon.weaponType, level: weapon.weaponLevel, reset: type === null });
  });
}
export async function configureForgeSetting(id: string, guildId: string, actorId: string, level: number,
  patch: { cost?: number; successRate?: number }) {
  await ensureForgeSchema();
  forgeInteger(level, 1);
  if (patch.cost !== undefined) forgeInteger(patch.cost);
  if (patch.successRate !== undefined && (!Number.isInteger(patch.successRate) || patch.successRate < 30 || patch.successRate > 100)) {
    throw new ForgeError("成功率は30〜100%の整数で指定してください。");
  }
  if (patch.cost === undefined && patch.successRate === undefined) throw new ForgeError("設定項目がありません。");
  return db.transaction(async tx => {
    await lockSettings(tx, guildId, true);
    const previous = await previousAction(tx, id, guildId, actorId, actorId, "configure");
    if (previous) return previous;
    await tx.insert(settings).values({ guildId, level, ...patch })
      .onConflictDoUpdate({ target: [settings.guildId, settings.level], set: patch });
    await recordAction(tx, id, guildId, actorId, actorId, { action: "configure", level, ...patch });
    return readSetting(tx, guildId, level);
  });
}
export async function resetForgeSettings(id: string, guildId: string, actorId: string, field: "cost" | "successRate") {
  await ensureForgeSchema();
  return db.transaction(async tx => {
    await lockSettings(tx, guildId, true);
    const action = `reset-${field}`;
    if (await previousAction(tx, id, guildId, actorId, actorId, action)) return;
    await tx.update(settings).set({ [field]: null }).where(eq(settings.guildId, guildId));
    await recordAction(tx, id, guildId, actorId, actorId, { action, reset: true });
  });
}
