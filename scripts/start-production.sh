#!/usr/bin/env bash
set -e

echo "[start] Starting Discord Bot..."
pnpm --filter @workspace/discord-bot run dev &

echo "[start] Starting Community Bot..."
pnpm --filter @workspace/community-bot run dev &

echo "[start] Starting API Server..."
exec node --enable-source-maps artifacts/api-server/dist/index.mjs
