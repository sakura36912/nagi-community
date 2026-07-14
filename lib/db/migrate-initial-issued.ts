import { db } from "./src/index";
import { sql } from "drizzle-orm";

async function migrate() {
  await db.execute(sql`
    ALTER TABLE wallets
    ADD COLUMN IF NOT EXISTS initial_issued_at TIMESTAMPTZ
  `);
  console.log("Migration done.");
}

migrate().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
