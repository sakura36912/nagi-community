import { db } from "./src/index";
import { sql } from "drizzle-orm";
async function migrate() {
  await db.execute(sql`
    ALTER TABLE slot_settings
    ADD COLUMN IF NOT EXISTS sticker_ids text[] NOT NULL DEFAULT '{}'
  `);
  console.log("done");
}
migrate().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
