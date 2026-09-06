import { check, integer, pgTable, primaryKey, text, sql } from "drizzle-orm/pg-core";

export const chinchiroDiceImagesTable = pgTable("chinchiro_dice_images", {
  guildId: text("guild_id").notNull(),
  face: integer("face").notNull(),
  objectPath: text("object_path").notNull(),
}, (table) => [
  primaryKey({ columns: [table.guildId, table.face] }),
  check("chinchiro_dice_images_face_check", sql`${table.face} between 1 and 6`),
]);

export type ChinchiroDiceImage = typeof chinchiroDiceImagesTable.$inferSelect;