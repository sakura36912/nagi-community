import { pgTable, text, primaryKey } from "../sqliteColumns";

/**
 * ブラックジャック用カード画像テーブル。
 * ギルドごとにランク×スートの組み合わせに画像URLを紐付ける。
 */
export const bjCardImagesTable = pgTable("bj_card_images", {
  guildId:   text("guild_id").notNull(),
  rank:      text("rank").notNull(),       // "A" | "2" | ... | "K"
  suit:      text("suit").notNull(),       // "spade" | "heart" | "diamond" | "club"
  imageUrl:  text("image_url").notNull(),  // GCS 公開URL
}, (table) => [
  primaryKey({ columns: [table.guildId, table.rank, table.suit] }),
]);

export type BjCardImage = typeof bjCardImagesTable.$inferSelect;
