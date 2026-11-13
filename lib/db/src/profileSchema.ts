import { sql } from "drizzle-orm";
import { db } from "./index";

let ready: Promise<void> | undefined;
export function ensureProfileSchema(): Promise<void> {
  if (!ready) ready = db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('profile-schema'))`);
    await tx.execute(sql`
      CREATE TABLE IF NOT EXISTS profile_settings (
        guild_id text PRIMARY KEY,
        settings jsonb NOT NULL DEFAULT '{}'
      )
    `);
  }).catch(error => { ready = undefined; throw error; });
  return ready;
}
