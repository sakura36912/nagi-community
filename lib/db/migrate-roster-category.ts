import { db } from "./src";
import { sql } from "drizzle-orm";

await db.execute(sql`
  ALTER TABLE community_sheet_settings
  ADD COLUMN IF NOT EXISTS roster_category_id text;
`);

console.log("Migration complete: roster_category_id added to community_sheet_settings.");
await (db.$client as { end(): Promise<void> }).end();
