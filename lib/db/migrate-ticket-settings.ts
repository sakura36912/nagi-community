import pg from "pg";
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

await pool.query(`
  ALTER TABLE community_ticket_settings
    ADD COLUMN IF NOT EXISTS panel_button_style   INTEGER,
    ADD COLUMN IF NOT EXISTS panel_button_emoji   TEXT,
    ADD COLUMN IF NOT EXISTS welcome_embed_title  TEXT,
    ADD COLUMN IF NOT EXISTS welcome_embed_color  TEXT,
    ADD COLUMN IF NOT EXISTS category_id          TEXT,
    ADD COLUMN IF NOT EXISTS channel_name_prefix  TEXT,
    ADD COLUMN IF NOT EXISTS mention_user         BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS mention_staff        BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS close_button_label   TEXT,
    ADD COLUMN IF NOT EXISTS close_button_style   INTEGER;
`);
console.log("✅ community_ticket_settings columns added.");
await pool.end();
