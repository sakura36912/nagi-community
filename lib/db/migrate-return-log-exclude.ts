import { db } from "./src/index";
import { sql } from "drizzle-orm";
async function migrate() {
  await db.execute(sql`
    ALTER TABLE member_join_history
    ADD COLUMN IF NOT EXISTS excluded text NOT NULL DEFAULT 'false'
  `);
  await db.execute(sql`
    ALTER TABLE guild_settings
    ADD COLUMN IF NOT EXISTS return_log_excluded_role_ids text
  `);
  console.log("done");
}
migrate().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
