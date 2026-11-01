import { db } from "./src/index";
import { sql } from "drizzle-orm";

async function migrate() {
  await db.execute(sql`
    ALTER TABLE guild_settings
      ADD COLUMN IF NOT EXISTS bj_payout_blackjack double precision NOT NULL DEFAULT 2,
      ADD COLUMN IF NOT EXISTS bj_payout_win double precision NOT NULL DEFAULT 1
  `);
  console.log("Blackjack payout columns ready");
}

migrate().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
