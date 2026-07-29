import { db } from "./src/index";
import { sql } from "drizzle-orm";

async function migrate() {
  await db.execute(sql`
    ALTER TABLE guild_settings
    ADD COLUMN IF NOT EXISTS vc_warn_before_minutes integer NOT NULL DEFAULT 10
  `);
  console.log("done");
}

migrate().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
