import { sql } from "drizzle-orm";
import { db } from "./src/index";

async function migrate() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS casino_play_limits (
      guild_id text NOT NULL,
      game text NOT NULL,
      daily_limit integer NOT NULL,
      PRIMARY KEY (guild_id, game)
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS casino_daily_play_counts (
      guild_id text NOT NULL,
      user_id text NOT NULL,
      game text NOT NULL,
      date text NOT NULL,
      play_count integer NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id, game, date)
    )
  `);
  console.log("casino daily play-limit migration complete");
}

migrate().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});