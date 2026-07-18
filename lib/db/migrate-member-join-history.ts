import { db } from "./src/index";
import { sql } from "drizzle-orm";
async function migrate() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS member_join_history (
      id          serial PRIMARY KEY,
      guild_id    text NOT NULL,
      user_id     text NOT NULL,
      joined_at   timestamptz NOT NULL DEFAULT now(),
      left_at     timestamptz
    )
  `);
  await db.execute(sql`
    ALTER TABLE guild_settings
    ADD COLUMN IF NOT EXISTS return_log_channel_id text
  `);
  console.log("done");
}
migrate().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
