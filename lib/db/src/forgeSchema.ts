import { sql } from "drizzle-orm";
import { db } from "./index";

let ready: Promise<void> | undefined;
/** 既存の残高・武器DBには触れず、新規テーブルのみ追加する。 */
export function ensureForgeSchema(): Promise<void> {
  if (!ready) ready = db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('forge-schema'))`);
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS forge_weapons (
        guild_id text NOT NULL, user_id text NOT NULL, weapon_type text NOT NULL,
        weapon_level integer NOT NULL DEFAULT 1 CHECK (weapon_level >= 1),
        attack integer NOT NULL CHECK (attack >= 0), defense integer NOT NULL CHECK (defense >= 0),
        skill text NOT NULL, version integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (guild_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS forge_upgrade_settings (
        guild_id text NOT NULL, level integer NOT NULL CHECK (level >= 1),
        cost integer CHECK (cost >= 0),
        success_rate integer CHECK (success_rate BETWEEN 30 AND 100),
        PRIMARY KEY (guild_id, level)
      );
      CREATE TABLE IF NOT EXISTS forge_upgrade_requests (
        id text PRIMARY KEY, guild_id text NOT NULL, user_id text NOT NULL,
        weapon_version integer NOT NULL, weapon_type text NOT NULL, weapon_level integer NOT NULL,
        cost integer NOT NULL CHECK (cost >= 0), success_rate integer NOT NULL,
        state text NOT NULL DEFAULT 'pending', expires_at timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS forge_actions (
        id text PRIMARY KEY, guild_id text NOT NULL, user_id text NOT NULL,
        actor_id text NOT NULL, action text NOT NULL, result jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }).catch(error => { ready = undefined; throw error; });
  return ready;
}
