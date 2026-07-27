import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * One row per bounty. `reward` is deducted from the poster's wallet at post
 * time and transferred to the winner at award time (or refunded on cancel).
 */
export const bountiesTable = pgTable("bounties", {
  id:          serial("id").primaryKey(),
  guildId:     text("guild_id").notNull(),
  posterId:    text("poster_id").notNull(),
  title:       text("title").notNull(),
  description: text("description").notNull(),
  reward:      integer("reward").notNull(),
  /** "active" | "awarded" | "cancelled" */
  status:      text("status").notNull().default("active"),
  awardedTo:   text("awarded_to"),
  createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:   timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Bounty = typeof bountiesTable.$inferSelect;
