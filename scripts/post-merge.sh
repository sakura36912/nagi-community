#!/bin/bash
set -e

pnpm install --frozen-lockfile

# Rebuild lib/db TypeScript declarations so @workspace/db consumers
# always see up-to-date types after schema changes.
(cd lib/db && npx tsc --build)

pnpm --filter @workspace/db run push-force
