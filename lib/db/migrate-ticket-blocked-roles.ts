import { db } from "./src";
import { sql } from "drizzle-orm";

await db.execute(sql`
  ALTER TABLE community_ticket_settings
    ADD COLUMN IF NOT EXISTS blocked_role_ids text;
`);

console.log("Migration complete: blocked_role_ids added to community_ticket_settings.");
await (db.$client as { end(): Promise<void> }).end();
