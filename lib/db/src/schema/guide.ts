import { pgTable, serial, text, integer, timestamp } from "../sqliteColumns";

// ─── Guide Items ──────────────────────────────────────────────────────────────

/**
 * One row = one selectable item in a guild's guide panel.
 * Admins add/edit/remove items via /guide commands.
 */
export const guideItemsTable = pgTable("guide_items", {
  id:          serial("id").primaryKey(),
  guildId:     text("guild_id").notNull(),
  title:       text("title").notNull(),
  content:     text("content").notNull(),
  imageUrl:    text("image_url"),
  sortOrder:   integer("sort_order").notNull().default(0),
  createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:   timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type GuideItem = typeof guideItemsTable.$inferSelect;
