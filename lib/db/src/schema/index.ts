// Export your models here. Add one export per file
// export * from "./posts";
//
// Each model/table should ideally be split into different files.
// Each model/table should define a Drizzle table, insert schema, and types:
//
//   import { pgTable, text, serial } from "drizzle-orm/pg-core";
//   import { createInsertSchema } from "drizzle-zod";
//   import { z } from "zod/v4";
//
//   export const postsTable = pgTable("posts", {
//     id: serial("id").primaryKey(),
//     title: text("title").notNull(),
//   });
//
//   export const insertPostSchema = createInsertSchema(postsTable).omit({ id: true });
//   export type InsertPost = z.infer<typeof insertPostSchema>;
//   export type Post = typeof postsTable.$inferSelect;

export * from "./economy";
export * from "./evalsheet";
export * from "./community";
export * from "./vc";
export * from "./shifts";
export * from "./vcRewards";
export * from "./slots";
export * from "./triggers";
export * from "./vcHub";
export * from "./points";
export * from "./guide";
export * from "./blackjack";
export * from "./sticky";
export * from "./timedRoleGrants";
export * from "./baccarat";
export * from "./casinoPlayLimits";
export * from "./chinchiro";
export * from "./chinchiroMultiplayer";

