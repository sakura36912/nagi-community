/**
 * Migration: VC滞在セッションログ用テーブルを作成する
 * Run: npx tsx lib/db/migrate-vc-session-log.ts
 */
import { db } from "./src/index";
import { sql } from "drizzle-orm";

async function main() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS vc_session_log_settings (
      guild_id   text PRIMARY KEY,
      category_ids text[] NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS vc_log_presence (
      guild_id   text NOT NULL,
      user_id    text NOT NULL,
      channel_id text NOT NULL,
      category_id text NOT NULL,
      joined_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS vc_session_logs (
      id              serial PRIMARY KEY,
      guild_id        text NOT NULL,
      user_id         text NOT NULL,
      channel_id      text NOT NULL,
      category_id     text NOT NULL,
      joined_at       timestamptz NOT NULL,
      left_at         timestamptz NOT NULL,
      duration_seconds integer NOT NULL
    );

    CREATE INDEX IF NOT EXISTS vc_session_logs_guild_user_idx
      ON vc_session_logs (guild_id, user_id);
    CREATE INDEX IF NOT EXISTS vc_session_logs_joined_at_idx
      ON vc_session_logs (joined_at DESC);
  `);

  console.log("Migration complete: vc_session_log_settings, vc_log_presence, vc_session_logs created.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
