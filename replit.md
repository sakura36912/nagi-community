# 通貨Bot (Discord Economy Bot)

A Discord bot that gives each server its own virtual currency ("円") economy — daily rewards, peer-to-peer payments, a leaderboard, and a shop.

## Run & Operate

- `pnpm --filter @workspace/discord-bot run dev` — run the Discord bot (workflow: "Discord Bot")
- `pnpm --filter @workspace/discord-bot exec tsx src/deploy-commands.ts` — (re)register global slash commands after changing command definitions; can take up to an hour to propagate
- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000, currently unused by the bot)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required secrets: `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID` — from the Discord Developer Portal application

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Discord: discord.js v14 (slash commands), plain `tsx` dev process (no bundler)

## Where things live

- `artifacts/discord-bot/src/index.ts` — bot client login and interaction dispatch
- `artifacts/discord-bot/src/deploy-commands.ts` — one-off script to register global slash commands
- `artifacts/discord-bot/src/commands/index.ts` — all slash command definitions and handlers
- `artifacts/discord-bot/src/lib/economy.ts` — wallet/shop/transaction business logic (source of truth for balance math)
- `lib/db/src/schema/economy.ts` — DB schema: `wallets`, `shop_items`, `inventory_items`, `transactions` (all scoped per `guild_id`)
- `artifacts/api-server` — shared Express API scaffold, not currently used by the bot

## Architecture decisions

- The bot talks to Postgres directly via `@workspace/db` instead of going through the API server — there is no web frontend involved, so the extra HTTP hop added no value.
- Currency is per-guild: every table is keyed by `(guild_id, user_id)` so balances don't leak across servers.
- All balance-changing operations (`daily`, `pay`, `shop buy`) use conditional `UPDATE ... WHERE balance >= amount` statements (checked via `returning()` row presence) inside a transaction, rather than read-then-write, to stay correct under concurrent commands.
- Slash commands are registered globally (`deploy-commands.ts` via `applicationCommands`), not per-guild — simpler ops, at the cost of up to ~1 hour propagation delay after command changes.

## Product

- `/currency create <name> [daily_amount]` — server admins name their own currency and set the daily reward amount (defaults: "円" / 500)
- `/currency info` — show the server's current currency name and daily amount
- `/balance [user]` — check your or someone else's balance
- `/daily` — claim a daily currency reward (24h cooldown)
- `/pay <user> <amount>` — send currency to another member
- `/give <user> <amount>` — admins grant (or claw back with a negative amount) currency directly
- `/leaderboard` — top 10 balances in the server
- `/shop list|buy|inventory` — browse, purchase, and view owned items
- `/shop add|remove` — server admins (Manage Server permission) manage the shop catalog

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- After changing any slash command definition in `commands/index.ts`, re-run `pnpm --filter @workspace/discord-bot exec tsx src/deploy-commands.ts` — the running bot process does not auto-register command changes with Discord.
- Global slash command updates can take up to an hour to show up in Discord clients.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
