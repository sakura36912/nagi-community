import {
  ADMIN_TIMED_ROLE_EFFECT,
  getTimedRoleConfigsForRoles,
  insertTimedRoleGrantIfAbsent,
  upsertTimedRoleGrant,
} from "@workspace/db";

const PURCHASE_MARKER_TTL_MS = 60_000;
const purchaseRoleGrantMarkers = new Map<string, number>();

function purchaseMarkerKey(guildId: string, userId: string, roleId: string): string {
  return `${guildId}:${userId}:${roleId}`;
}

/** ショップ購入由来の付与を、管理者設定の期限適用から一度だけ除外する。 */
export function markTimedRoleGrantFromPurchase(
  guildId: string,
  userId: string,
  roleId: string,
): void {
  purchaseRoleGrantMarkers.set(
    purchaseMarkerKey(guildId, userId, roleId),
    Date.now() + PURCHASE_MARKER_TTL_MS,
  );
}

export function consumeTimedRoleGrantFromPurchase(
  guildId: string,
  userId: string,
  roleId: string,
): boolean {
  const key = purchaseMarkerKey(guildId, userId, roleId);
  const expiresAt = purchaseRoleGrantMarkers.get(key);
  purchaseRoleGrantMarkers.delete(key);
  return expiresAt !== undefined && expiresAt >= Date.now();
}

export function clearTimedRoleGrantFromPurchase(
  guildId: string,
  userId: string,
  roleId: string,
): void {
  purchaseRoleGrantMarkers.delete(purchaseMarkerKey(guildId, userId, roleId));
}

/**
 * 管理者設定の対象ロールが追加されたメンバーについて、付与時点を起点に
 * 個別の自動解除予約を作る。
 */
export async function scheduleConfiguredTimedRoles(
  guildId: string,
  userId: string,
  addedRoleIds: string[],
  grantedAt: Date = new Date(),
): Promise<number> {
  const configs = await getTimedRoleConfigsForRoles(guildId, addedRoleIds);
  await Promise.all(
    configs.map((config) =>
      upsertTimedRoleGrant(
        guildId,
        userId,
        config.roleId,
        ADMIN_TIMED_ROLE_EFFECT,
        new Date(grantedAt.getTime() + config.durationSeconds * 1000),
      ),
    ),
  );
  return configs.length;
}

/**
 * 更新前ロールが取得できない場合に、既存期限を動かさず未登録分だけ補完する。
 */
export async function scheduleConfiguredTimedRolesIfMissing(
  guildId: string,
  userId: string,
  currentRoleIds: string[],
  observedAt: Date = new Date(),
): Promise<number> {
  const configs = await getTimedRoleConfigsForRoles(guildId, currentRoleIds);
  const inserted = await Promise.all(
    configs.map((config) =>
      insertTimedRoleGrantIfAbsent(
        guildId,
        userId,
        config.roleId,
        ADMIN_TIMED_ROLE_EFFECT,
        new Date(observedAt.getTime() + config.durationSeconds * 1000),
      ),
    ),
  );
  return inserted.filter(Boolean).length;
}