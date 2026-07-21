import { db } from "./src/index.js";
import { sql } from "drizzle-orm";

async function main() {
  await db.execute(sql`
    ALTER TABLE shift_settings
    ADD COLUMN IF NOT EXISTS submit_role_ids TEXT[] NOT NULL DEFAULT '{}'
  `);
  console.log("Done: submit_role_ids added to shift_settings");
}

main().catch((e) => { console.error(e); process.exit(1); });
