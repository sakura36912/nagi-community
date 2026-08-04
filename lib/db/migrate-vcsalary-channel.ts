/**
 * Migration: rename vc_reward_settings.included_category_ids → included_channel_ids
 */
import { db } from "./src/index.js";
import { sql } from "drizzle-orm";

async function main() {
  await db.execute(sql`
    ALTER TABLE vc_reward_settings
    ADD COLUMN IF NOT EXISTS included_channel_ids text[] NOT NULL DEFAULT '{}';
  `);

  // Copy existing category IDs across (best-effort; in practice likely empty)
  await db.execute(sql`
    UPDATE vc_reward_settings
    SET included_channel_ids = included_category_ids
    WHERE included_category_ids IS NOT NULL AND array_length(included_category_ids, 1) > 0;
  `);

  await db.execute(sql`
    ALTER TABLE vc_reward_settings
    DROP COLUMN IF EXISTS included_category_ids;
  `);

  console.log("Migration complete: included_category_ids → included_channel_ids");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
