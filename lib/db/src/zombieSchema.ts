import { sql } from "drizzle-orm";
import { db } from "./index";
let ready: Promise<void> | undefined;
export function ensureZombieSchema() {
  return ready ??= db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('zombie-schema'))`);
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS zombie_configs(guild_id text PRIMARY KEY, config jsonb NOT NULL);
      CREATE TABLE IF NOT EXISTS zombie_games(id text PRIMARY KEY, guild_id text NOT NULL, state jsonb NOT NULL);
      CREATE TABLE IF NOT EXISTS zombie_operations(id text PRIMARY KEY, guild_id text NOT NULL, actor text NOT NULL, action text NOT NULL, game_id text NOT NULL);
      CREATE TABLE IF NOT EXISTS zombie_jobs(id text PRIMARY KEY, guild_id text NOT NULL, payload jsonb NOT NULL,
        delivered_at timestamptz, next_at timestamptz NOT NULL DEFAULT now(), error text);
    `);
  }).catch(e => { ready = undefined; throw e; });
}
