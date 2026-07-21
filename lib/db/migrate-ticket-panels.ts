import pg from "pg";
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

await pool.query(`
  CREATE TABLE IF NOT EXISTS community_ticket_panels (
    id                 SERIAL PRIMARY KEY,
    guild_id           TEXT NOT NULL,
    name               TEXT NOT NULL,
    panel_title        TEXT,
    panel_description  TEXT,
    panel_button_label TEXT,
    panel_button_style INTEGER,
    panel_button_emoji TEXT,
    welcome_message    TEXT,
    welcome_embed_title TEXT,
    welcome_embed_color TEXT,
    close_button_label  TEXT,
    close_button_style  INTEGER,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`);
console.log("✅ community_ticket_panels table created.");
await pool.end();
