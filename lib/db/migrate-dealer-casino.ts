/**
 * Idempotently create/update the dealer-led casino tables and indexes.
 *
 * Run explicitly with `pnpm --filter @workspace/db exec tsx migrate-dealer-casino.ts`.
 * The shared transactions.session_key column/index is provisioned idempotently
 * because dealer-casino ledger entries use it as an idempotency key.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "./src/index.js";

const statements = [
  `ALTER TABLE transactions
    ADD COLUMN IF NOT EXISTS session_key text`,
  `DO $dealer_casino$ DECLARE
    existing_unique boolean;
    existing_predicate text;
    existing_definition text;
  BEGIN
    SELECT i.indisunique, pg_get_expr(i.indpred, i.indrelid), pg_get_indexdef(i.indexrelid)
      INTO existing_unique, existing_predicate, existing_definition
    FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_class tbl ON tbl.oid = i.indrelid
    WHERE idx.relname = 'transactions_session_key_idx'
      AND tbl.relname = 'transactions'
      AND tbl.relnamespace = current_schema()::regnamespace;
    IF FOUND AND (
      existing_unique IS DISTINCT FROM true OR
      regexp_replace(lower(coalesce(existing_predicate, '')), '[[:space:]()]', '', 'g')
        <> 'session_keyisnotnull' OR
      position('(session_key)' in lower(coalesce(existing_definition, ''))) = 0
    ) THEN
      RAISE EXCEPTION 'transactions_session_key_idx exists with an incompatible definition';
    END IF;
  END; $dealer_casino$`,
  `CREATE UNIQUE INDEX IF NOT EXISTS transactions_session_key_idx
    ON transactions (session_key)
    WHERE session_key IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS dealer_casino_settings (
    guild_id text PRIMARY KEY,
    min_bet integer NOT NULL DEFAULT 1000,
    max_bet integer NOT NULL DEFAULT 10000,
    voice_channel_id text,
    dealer_role_id text,
    director_role_id text,
    admin_role_id text,
    log_channel_id text,
    max_players integer,
    chohan_multipliers jsonb,
    chohan_max_streak_multiplier numeric(12, 6),
    streak_retention_seconds integer,
    poker_base_multiplier numeric(12, 6),
    poker_bonus_enabled integer,
    poker_bonus_multipliers jsonb,
    poker_dealer_qualification_enabled integer,
    poker_dealer_qualification_rank text,
    poker_dealer_minimum_high_card integer,
    poker_ace_low_enabled integer,
    poker_timeout_seconds integer NOT NULL DEFAULT 60,
    chohan_enabled integer,
    poker_enabled integer,
    activity_points_per_game integer
  )`,
  `ALTER TABLE dealer_casino_settings
    ADD COLUMN IF NOT EXISTS activity_points_per_game integer`,
  `ALTER TABLE dealer_casino_settings ADD COLUMN IF NOT EXISTS min_bet integer NOT NULL DEFAULT 1000`,
  `ALTER TABLE dealer_casino_settings ADD COLUMN IF NOT EXISTS max_bet integer NOT NULL DEFAULT 10000`,
  `ALTER TABLE dealer_casino_settings ADD COLUMN IF NOT EXISTS voice_channel_id text`,
  `ALTER TABLE dealer_casino_settings ADD COLUMN IF NOT EXISTS dealer_role_id text`,
  `ALTER TABLE dealer_casino_settings ADD COLUMN IF NOT EXISTS director_role_id text`,
  `ALTER TABLE dealer_casino_settings ADD COLUMN IF NOT EXISTS admin_role_id text`,
  `ALTER TABLE dealer_casino_settings ADD COLUMN IF NOT EXISTS log_channel_id text`,
  `ALTER TABLE dealer_casino_settings ADD COLUMN IF NOT EXISTS max_players integer`,
  `ALTER TABLE dealer_casino_settings ADD COLUMN IF NOT EXISTS chohan_multipliers jsonb`,
  `ALTER TABLE dealer_casino_settings ADD COLUMN IF NOT EXISTS chohan_max_streak_multiplier numeric(12, 6)`,
  `ALTER TABLE dealer_casino_settings ADD COLUMN IF NOT EXISTS streak_retention_seconds integer`,
  `ALTER TABLE dealer_casino_settings ADD COLUMN IF NOT EXISTS poker_base_multiplier numeric(12, 6)`,
  `ALTER TABLE dealer_casino_settings ADD COLUMN IF NOT EXISTS poker_bonus_enabled integer`,
  `ALTER TABLE dealer_casino_settings ADD COLUMN IF NOT EXISTS poker_bonus_multipliers jsonb`,
  `ALTER TABLE dealer_casino_settings ADD COLUMN IF NOT EXISTS poker_dealer_qualification_enabled integer`,
  `ALTER TABLE dealer_casino_settings ADD COLUMN IF NOT EXISTS poker_dealer_qualification_rank text`,
  `ALTER TABLE dealer_casino_settings ADD COLUMN IF NOT EXISTS poker_ace_low_enabled integer`,
  `ALTER TABLE dealer_casino_settings ADD COLUMN IF NOT EXISTS poker_timeout_seconds integer NOT NULL DEFAULT 60`,
  `ALTER TABLE dealer_casino_settings ADD COLUMN IF NOT EXISTS chohan_enabled integer`,
  `ALTER TABLE dealer_casino_settings ADD COLUMN IF NOT EXISTS poker_enabled integer`,
  `ALTER TABLE dealer_casino_settings
    ADD COLUMN IF NOT EXISTS poker_dealer_minimum_high_card integer`,
  `DO $dealer_casino$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'dealer_casino_settings_minimum_high_card_check'
        AND conrelid = 'dealer_casino_settings'::regclass
    ) THEN
      ALTER TABLE dealer_casino_settings
        ADD CONSTRAINT dealer_casino_settings_minimum_high_card_check
        CHECK (
          poker_dealer_minimum_high_card IS NULL OR
          poker_dealer_minimum_high_card BETWEEN 2 AND 14
        );
    END IF;
  END; $dealer_casino$`,
  `ALTER TABLE dealer_casino_settings
    ALTER COLUMN chohan_max_streak_multiplier TYPE numeric(12, 6)
      USING chohan_max_streak_multiplier::numeric(12, 6)`,
  `ALTER TABLE dealer_casino_settings
    ALTER COLUMN poker_base_multiplier TYPE numeric(12, 6)
      USING poker_base_multiplier::numeric(12, 6)`,

  `CREATE TABLE IF NOT EXISTS dealer_casino_games (
    id serial PRIMARY KEY,
    guild_id text NOT NULL,
    game_type text NOT NULL,
    dealer_id text NOT NULL,
    channel_id text NOT NULL,
    voice_channel_id text NOT NULL,
    panel_message_id text,
    state text NOT NULL DEFAULT 'RECRUITING',
    result jsonb,
    dealer_cards jsonb,
    action_deadline timestamptz,
    session_ended integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz,
    CONSTRAINT dealer_casino_games_type_check CHECK (game_type IN ('chohan', 'poker')),
    CONSTRAINT dealer_casino_games_state_check CHECK (
      state IN ('RECRUITING', 'CLOSED', 'PLAYING', 'RESULT', 'PAYOUT', 'FINISHED', 'CANCELLED')
    ),
    CONSTRAINT dealer_casino_games_session_ended_check CHECK (session_ended IN (0, 1))
  )`,
  `ALTER TABLE dealer_casino_games
    ADD COLUMN IF NOT EXISTS dealer_cards jsonb`,
  `ALTER TABLE dealer_casino_games
    ADD COLUMN IF NOT EXISTS action_deadline timestamptz`,
  `ALTER TABLE dealer_casino_games
    ADD COLUMN IF NOT EXISTS session_ended integer NOT NULL DEFAULT 0`,
  `ALTER TABLE dealer_casino_games ADD COLUMN IF NOT EXISTS result jsonb`,
  `ALTER TABLE dealer_casino_games ADD COLUMN IF NOT EXISTS panel_message_id text`,
  `ALTER TABLE dealer_casino_games ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'RECRUITING'`,
  `ALTER TABLE dealer_casino_games ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`,
  `ALTER TABLE dealer_casino_games ADD COLUMN IF NOT EXISTS ended_at timestamptz`,
  `DO $dealer_casino$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'dealer_casino_games_type_check'
        AND conrelid = 'dealer_casino_games'::regclass
    ) THEN
      ALTER TABLE dealer_casino_games
        ADD CONSTRAINT dealer_casino_games_type_check
        CHECK (game_type IN ('chohan', 'poker'));
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'dealer_casino_games_state_check'
        AND conrelid = 'dealer_casino_games'::regclass
    ) THEN
      ALTER TABLE dealer_casino_games
        ADD CONSTRAINT dealer_casino_games_state_check
        CHECK (state IN ('RECRUITING', 'CLOSED', 'PLAYING', 'RESULT', 'PAYOUT', 'FINISHED', 'CANCELLED'));
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'dealer_casino_games_session_ended_check'
        AND conrelid = 'dealer_casino_games'::regclass
    ) THEN
      ALTER TABLE dealer_casino_games
        ADD CONSTRAINT dealer_casino_games_session_ended_check
        CHECK (session_ended IN (0, 1));
    END IF;
  END; $dealer_casino$`,
  `DO $dealer_casino$ DECLARE
    existing_unique boolean;
    existing_predicate text;
    normalized_predicate text;
    existing_definition text;
  BEGIN
    SELECT i.indisunique, pg_get_expr(i.indpred, i.indrelid), pg_get_indexdef(i.indexrelid)
      INTO existing_unique, existing_predicate, existing_definition
    FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_class tbl ON tbl.oid = i.indrelid
    WHERE idx.relname = 'dealer_casino_one_active_game_per_guild'
      AND tbl.relname = 'dealer_casino_games'
      AND tbl.relnamespace = current_schema()::regnamespace;
    IF FOUND THEN
      normalized_predicate := regexp_replace(
        lower(existing_predicate),
        '[[:space:]()]|::text(\[\])?',
        '',
        'g'
      );
      IF existing_unique IS DISTINCT FROM true OR existing_predicate IS NULL OR
         normalized_predicate <> 'state=anyarray[''recruiting'',''closed'',''playing'',''result'',''payout'']' OR
         position('(guild_id)' in lower(coalesce(existing_definition, ''))) = 0 THEN
        RAISE EXCEPTION 'dealer_casino_one_active_game_per_guild has an incompatible definition';
      END IF;
    END IF;
  END; $dealer_casino$`,
  `CREATE UNIQUE INDEX IF NOT EXISTS dealer_casino_one_active_game_per_guild
    ON dealer_casino_games (guild_id)
    WHERE state IN ('RECRUITING', 'CLOSED', 'PLAYING', 'RESULT', 'PAYOUT')`,
  `CREATE INDEX IF NOT EXISTS dealer_casino_games_guild_created_idx
    ON dealer_casino_games (guild_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS dealer_casino_bets (
    id serial PRIMARY KEY,
    game_id integer NOT NULL,
    user_id text NOT NULL,
    bet_amount integer NOT NULL,
    choice text,
    state text NOT NULL DEFAULT 'ACTIVE',
    cards jsonb,
    hand_rank text,
    player_action text,
    result text,
    payout integer NOT NULL DEFAULT 0,
    win_streak integer,
    multiplier numeric(12, 6),
    bet_revision integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT dealer_casino_bets_game_id_dealer_casino_games_id_fk
      FOREIGN KEY (game_id) REFERENCES dealer_casino_games (id) ON DELETE CASCADE,
    CONSTRAINT dealer_casino_bets_amount_check CHECK (bet_amount > 0),
    CONSTRAINT dealer_casino_bets_state_check CHECK (
      state IN ('ACTIVE', 'FOLDED', 'WON', 'LOST', 'DRAW', 'REFUNDED')
    ),
    CONSTRAINT dealer_casino_bets_game_user_unique UNIQUE (game_id, user_id)
  )`,
  `ALTER TABLE dealer_casino_bets ADD COLUMN IF NOT EXISTS choice text`,
  `ALTER TABLE dealer_casino_bets ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'ACTIVE'`,
  `ALTER TABLE dealer_casino_bets ADD COLUMN IF NOT EXISTS cards jsonb`,
  `ALTER TABLE dealer_casino_bets ADD COLUMN IF NOT EXISTS hand_rank text`,
  `ALTER TABLE dealer_casino_bets ADD COLUMN IF NOT EXISTS player_action text`,
  `ALTER TABLE dealer_casino_bets ADD COLUMN IF NOT EXISTS result text`,
  `ALTER TABLE dealer_casino_bets ADD COLUMN IF NOT EXISTS payout integer NOT NULL DEFAULT 0`,
  `ALTER TABLE dealer_casino_bets ADD COLUMN IF NOT EXISTS win_streak integer`,
  `ALTER TABLE dealer_casino_bets ADD COLUMN IF NOT EXISTS multiplier numeric(12, 6)`,
  `ALTER TABLE dealer_casino_bets ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`,
  `ALTER TABLE dealer_casino_bets
    ADD COLUMN IF NOT EXISTS bet_revision integer NOT NULL DEFAULT 0`,
  `DO $dealer_casino$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'dealer_casino_bets_amount_check'
        AND conrelid = 'dealer_casino_bets'::regclass
    ) THEN
      ALTER TABLE dealer_casino_bets
        ADD CONSTRAINT dealer_casino_bets_amount_check CHECK (bet_amount > 0);
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'dealer_casino_bets_state_check'
        AND conrelid = 'dealer_casino_bets'::regclass
    ) THEN
      ALTER TABLE dealer_casino_bets
        ADD CONSTRAINT dealer_casino_bets_state_check
        CHECK (state IN ('ACTIVE', 'FOLDED', 'WON', 'LOST', 'DRAW', 'REFUNDED'));
    END IF;
  END; $dealer_casino$`,
  `ALTER TABLE dealer_casino_bets
    ALTER COLUMN multiplier TYPE numeric(12, 6)
      USING multiplier::numeric(12, 6)`,
  `CREATE INDEX IF NOT EXISTS dealer_casino_bets_game_idx
    ON dealer_casino_bets (game_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS dealer_casino_bets_game_user_unique
    ON dealer_casino_bets (game_id, user_id)`,

  `CREATE TABLE IF NOT EXISTS dealer_casino_streaks (
    guild_id text NOT NULL,
    user_id text NOT NULL,
    win_streak integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT dealer_casino_streaks_count_check CHECK (win_streak >= 0),
    CONSTRAINT dealer_casino_streaks_guild_user_unique UNIQUE (guild_id, user_id)
  )`,
  `ALTER TABLE dealer_casino_streaks ADD COLUMN IF NOT EXISTS win_streak integer NOT NULL DEFAULT 0`,
  `ALTER TABLE dealer_casino_streaks ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`,
  `DO $dealer_casino$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'dealer_casino_streaks_count_check'
        AND conrelid = 'dealer_casino_streaks'::regclass
    ) THEN
      ALTER TABLE dealer_casino_streaks
        ADD CONSTRAINT dealer_casino_streaks_count_check CHECK (win_streak >= 0);
    END IF;
  END; $dealer_casino$`,
  `CREATE UNIQUE INDEX IF NOT EXISTS dealer_casino_streaks_guild_user_unique
    ON dealer_casino_streaks (guild_id, user_id)`,

  `CREATE TABLE IF NOT EXISTS dealer_casino_stats (
    guild_id text NOT NULL,
    user_id text NOT NULL,
    chohan_games integer NOT NULL DEFAULT 0,
    poker_games integer NOT NULL DEFAULT 0,
    players_served integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT dealer_casino_stats_guild_user_unique UNIQUE (guild_id, user_id)
  )`,
  `ALTER TABLE dealer_casino_stats ADD COLUMN IF NOT EXISTS chohan_games integer NOT NULL DEFAULT 0`,
  `ALTER TABLE dealer_casino_stats ADD COLUMN IF NOT EXISTS poker_games integer NOT NULL DEFAULT 0`,
  `ALTER TABLE dealer_casino_stats ADD COLUMN IF NOT EXISTS players_served integer NOT NULL DEFAULT 0`,
  `ALTER TABLE dealer_casino_stats ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`,
  `CREATE UNIQUE INDEX IF NOT EXISTS dealer_casino_stats_guild_user_unique
    ON dealer_casino_stats (guild_id, user_id)`,

  `CREATE TABLE IF NOT EXISTS dealer_casino_settlements (
    id serial PRIMARY KEY,
    game_id integer NOT NULL,
    user_id text NOT NULL,
    bet_id integer NOT NULL,
    payout integer NOT NULL,
    result text NOT NULL,
    streak_updated integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT dealer_casino_settlements_game_id_dealer_casino_games_id_fk
      FOREIGN KEY (game_id) REFERENCES dealer_casino_games (id) ON DELETE CASCADE,
    CONSTRAINT dealer_casino_settlements_bet_id_dealer_casino_bets_id_fk
      FOREIGN KEY (bet_id) REFERENCES dealer_casino_bets (id) ON DELETE CASCADE,
    CONSTRAINT dealer_casino_settlements_game_user_unique UNIQUE (game_id, user_id)
  )`,
  `ALTER TABLE dealer_casino_settlements
    ADD COLUMN IF NOT EXISTS streak_updated integer NOT NULL DEFAULT 0`,
  `ALTER TABLE dealer_casino_settlements
    ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`,
  `CREATE UNIQUE INDEX IF NOT EXISTS dealer_casino_settlements_game_user_unique
    ON dealer_casino_settlements (game_id, user_id)`,
  `CREATE INDEX IF NOT EXISTS dealer_casino_settlements_game_idx
    ON dealer_casino_settlements (game_id)`,
] as const;

async function main(): Promise<void> {
  await db.transaction(async (tx) => {
    for (const statement of statements) {
      await tx.execute(sql.raw(statement));
    }
  });
  console.info("Dealer casino schema migration completed.");
}

main()
  .catch(() => {
    // Do not echo connection details or other potentially sensitive DB errors.
    console.error("Dealer casino schema migration failed.");
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });