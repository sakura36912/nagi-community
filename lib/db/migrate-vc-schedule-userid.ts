/**
 * Migration: add user_id and notified_at columns to vc_schedules
 * Run: npx tsx lib/db/migrate-vc-schedule-userid.ts
 */
import { pool } from "./src/index.js";

async function main() {
  await pool.query(`
    ALTER TABLE vc_schedules
      ADD COLUMN IF NOT EXISTS user_id    TEXT,
      ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;
  `);
  console.log("✅ vc_schedules migration complete (user_id, notified_at added).");
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
