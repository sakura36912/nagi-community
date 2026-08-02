import { db } from "./src";
import { sql } from "drizzle-orm";

await db.execute(sql`
  ALTER TABLE community_sheet_settings
    ADD COLUMN IF NOT EXISTS reminder_days_before integer NOT NULL DEFAULT 0;
`);

console.log("Migration complete: reminder_days_before added to community_sheet_settings.");
await (db.$client as { end(): Promise<void> }).end();
