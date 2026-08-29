import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  deleteTimedRoleConfigAndGrants,
  getTimedRoleConfigsForRoles,
  pool,
  timedRoleConfigsTable,
  timedRoleGrantsTable,
  upsertTimedRoleConfig,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  scheduleConfiguredTimedRoles,
  scheduleConfiguredTimedRolesIfMissing,
} from "../lib/timedRoleAssignments";

describe("timed role configuration persistence", () => {
  it("persists the duration, schedules from grant time, and cancels pending grants", async () => {
    const guildId = `test-timed-role-${randomUUID()}`;
    const userId = "test-user";
    const roleId = "test-role";
    const grantedAt = new Date("2026-08-29T00:00:00.000Z");

    try {
      await upsertTimedRoleConfig(guildId, roleId, 7_200);
      await expect(getTimedRoleConfigsForRoles(guildId, [roleId])).resolves.toMatchObject([
        { guildId, roleId, durationSeconds: 7_200 },
      ]);

      await expect(
        scheduleConfiguredTimedRoles(guildId, userId, [roleId], grantedAt),
      ).resolves.toBe(1);

      const [grant] = await db
        .select()
        .from(timedRoleGrantsTable)
        .where(
          and(
            eq(timedRoleGrantsTable.guildId, guildId),
            eq(timedRoleGrantsTable.userId, userId),
            eq(timedRoleGrantsTable.roleId, roleId),
          ),
        );
      expect(grant?.expiresAt.toISOString()).toBe("2026-08-29T02:00:00.000Z");

      await expect(
        scheduleConfiguredTimedRolesIfMissing(
          guildId,
          userId,
          [roleId],
          new Date("2026-08-30T00:00:00.000Z"),
        ),
      ).resolves.toBe(0);
      const [unchangedGrant] = await db
        .select()
        .from(timedRoleGrantsTable)
        .where(
          and(
            eq(timedRoleGrantsTable.guildId, guildId),
            eq(timedRoleGrantsTable.userId, userId),
            eq(timedRoleGrantsTable.roleId, roleId),
          ),
        );
      expect(unchangedGrant?.expiresAt.toISOString()).toBe("2026-08-29T02:00:00.000Z");

      await deleteTimedRoleConfigAndGrants(guildId, roleId);
      await expect(getTimedRoleConfigsForRoles(guildId, [roleId])).resolves.toEqual([]);
      const remainingGrants = await db
        .select()
        .from(timedRoleGrantsTable)
        .where(
          and(
            eq(timedRoleGrantsTable.guildId, guildId),
            eq(timedRoleGrantsTable.roleId, roleId),
          ),
        );
      expect(remainingGrants).toEqual([]);
    } finally {
      await db.delete(timedRoleGrantsTable).where(eq(timedRoleGrantsTable.guildId, guildId));
      await db.delete(timedRoleConfigsTable).where(eq(timedRoleConfigsTable.guildId, guildId));
      // Keep the shared pool open for other tests in the same worker.
      void pool;
    }
  });
});