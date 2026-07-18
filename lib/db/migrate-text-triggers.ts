import { db } from "./src/index";
import { sql } from "drizzle-orm";
async function migrate() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS text_triggers (
      id                serial PRIMARY KEY,
      guild_id          text NOT NULL,
      trigger_text      text NOT NULL,
      watch_channel_id  text,
      notify_channel_id text NOT NULL,
      created_at        timestamptz NOT NULL DEFAULT now()
    )
  `);
  console.log("done");
}
migrate().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
