#!/bin/bash
set -e

pnpm install --frozen-lockfile

# Rebuild lib/db TypeScript declarations so @workspace/db consumers
# always see up-to-date types after schema changes.
(cd lib/db && npx tsc --build)

pnpm --filter @workspace/db run push-force

# Run any additive SQL migrations that drizzle-kit push does not fully express
# (e.g. partial unique indexes). Each script is idempotent (IF NOT EXISTS).
pnpm --filter @workspace/db run migrate:vc-reward-session-key

# Run TypeScript type checks across all workspace packages to catch build breaks early.
pnpm run typecheck
