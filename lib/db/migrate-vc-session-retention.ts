import { db } from "./src/index";
import { sql } from "drizzle-orm";
async function migrate() {
  await db.execute(sql`
    ALTER TABLE community_ranking_settings
    ADD COLUMN IF NOT EXISTS vc_session_retention_days integer
  `);
  console.log("done");
}
migrate().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
