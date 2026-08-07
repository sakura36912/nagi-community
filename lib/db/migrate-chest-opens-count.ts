/**
 * Migration: add chest_opens_count column to chest_vc_accum
 * Run once: tsx lib/db/migrate-chest-opens-count.ts
 */
import { db } from "./src/index.js";
import { sql } from "drizzle-orm";

async function main() {
  await db.execute(sql`
    ALTER TABLE chest_vc_accum
      ADD COLUMN IF NOT EXISTS chest_opens_count integer NOT NULL DEFAULT 0;
  `);
  console.log("✅ chest_opens_count column added to chest_vc_accum");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
