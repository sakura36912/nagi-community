import { sql } from "drizzle-orm";
import { db } from "./src/index.js";

async function main() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS periodic_messages (
      id SERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message TEXT NOT NULL,
      interval_hours INTEGER NOT NULL DEFAULT 24,
      last_posted_at TIMESTAMPTZ,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  console.log("periodic_messages table created.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
