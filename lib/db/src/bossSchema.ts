import { sql } from "drizzle-orm";
import { db } from "./index";
import { ensureForgeSchema } from "./forgeSchema";
let ready: Promise<void> | undefined;
/** 既存残高・鍛冶屋・ボスデータに破壊的変更を加えない追加専用移行。 */
export function ensureBossSchema(): Promise<void> {
  if (!ready) ready = ensureForgeSchema().then(() => db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('boss-schema'))`);
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS boss_fees (guild_id text PRIMARY KEY, attack_cost integer CHECK (attack_cost >= 0), heal_cost integer CHECK (heal_cost >= 0));
      CREATE TABLE IF NOT EXISTS boss_events (
        id text PRIMARY KEY, guild_id text NOT NULL, channel_id text NOT NULL, boss_type text NOT NULL,
        config jsonb NOT NULL, status text NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL DEFAULT now(), ends_at timestamptz NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS boss_events_one_active_guild_idx ON boss_events(guild_id) WHERE status = 'active';
      CREATE TABLE IF NOT EXISTS boss_battles (
        id text PRIMARY KEY, event_id text NOT NULL, guild_id text NOT NULL, mode text NOT NULL,
        status text NOT NULL, max_hp integer NOT NULL, current_hp integer NOT NULL,
        attack_cost integer NOT NULL, heal_cost integer NOT NULL, action_count integer NOT NULL DEFAULT 0,
        counter_turn integer NOT NULL DEFAULT 0, lobby_ends_at timestamptz, started_at timestamptz,
        ends_at timestamptz NOT NULL, finished_at timestamptz, reason text, rewards jsonb NOT NULL DEFAULT '[]',
        notice_state text, notice_message_id text, notice_attempts integer NOT NULL DEFAULT 0,
        notice_next_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS boss_battles_guild_event_idx ON boss_battles(guild_id, event_id);
      CREATE TABLE IF NOT EXISTS boss_members (
        battle_id text NOT NULL, guild_id text NOT NULL, user_id text NOT NULL, display_name text NOT NULL,
        hp integer NOT NULL, max_hp integer NOT NULL, damage bigint NOT NULL DEFAULT 0,
        attack_count integer NOT NULL DEFAULT 0, weapon jsonb NOT NULL,
        effects jsonb NOT NULL DEFAULT '{"bleedTicks":0,"vulnerableTicks":0,"shield":false}',
        action_ready_at timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z',
        PRIMARY KEY(battle_id,user_id)
      );
      CREATE TABLE IF NOT EXISTS boss_active_users (
        guild_id text NOT NULL, user_id text NOT NULL, battle_id text NOT NULL, PRIMARY KEY(guild_id,user_id)
      );
      CREATE TABLE IF NOT EXISTS boss_join_requests (
        id text PRIMARY KEY, guild_id text NOT NULL, user_id text NOT NULL, event_id text NOT NULL,
        mode text NOT NULL, battle_id text, attack_cost integer NOT NULL, heal_cost integer NOT NULL,
        expires_at timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS boss_actions (
        id text PRIMARY KEY, guild_id text NOT NULL, user_id text NOT NULL, action text NOT NULL,
        result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  })).catch(error => { ready = undefined; throw error; });
  return ready;
}
