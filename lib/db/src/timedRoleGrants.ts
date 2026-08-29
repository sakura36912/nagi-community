import { and, eq, inArray, lte } from "drizzle-orm";
import { db } from "./index.js";
import {
  timedRoleConfigsTable,
  timedRoleGrantsTable,
} from "./schema/timedRoleGrants.js";

export const ADMIN_TIMED_ROLE_EFFECT = "admin_timed_role";

/** 期限付きロール付与を記録（同ロールが既にあれば期限を更新） */
export async function upsertTimedRoleGrant(
  guildId: string,
  userId: string,
  roleId: string,
  effectType: string,
  expiresAt: Date,
) {
  const [row] = await db
    .insert(timedRoleGrantsTable)
    .values({ guildId, userId, roleId, effectType, expiresAt })
    .onConflictDoUpdate({
      target: [
        timedRoleGrantsTable.guildId,
        timedRoleGrantsTable.userId,
        timedRoleGrantsTable.roleId,
      ],
      set: { effectType, expiresAt },
    })
    .returning();
  return row!;
}

/** 同じユーザー・ロールの予約がない場合だけ期限付き付与を記録 */
export async function insertTimedRoleGrantIfAbsent(
  guildId: string,
  userId: string,
  roleId: string,
  effectType: string,
  expiresAt: Date,
) {
  const [row] = await db
    .insert(timedRoleGrantsTable)
    .values({ guildId, userId, roleId, effectType, expiresAt })
    .onConflictDoNothing()
    .returning();
  return row;
}

/** 期限切れの付与レコードを全件取得 */
export async function getExpiredTimedRoleGrants(now: Date) {
  return db
    .select()
    .from(timedRoleGrantsTable)
    .where(lte(timedRoleGrantsTable.expiresAt, now));
}

/** ロール付与レコードを削除（ロール剥奪後に呼ぶ） */
export async function deleteTimedRoleGrant(id: number) {
  await db
    .delete(timedRoleGrantsTable)
    .where(eq(timedRoleGrantsTable.id, id));
}

/** 特定ユーザーの特定ロール付与レコードを削除 */
export async function deleteTimedRoleGrantByUser(
  guildId: string,
  userId: string,
  roleId: string,
) {
  await db
    .delete(timedRoleGrantsTable)
    .where(
      and(
        eq(timedRoleGrantsTable.guildId, guildId),
        eq(timedRoleGrantsTable.userId, userId),
        eq(timedRoleGrantsTable.roleId, roleId),
      ),
    );
}

/** 特定ギルドの特定ロールに紐づく期限付き付与レコードを全件削除 */
export async function deleteTimedRoleGrantsByRole(guildId: string, roleId: string) {
  await db
    .delete(timedRoleGrantsTable)
    .where(
      and(
        eq(timedRoleGrantsTable.guildId, guildId),
        eq(timedRoleGrantsTable.roleId, roleId),
      ),
    );
}

/** ロール単位の自動解除期間を保存（既存設定は上書き） */
export async function upsertTimedRoleConfig(
  guildId: string,
  roleId: string,
  durationSeconds: number,
) {
  const [row] = await db
    .insert(timedRoleConfigsTable)
    .values({ guildId, roleId, durationSeconds })
    .onConflictDoUpdate({
      target: [timedRoleConfigsTable.guildId, timedRoleConfigsTable.roleId],
      set: { durationSeconds, updatedAt: new Date() },
    })
    .returning();
  return row!;
}

/** 追加されたロールID群に一致する自動解除設定を取得 */
export async function getTimedRoleConfigsForRoles(guildId: string, roleIds: string[]) {
  if (roleIds.length === 0) return [];
  return db
    .select()
    .from(timedRoleConfigsTable)
    .where(
      and(
        eq(timedRoleConfigsTable.guildId, guildId),
        inArray(timedRoleConfigsTable.roleId, roleIds),
      ),
    );
}

/** 自動解除設定と、管理者設定由来の未実行予約を同時に削除 */
export async function deleteTimedRoleConfigAndGrants(guildId: string, roleId: string) {
  await db.transaction(async (tx) => {
    await tx
      .delete(timedRoleConfigsTable)
      .where(
        and(
          eq(timedRoleConfigsTable.guildId, guildId),
          eq(timedRoleConfigsTable.roleId, roleId),
        ),
      );
    await tx
      .delete(timedRoleGrantsTable)
      .where(
        and(
          eq(timedRoleGrantsTable.guildId, guildId),
          eq(timedRoleGrantsTable.roleId, roleId),
          eq(timedRoleGrantsTable.effectType, ADMIN_TIMED_ROLE_EFFECT),
        ),
      );
  });
}
