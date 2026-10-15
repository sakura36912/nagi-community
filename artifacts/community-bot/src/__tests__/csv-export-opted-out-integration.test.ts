/**
 * Integration tests for getAllTempVcDeletions – asymmetric OR-logic.
 *
 * These tests run against the real PostgreSQL database (no mocks) to confirm
 * that the opted_out computed column is true whenever EITHER the global OR the
 * per-guild opt-out source is active — even when the other source is absent or
 * set to false.
 *
 * Tested behaviours:
 *   A. global opted_out=true + per-guild opted_out=false  → optedOut:true
 *   B. per-guild opted_out=true + no global row at all    → optedOut:true
 *
 * Isolation strategy: each test inserts rows under a unique sentinel guild ID
 * and user IDs and deletes them in afterEach.  No real application data is
 * touched or left behind even if a test fails mid-way.
 */

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { getAllTempVcDeletions } from "../lib/community.js";

// ── Isolation constants ───────────────────────────────────────────────────────

/** Sentinel guild used exclusively by these integration tests. */
const GUILD = "test-integ-opted-out-9e3c";

/** User whose only opt-out is global (per-guild row has opted_out=false). */
const USER_GLOBAL_ACTIVE = "test-integ-user-global-9e3c";

/** User whose only opt-out is per-guild (no global row exists). */
const USER_GUILD_ACTIVE = "test-integ-user-guild-9e3c";

// ── Cleanup ───────────────────────────────────────────────────────────────────

async function cleanUp(): Promise<void> {
  await db.execute(
    sql`DELETE FROM community_vc_sessions WHERE guild_id = ${GUILD}`,
  );
  await db.execute(
    sql`DELETE FROM community_vc_privacy WHERE guild_id = ${GUILD}`,
  );
  await db.execute(
    sql`DELETE FROM community_vc_privacy_global
        WHERE user_id IN (${USER_GLOBAL_ACTIVE}, ${USER_GUILD_ACTIVE})`,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("getAllTempVcDeletions – asymmetric OR-logic (integration, real DB)", () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  it(
    "returns optedOut:true when global opted_out=true but per-guild opted_out=false (global source alone wins)",
    async () => {
      // Scenario: user re-opted-in per-guild (opted_out=false) but has not yet
      // cleared their global opt-out row (opted_out=true).
      // DB evaluates: EXISTS(global=true) OR EXISTS(per-guild=false) = true.
      await db.execute(sql`
        INSERT INTO community_vc_sessions (guild_id, user_id, channel_id, joined_at, left_at)
        VALUES (
          ${GUILD}, ${USER_GLOBAL_ACTIVE}, 'ch-integ-1',
          cast(unixepoch('subsec') * 1000000 as integer) - 7200000000,
          cast(unixepoch('subsec') * 1000000 as integer) - 3600000000
        )
      `);
      await db.execute(sql`
        INSERT INTO community_vc_privacy_global (user_id, opted_out, updated_at)
        VALUES (${USER_GLOBAL_ACTIVE}, true, cast(unixepoch('subsec') * 1000000 as integer))
        ON CONFLICT (user_id) DO UPDATE SET opted_out = true, updated_at = cast(unixepoch('subsec') * 1000000 as integer)
      `);
      await db.execute(sql`
        INSERT INTO community_vc_privacy (guild_id, user_id, opted_out, updated_at)
        VALUES (${GUILD}, ${USER_GLOBAL_ACTIVE}, false, cast(unixepoch('subsec') * 1000000 as integer))
        ON CONFLICT (guild_id, user_id) DO UPDATE SET opted_out = false, updated_at = cast(unixepoch('subsec') * 1000000 as integer)
      `);

      const rows = await getAllTempVcDeletions(GUILD);

      const row = rows.find((r) => r.userId === USER_GLOBAL_ACTIVE);
      expect(row, "session row must be present").toBeDefined();
      expect(row?.optedOut).toBe(true);
    },
  );

  it(
    "returns optedOut:true when per-guild opted_out=true and no global row exists (per-guild source alone wins)",
    async () => {
      // Scenario: user set a per-guild opt-out (opted_out=true) but never
      // created a global opt-out row.
      // DB evaluates: EXISTS(global — absent) OR EXISTS(per-guild=true) = true.
      await db.execute(sql`
        INSERT INTO community_vc_sessions (guild_id, user_id, channel_id, joined_at, left_at)
        VALUES (
          ${GUILD}, ${USER_GUILD_ACTIVE}, 'ch-integ-2',
          cast(unixepoch('subsec') * 1000000 as integer) - 7200000000,
          cast(unixepoch('subsec') * 1000000 as integer) - 3600000000
        )
      `);
      // Deliberately no global row for USER_GUILD_ACTIVE.
      await db.execute(sql`
        INSERT INTO community_vc_privacy (guild_id, user_id, opted_out, updated_at)
        VALUES (${GUILD}, ${USER_GUILD_ACTIVE}, true, cast(unixepoch('subsec') * 1000000 as integer))
        ON CONFLICT (guild_id, user_id) DO UPDATE SET opted_out = true, updated_at = cast(unixepoch('subsec') * 1000000 as integer)
      `);

      const rows = await getAllTempVcDeletions(GUILD);

      const row = rows.find((r) => r.userId === USER_GUILD_ACTIVE);
      expect(row, "session row must be present").toBeDefined();
      expect(row?.optedOut).toBe(true);
    },
  );
});
