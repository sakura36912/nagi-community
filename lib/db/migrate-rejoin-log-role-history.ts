import { db } from "./src/index";
import { sql } from "drizzle-orm";

async function migrate() {
  await db.execute(sql`
    ALTER TABLE member_join_history
    ADD COLUMN IF NOT EXISTS left_with_waiting_role boolean,
    ADD COLUMN IF NOT EXISTS left_with_post_island_role boolean,
    ADD COLUMN IF NOT EXISTS left_role_snapshot text
  `);
  console.log("done");
}

migrate().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});