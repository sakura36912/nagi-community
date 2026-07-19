/**
 * Migration: create vc_hub_channels and vc_hub_sessions tables
 * Run: node_modules/.bin/tsx lib/db/migrate-vc-hub.ts
 */
import { pool } from "./src/index.js";

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vc_hub_channels (
      id           SERIAL PRIMARY KEY,
      guild_id     TEXT NOT NULL,
      hub_channel_id TEXT NOT NULL UNIQUE,
      category_id  TEXT,
      name_template TEXT NOT NULL DEFAULT '{user}のVC',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS vc_hub_sessions (
      id          SERIAL PRIMARY KEY,
      guild_id    TEXT NOT NULL,
      channel_id  TEXT NOT NULL UNIQUE,
      owner_id    TEXT NOT NULL,
      hub_id      INTEGER NOT NULL REFERENCES vc_hub_channels(id) ON DELETE CASCADE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log("✅ vc_hub migration complete.");
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
