import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/** Hub VC 設定: 入ると自動で新VCを作成するトリガーチャンネル */
export const vcHubChannelsTable = pgTable("vc_hub_channels", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  hubChannelId: text("hub_channel_id").notNull().unique(),
  /** 生成VCを置くカテゴリ (null = hub と同じカテゴリ) */
  categoryId: text("category_id"),
  /** チャンネル名テンプレート。{user} をメンバーの表示名で置換 */
  nameTemplate: text("name_template").notNull().default("{user}のVC"),
  /** 生成VCの人数制限 (null = 制限なし, 0 = 無制限) */
  userLimit: integer("user_limit"),
  /** この Hub の生成VC に滞在しているときの時給 (null = 分給なし) */
  salaryRatePerHour: integer("salary_rate_per_hour"),
  /** 分給の最低滞在時間（分）。デフォルト1分 */
  salaryMinMinutes: integer("salary_min_minutes").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Hub によって生成されたVCのセッション管理 */
export const vcHubSessionsTable = pgTable("vc_hub_sessions", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id").notNull(),
  /** 生成されたVCチャンネルのID */
  channelId: text("channel_id").notNull().unique(),
  /** 生成をトリガーしたメンバーのID */
  ownerId: text("owner_id").notNull(),
  hubId: integer("hub_id")
    .notNull()
    .references(() => vcHubChannelsTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type VcHubChannel = typeof vcHubChannelsTable.$inferSelect;
export type VcHubSession  = typeof vcHubSessionsTable.$inferSelect;
