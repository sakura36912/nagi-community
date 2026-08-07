/**
 * Migration: add chest_opened_at column to vc_presence
 * Run once: tsx lib/db/migrate-treasure-chest.ts
 */
import { db } from "./src/index.js";
import { sql } from "drizzle-orm";

async function main() {
  await db.execute(sql`
    ALTER TABLE vc_presence
      ADD COLUMN IF NOT EXISTS chest_opened_at timestamptz;
  `);
  console.log("✅ chest_opened_at column added to vc_presence");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
