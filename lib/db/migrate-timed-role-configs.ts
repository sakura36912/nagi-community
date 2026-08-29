import { db } from "./src/index";
import { sql } from "drizzle-orm";

async function migrate() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS timed_role_configs (
      guild_id text NOT NULL,
      role_id text NOT NULL,
      duration_seconds integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (guild_id, role_id)
    )
  `);
  console.log("done");
}

migrate().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});