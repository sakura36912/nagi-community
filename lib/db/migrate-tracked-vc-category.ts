/**
 * Migration: tracked_vc_category_id カラムを community_ranking_settings に追加する
 * Run: npx tsx lib/db/migrate-tracked-vc-category.ts
 */
import { db } from "./src/index";
import { sql } from "drizzle-orm";

async function migrate() {
  await db.execute(sql`
    ALTER TABLE community_ranking_settings
    ADD COLUMN IF NOT EXISTS tracked_vc_category_id text
  `);
  console.log("done: tracked_vc_category_id added to community_ranking_settings");
}

migrate().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
