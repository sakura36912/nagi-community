import { db } from "./src/index";
import { sql } from "drizzle-orm";
async function migrate() {
  await db.execute(sql`
    ALTER TABLE community_sheets
    ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz
  `);
  console.log("done");
}
migrate().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
