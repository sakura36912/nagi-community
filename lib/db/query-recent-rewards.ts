import { db } from "./src/index.js";
import { sql } from "drizzle-orm";

async function main() {
  const result = await db.execute(sql`
    SELECT guild_id, user_id, amount, reason, created_at
    FROM transactions
    WHERE reason = 'auto-reward'
    ORDER BY created_at DESC
    LIMIT 20
  `);
  const rows = result.rows ?? result;
  for (const r of rows as any[]) {
    console.log(`${r.created_at} | guild=${r.guild_id} | user=${r.user_id} | +${r.amount}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
