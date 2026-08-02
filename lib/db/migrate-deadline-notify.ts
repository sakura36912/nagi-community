import { db } from "./src";
import { sql } from "drizzle-orm";

await db.execute(sql`
  ALTER TABLE community_sheet_settings
    ADD COLUMN IF NOT EXISTS deadline_notify_channel_id text,
    ADD COLUMN IF NOT EXISTS deadline_notify_role_id text;
`);

console.log("Migration complete: deadline_notify_channel_id / deadline_notify_role_id added.");
await (db.$client as { end(): Promise<void> }).end();
