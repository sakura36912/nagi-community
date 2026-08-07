/**
 * Migration: create chest_vc_accum table
 * Run once: tsx lib/db/migrate-chest-vc-accum.ts
 */
import { db } from "./src/index.js";
import { sql } from "drizzle-orm";

async function main() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS chest_vc_accum (
      guild_id            text        NOT NULL,
      user_id             text        NOT NULL,
      date                text        NOT NULL,
      accumulated_seconds integer     NOT NULL DEFAULT 0,
      chest_opened        boolean     NOT NULL DEFAULT false,
      PRIMARY KEY (guild_id, user_id, date)
    );
  `);
  await db.execute(sql`
    ALTER TABLE chest_vc_accum
      ADD COLUMN IF NOT EXISTS chest_opened boolean NOT NULL DEFAULT false;
  `);
  console.log("✅ chest_vc_accum table created");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
