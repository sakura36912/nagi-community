import { bigint, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { BossActionResult, BossConfig, BossEffects, BossMode, BossPartsState, BossType, BossWeaponSnapshot, BattleStatus } from "../bossRules";

export const bossFeesTable = pgTable("boss_fees", {
  guildId: text("guild_id").primaryKey(), attackCost: integer("attack_cost"), healCost: integer("heal_cost"),
});
export const bossEventsTable = pgTable("boss_events", {
  id: text("id").primaryKey(), guildId: text("guild_id").notNull(), channelId: text("channel_id").notNull(),
  bossType: text("boss_type").$type<BossType>().notNull(), config: jsonb("config").$type<BossConfig>().notNull(),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
}, t => [uniqueIndex("boss_events_one_active_guild_idx").on(t.guildId).where(sql`${t.status} = 'active'`)]);
export type BossEvent = typeof bossEventsTable.$inferSelect;

export const bossBattlesTable = pgTable("boss_battles", {
  id: text("id").primaryKey(), eventId: text("event_id").notNull(), guildId: text("guild_id").notNull(),
  mode: text("mode").$type<BossMode>().notNull(), status: text("status").$type<BattleStatus>().notNull(),
  maxHp: integer("max_hp").notNull(), currentHp: integer("current_hp").notNull(),
  parts: jsonb("parts").$type<BossPartsState>().notNull().default({}),
  attackCost: integer("attack_cost").notNull(), healCost: integer("heal_cost").notNull(),
  actionCount: integer("action_count").notNull().default(0), counterTurn: integer("counter_turn").notNull().default(0),
  lobbyEndsAt: timestamp("lobby_ends_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }), reason: text("reason"),
  rewards: jsonb("rewards").$type<{ userId: string; amount: number }[]>().notNull().default([]),
  noticeState: text("notice_state"), noticeMessageId: text("notice_message_id"),
  noticeAttempts: integer("notice_attempts").notNull().default(0),
  noticeNextAt: timestamp("notice_next_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("boss_battles_guild_event_idx").on(t.guildId, t.eventId)]);
export type BossBattle = typeof bossBattlesTable.$inferSelect;

export const bossMembersTable = pgTable("boss_members", {
  battleId: text("battle_id").notNull(), guildId: text("guild_id").notNull(), userId: text("user_id").notNull(),
  displayName: text("display_name").notNull(), hp: integer("hp").notNull(), maxHp: integer("max_hp").notNull(),
  damage: bigint("damage", { mode: "number" }).notNull().default(0),
  attackCount: integer("attack_count").notNull().default(0),
  weapon: jsonb("weapon").$type<BossWeaponSnapshot>().notNull(),
  effects: jsonb("effects").$type<BossEffects>().notNull().default({ bleedTicks: 0, vulnerableTicks: 0, shield: false }),
  actionReadyAt: timestamp("action_ready_at", { withTimezone: true }).notNull().default(new Date(0)),
}, t => [primaryKey({ columns: [t.battleId, t.userId] })]);
export type BossMember = typeof bossMembersTable.$inferSelect;
export const bossActiveUsersTable = pgTable("boss_active_users", {
  guildId: text("guild_id").notNull(), userId: text("user_id").notNull(), battleId: text("battle_id").notNull(),
}, t => [primaryKey({ columns: [t.guildId, t.userId] })]);
export const bossJoinRequestsTable = pgTable("boss_join_requests", {
  id: text("id").primaryKey(), guildId: text("guild_id").notNull(), userId: text("user_id").notNull(),
  eventId: text("event_id").notNull(), mode: text("mode").$type<BossMode>().notNull(),
  battleId: text("battle_id"), attackCost: integer("attack_cost").notNull(), healCost: integer("heal_cost").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
export const bossActionsTable = pgTable("boss_actions", {
  id: text("id").primaryKey(), guildId: text("guild_id").notNull(), userId: text("user_id").notNull(),
  action: text("action").notNull(), result: jsonb("result").$type<BossActionResult>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
