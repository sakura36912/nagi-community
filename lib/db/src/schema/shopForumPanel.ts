import {
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { shopItemsTable } from "./economy";

/**
 * A single purchase panel attached to a Discord forum post/thread.
 *
 * The referenced shop item is intentionally separate from the normal shop
 * categories so each forum post can have its own product, price, and effect.
 */
export const shopForumPanelsTable = pgTable(
  "shop_forum_panels",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    shopItemId: integer("shop_item_id")
      .notNull()
      .references(() => shopItemsTable.id, { onDelete: "cascade" }),
    panelMessageId: text("panel_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique().on(table.guildId, table.channelId)],
);

export const insertShopForumPanelSchema = createInsertSchema(shopForumPanelsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertShopForumPanel = z.infer<typeof insertShopForumPanelSchema>;
export type ShopForumPanel = typeof shopForumPanelsTable.$inferSelect;