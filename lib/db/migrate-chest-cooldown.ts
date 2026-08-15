/**
 * Migration: create chest_cooldown table
 * Redesign: per-open 60-min cooldown instead of cumulative VC hours.
 * Run once: tsx lib/db/migrate-chest-cooldown.ts
 */
import { db } from "./src/index.js";
import { sql } from "drizzle-orm";

async function main() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS chest_cooldown (
      guild_id            TEXT    NOT NULL,
      user_id             TEXT    NOT NULL,
      chest_type          TEXT    NOT NULL,
      last_open_vc_seconds INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id, chest_type)
    );
  `);
  console.log("✅ chest_cooldown table created");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
