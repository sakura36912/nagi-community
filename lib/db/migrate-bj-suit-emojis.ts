import { db } from "./src/index";
import { sql } from "drizzle-orm";

async function migrate() {
  await db.execute(sql`
    ALTER TABLE guild_settings
    ADD COLUMN IF NOT EXISTS bj_suit_spade   text,
    ADD COLUMN IF NOT EXISTS bj_suit_heart   text,
    ADD COLUMN IF NOT EXISTS bj_suit_diamond text,
    ADD COLUMN IF NOT EXISTS bj_suit_club    text
  `);
  console.log("done");
}

migrate().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
