import { and, eq, inArray } from "drizzle-orm";
import { db } from "./index.js";
import { evalSheetConfigTable } from "./schema/evalsheet.js";

/** ロール → フォーラム のマッピングを追加または更新 */
export async function upsertEvalSheetConfig(
  guildId: string,
  roleId: string,
  forumChannelId: string,
  evalPeriodDays: number,
) {
  const rows = await db
    .insert(evalSheetConfigTable)
    .values({ guildId, roleId, forumChannelId, evalPeriodDays })
    .onConflictDoUpdate({
      target: [evalSheetConfigTable.guildId, evalSheetConfigTable.roleId],
      set: { forumChannelId, evalPeriodDays },
    })
    .returning();
  return rows[0]!;
}

/** ギルドの全マッピングを取得 */
export async function listEvalSheetConfigs(guildId: string) {
  return db
    .select()
    .from(evalSheetConfigTable)
    .where(eq(evalSheetConfigTable.guildId, guildId));
}

/**
 * 追加されたロールIDのリストに対して一致するマッピングを返す。
 * GuildMemberUpdate で複数ロールが同時付与された場合に全マッピングを取得するために使用。
 */
export async function getEvalSheetConfigsForRoles(
  guildId: string,
  roleIds: string[],
) {
  if (roleIds.length === 0) return [];
  return db
    .select()
    .from(evalSheetConfigTable)
    .where(
      and(
        eq(evalSheetConfigTable.guildId, guildId),
        inArray(evalSheetConfigTable.roleId, roleIds),
      ),
    );
}

/** ロールIDに対応するマッピングを削除 */
export async function deleteEvalSheetConfig(guildId: string, roleId: string) {
  const rows = await db
    .delete(evalSheetConfigTable)
    .where(
      and(
        eq(evalSheetConfigTable.guildId, guildId),
        eq(evalSheetConfigTable.roleId, roleId),
      ),
    )
    .returning();
  return rows[0] ?? null;
}
