/**
 * Migration: add is_privacy_closed column to community_vc_sessions
 *
 * Marks sessions that were closed by a privacy opt-out event
 * (setVcPrivacyOptOut / setVcGlobalPrivacyOptOut) so that getVcRanking can
 * permanently exclude them even after the user re-opts-in, preventing
 * pre-opt-out time from leaking back into the ranking.
 *
 * Run: npx tsx lib/db/migrate-vc-privacy-closed.ts
 */
import { db } from "./src/index";
import { sql } from "drizzle-orm";

async function migrate() {
  await db.execute(sql`
    ALTER TABLE community_vc_sessions
    ADD COLUMN IF NOT EXISTS is_privacy_closed boolean NOT NULL DEFAULT false
  `);
  console.log("Migration complete: community_vc_sessions.is_privacy_closed added.");
}

migrate().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
