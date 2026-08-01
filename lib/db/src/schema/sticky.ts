import { pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";

export const stickyMessagesTable = pgTable(
  "sticky_messages",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    content: text("content").notNull(),
    /** Discord message ID of the last posted sticky — used to delete it before re-posting */
    lastMessageId: text("last_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("sticky_messages_guild_channel").on(t.guildId, t.channelId)],
);

export type StickyMessage = typeof stickyMessagesTable.$inferSelect;
