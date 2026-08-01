import { and, eq, lte } from "drizzle-orm";
import { db } from "./index.js";
import { timedRoleGrantsTable } from "./schema/timedRoleGrants.js";

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
