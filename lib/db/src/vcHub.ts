import { and, eq } from "drizzle-orm";
import { db } from "./index.js";
import { vcHubChannelsTable, vcHubSessionsTable } from "./schema/vcHub.js";

/** ギルドの全 Hub チャンネル設定を取得 */
export async function getHubChannels(guildId: string) {
  return db
    .select()
    .from(vcHubChannelsTable)
    .where(eq(vcHubChannelsTable.guildId, guildId));
}

/**
 * チャンネルIDが Hub として登録されているか確認。
 * Hub なら設定行を、そうでなければ null を返す。
 */
export async function getHubByChannelId(hubChannelId: string) {
  const rows = await db
    .select()
    .from(vcHubChannelsTable)
    .where(eq(vcHubChannelsTable.hubChannelId, hubChannelId))
    .limit(1);
  return rows[0] ?? null;
}

/** Hub チャンネルを追加（既存なら設定を上書き） */
export async function addHubChannel(
  guildId: string,
  hubChannelId: string,
  categoryId: string | null,
  nameTemplate: string,
  userLimit: number | null,
  salaryRatePerHour: number | null = null,
  salaryMinMinutes: number = 1,
) {
  const rows = await db
    .insert(vcHubChannelsTable)
    .values({ guildId, hubChannelId, categoryId, nameTemplate, userLimit, salaryRatePerHour, salaryMinMinutes })
    .onConflictDoUpdate({
      target: vcHubChannelsTable.hubChannelId,
      set: { categoryId, nameTemplate, userLimit, salaryRatePerHour, salaryMinMinutes },
    })
    .returning();
  return rows[0]!;
}

/** Hub ID（PK）からHub設定を取得 */
export async function getHubChannelById(id: number) {
  const rows = await db
    .select()
    .from(vcHubChannelsTable)
    .where(eq(vcHubChannelsTable.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Hub チャンネル設定を削除 */
export async function removeHubChannel(guildId: string, hubChannelId: string) {
  const rows = await db
    .delete(vcHubChannelsTable)
    .where(
      and(
        eq(vcHubChannelsTable.guildId, guildId),
        eq(vcHubChannelsTable.hubChannelId, hubChannelId),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/** Hub によって生成されたVCのセッションを記録 */
export async function createHubSession(
  guildId: string,
  channelId: string,
  ownerId: string,
  hubId: number,
) {
  const rows = await db
    .insert(vcHubSessionsTable)
    .values({ guildId, channelId, ownerId, hubId })
    .returning();
  return rows[0]!;
}

/** 生成VCのチャンネルIDからセッションを取得 */
export async function getHubSession(channelId: string) {
  const rows = await db
    .select()
    .from(vcHubSessionsTable)
    .where(eq(vcHubSessionsTable.channelId, channelId))
    .limit(1);
  return rows[0] ?? null;
}

/** セッションを削除（VC を auto-delete する前に呼ぶ） */
export async function deleteHubSession(channelId: string) {
  const rows = await db
    .delete(vcHubSessionsTable)
    .where(eq(vcHubSessionsTable.channelId, channelId))
    .returning();
  return rows[0] ?? null;
}
