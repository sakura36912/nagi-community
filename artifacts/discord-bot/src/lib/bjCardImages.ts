/**
 * ブラックジャックのカード画像を DB で管理するユーティリティ。
 */
import { eq, and } from "drizzle-orm";
import { db, bjCardImagesTable } from "@workspace/db";

/**
 * カード画像の URL を登録・上書きする。
 */
export async function setBjCardImage(
  guildId: string,
  rank: string,
  suit: string,
  imageUrl: string,
): Promise<void> {
  await db
    .insert(bjCardImagesTable)
    .values({ guildId, rank, suit, imageUrl })
    .onConflictDoUpdate({
      target: [bjCardImagesTable.guildId, bjCardImagesTable.rank, bjCardImagesTable.suit],
      set: { imageUrl },
    });
}

/**
 * ギルドの全カード画像を取得し、`"rank:suit"` をキーとする Map で返す。
 * 例: `"A:spade"` → `"https://storage.googleapis.com/..."`
 */
export async function getBjCardImages(
  guildId: string,
): Promise<Map<string, string>> {
  const rows = await db
    .select()
    .from(bjCardImagesTable)
    .where(eq(bjCardImagesTable.guildId, guildId));
  return new Map(rows.map((r) => [`${r.rank}:${r.suit}`, r.imageUrl]));
}

/**
 * 特定のカード画像を削除する（リセット用）。
 */
export async function deleteBjCardImage(
  guildId: string,
  rank: string,
  suit: string,
): Promise<void> {
  await db
    .delete(bjCardImagesTable)
    .where(
      and(
        eq(bjCardImagesTable.guildId, guildId),
        eq(bjCardImagesTable.rank, rank),
        eq(bjCardImagesTable.suit, suit),
      ),
    );
}
