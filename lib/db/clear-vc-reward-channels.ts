import { db, vcRewardSettingsTable } from "./src/index.js";
import { sql } from "drizzle-orm";

async function main() {
  const result = await db
    .update(vcRewardSettingsTable)
    .set({ includedChannelIds: sql`'{}'::text[]` })
    .returning();
  console.log(`Cleared includedChannelIds for ${result.length} guild(s).`);
  for (const r of result) console.log(`  guild=${r.guildId}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
