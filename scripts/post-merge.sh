#!/bin/bash
set -e

pnpm install --frozen-lockfile

# Rebuild lib/db TypeScript declarations so @workspace/db consumers
# always see up-to-date types after schema changes.
(cd lib/db && npx tsc --build)

pnpm --filter @workspace/db run push-force

# Run any additive SQL migrations that drizzle-kit push does not fully express
# (e.g. partial unique indexes). Each script is idempotent (IF NOT EXISTS).
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS session_key text;
CREATE UNIQUE INDEX IF NOT EXISTS transactions_session_key_idx
  ON transactions (session_key)
  WHERE session_key IS NOT NULL;
ALTER TABLE slot_settings ADD COLUMN IF NOT EXISTS win_rate integer;
CREATE TABLE IF NOT EXISTS casino_play_limits (
  guild_id text NOT NULL,
  game text NOT NULL,
  daily_limit integer NOT NULL,
  PRIMARY KEY (guild_id, game)
);
CREATE TABLE IF NOT EXISTS casino_daily_play_counts (
  guild_id text NOT NULL,
  user_id text NOT NULL,
  game text NOT NULL,
  date text NOT NULL,
  play_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id, game, date)
);
SQL

# Run TypeScript type checks across all workspace packages to catch build breaks early.
pnpm run typecheck
