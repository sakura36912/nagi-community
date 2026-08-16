/**
 * Migration: add bonus_opens column to chest_cooldown table
 * Run once: tsx lib/db/migrate-chest-bonus-opens.ts
 */
import { db } from "./src/index.js";
import { sql } from "drizzle-orm";

async function main() {
  await db.execute(sql`
    ALTER TABLE chest_cooldown
    ADD COLUMN IF NOT EXISTS bonus_opens INTEGER NOT NULL DEFAULT 0;
  `);
  console.log("✅ bonus_opens column added to chest_cooldown");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
