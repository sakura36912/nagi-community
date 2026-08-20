import { sql } from "drizzle-orm";
import { db } from "./src/index";

// Run with: pnpm --filter @workspace/discord-bot exec tsx ../../lib/db/migrate-slot-win-rate.ts
async function migrate() {
  await db.execute(sql`
    ALTER TABLE slot_settings
    ADD COLUMN IF NOT EXISTS win_rate integer
  `);
  console.log("slot win-rate migration complete");
}

migrate().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});