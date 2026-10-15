/**
 * Integration tests for getSchedulesExpiringSoon.
 *
 * These run against the real PostgreSQL database so that the actual SQL
 * filtering (gt / lte / isNull) is exercised with rows at controlled times.
 * No mocking of lib/vc or @workspace/db — the full stack from TS helper →
 * Drizzle query → Postgres is exercised.
 *
 * A unique guild ID is used so these tests don't touch any real data.
 * Rows are cleaned up in afterEach so tests are fully isolated.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, vcSchedulesTable } from "@workspace/db";
import { getSchedulesExpiringSoon } from "../lib/vc.js";

// ── Sentinel guild ID ─────────────────────────────────────────────────────────
// Unique prefix prevents any collision with real guild IDs.
const TEST_GUILD = "test-custom-lead-time-guild";

// ── Helpers ───────────────────────────────────────────────────────────────────

let channelSeq = 0;
function nextChannelId() {
  return `test-ch-${++channelSeq}`;
}

async function insertSchedule(opts: {
  expiresAt: Date;
  notifiedAt?: Date | null;
  channelId?: string;
}) {
  const channelId = opts.channelId ?? nextChannelId();
  await db.insert(vcSchedulesTable).values({
    guildId: TEST_GUILD,
    channelId,
    channelName: "テストVC",
    expiresAt: opts.expiresAt,
    notifiedAt: opts.notifiedAt ?? null,
  });
  return channelId;
}

async function cleanup() {
  await db
    .delete(vcSchedulesTable)
    .where(eq(vcSchedulesTable.guildId, TEST_GUILD));
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

beforeEach(cleanup);
afterEach(cleanup);
afterAll(() => pool.close());

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("getSchedulesExpiringSoon – real DB timing filter (30-minute custom lead time)", () => {
  it("returns a schedule expiring in 25 min when the warn window is 30 min", async () => {
    // Schedule expires 25 minutes from now → inside the 30-min window.
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 25 * 60 * 1000);
    await insertSchedule({ expiresAt });

    const warnBeforeMs = 30 * 60 * 1000;
    const results = await getSchedulesExpiringSoon(TEST_GUILD, now, warnBeforeMs);

    expect(results).toHaveLength(1);
    expect(results[0]!.guildId).toBe(TEST_GUILD);
    // expiresAt round-trips through Postgres as a Date, so compare ms.
    expect(results[0]!.expiresAt.getTime()).toBeCloseTo(expiresAt.getTime(), -3);
  });

  it("does NOT return a schedule expiring in 35 min when the warn window is 30 min", async () => {
    // Schedule expires 35 minutes from now → outside the 30-min window.
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 35 * 60 * 1000);
    await insertSchedule({ expiresAt });

    const warnBeforeMs = 30 * 60 * 1000;
    const results = await getSchedulesExpiringSoon(TEST_GUILD, now, warnBeforeMs);

    expect(results).toHaveLength(0);
  });

  it("does NOT return an already-expired schedule (expiresAt in the past)", async () => {
    // Already expired — the gt(expiresAt, now) guard must filter it out.
    const now = new Date();
    const expiresAt = new Date(now.getTime() - 5 * 60 * 1000);
    await insertSchedule({ expiresAt });

    const warnBeforeMs = 30 * 60 * 1000;
    const results = await getSchedulesExpiringSoon(TEST_GUILD, now, warnBeforeMs);

    expect(results).toHaveLength(0);
  });

  it("does NOT return an already-notified schedule even if it falls within the window", async () => {
    // notifiedAt is set — isNull guard must exclude it.
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 20 * 60 * 1000);
    await insertSchedule({ expiresAt, notifiedAt: new Date(now.getTime() - 2 * 60 * 1000) });

    const warnBeforeMs = 30 * 60 * 1000;
    const results = await getSchedulesExpiringSoon(TEST_GUILD, now, warnBeforeMs);

    expect(results).toHaveLength(0);
  });

  it("returns only the un-notified schedule when both a notified and an un-notified one fall within the window", async () => {
    const now = new Date();
    const warnBeforeMs = 30 * 60 * 1000;

    // Both schedules expire within the 30-min window.
    const notifiedChannelId = await insertSchedule({
      expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
      notifiedAt: new Date(now.getTime() - 1 * 60 * 1000),
    });
    const unnotifiedChannelId = await insertSchedule({
      expiresAt: new Date(now.getTime() + 15 * 60 * 1000),
    });

    const results = await getSchedulesExpiringSoon(TEST_GUILD, now, warnBeforeMs);

    expect(results).toHaveLength(1);
    expect(results[0]!.channelId).toBe(unnotifiedChannelId);
    expect(results.map((r) => r.channelId)).not.toContain(notifiedChannelId);
  });

  it("is scoped to the specified guild — schedules from other guilds are not returned", async () => {
    const now = new Date();
    const warnBeforeMs = 30 * 60 * 1000;

    // Insert a schedule for a different guild using the same channel-ID namespace.
    const otherChannelId = nextChannelId();
    await db.insert(vcSchedulesTable).values({
      guildId: "other-guild-entirely",
      channelId: otherChannelId,
      channelName: "外部VC",
      expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
    });

    try {
      const results = await getSchedulesExpiringSoon(TEST_GUILD, now, warnBeforeMs);
      expect(results).toHaveLength(0);
    } finally {
      // Clean up the other-guild row (not covered by the TEST_GUILD cleanup).
      await db
        .delete(vcSchedulesTable)
        .where(eq(vcSchedulesTable.channelId, otherChannelId));
    }
  });

  it("returns a schedule expiring exactly at the window boundary (lte boundary: expiresAt == now + warnBeforeMs)", async () => {
    // getSchedulesExpiringSoon uses lte(expiresAt, notifyWindow) where
    // notifyWindow = new Date(now.getTime() + warnBeforeMs).
    // Setting expiresAt = now + warnBeforeMs should satisfy the lte condition (equality).
    const now = new Date();
    const warnBeforeMs = 30 * 60 * 1000;
    const expiresAt = new Date(now.getTime() + warnBeforeMs); // exactly at notifyWindow
    await insertSchedule({ expiresAt });

    // Pass the same `now` that was used to compute expiresAt so the DB sees
    // notifyWindow = expiresAt, satisfying the lte boundary condition.
    const results = await getSchedulesExpiringSoon(TEST_GUILD, now, warnBeforeMs);

    expect(results).toHaveLength(1);
  });
});
