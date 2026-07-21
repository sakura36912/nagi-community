import pg from "pg";
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

await pool.query(`
  ALTER TABLE community_ticket_panels
    ADD COLUMN IF NOT EXISTS mention_role_ids TEXT[];
`);
console.log("✅ mention_role_ids column added to community_ticket_panels.");
await pool.end();
