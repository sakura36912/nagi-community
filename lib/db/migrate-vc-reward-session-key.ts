/**
 * Migration: add session_key to the transactions table.
 *
 * session_key is a nullable unique text column used as an idempotency guard
 * for automated payouts (VC salary, Hub salary, etc.).  If a duplicate leave
 * event fires, the second INSERT with the same key is silently ignored via
 * ON CONFLICT DO NOTHING, preventing double-credit.
 *
 * NULL values are exempt from the uniqueness check (PostgreSQL treats each
 * NULL as distinct), so manually created transactions are unaffected.
 */
import { db } from "./src/index.js";
import { sql } from "drizzle-orm";

async function main() {
  await db.execute(sql`
    ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS session_key text;
  `);

  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS transactions_session_key_idx
    ON transactions (session_key)
    WHERE session_key IS NOT NULL;
  `);

  console.log("Migration complete: transactions.session_key added with partial unique index");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
