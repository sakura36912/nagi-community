import { eq } from "drizzle-orm";
import { db, communityRoleButtonsTable } from "@workspace/db";
import type { CommunityRoleButton } from "@workspace/db";

export type { CommunityRoleButton };

/** パネルの全ボタンを登録する */
export async function insertRolePanelButtons(
  guildId: string,
  channelId: string,
  messageId: string,
  buttons: { roleId: string; label: string; style: number }[],
): Promise<void> {
  await db.insert(communityRoleButtonsTable).values(
    buttons.map((b) => ({ guildId, channelId, messageId, ...b })),
  );
}

/** messageId に紐づくボタン一覧を取得する */
export async function getRolePanelButtons(messageId: string): Promise<CommunityRoleButton[]> {
  return db
    .select()
    .from(communityRoleButtonsTable)
    .where(eq(communityRoleButtonsTable.messageId, messageId));
}

/** パネルごとのボタンを全削除する（パネル削除時） */
export async function deleteRolePanelButtons(messageId: string): Promise<void> {
  await db
    .delete(communityRoleButtonsTable)
    .where(eq(communityRoleButtonsTable.messageId, messageId));
}
