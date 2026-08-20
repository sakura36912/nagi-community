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
SQL

# Run TypeScript type checks across all workspace packages to catch build breaks early.
pnpm run typecheck
