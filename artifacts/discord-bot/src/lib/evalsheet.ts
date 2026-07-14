import { and, eq, sql } from "drizzle-orm";
import {
  db,
  evalSheetConfigTable,
  evalSheetsTable,
  type EvalSheetConfig,
  type EvalSheet,
} from "@workspace/db";

export const EVAL_SHEET_DEFAULT_DURATION_MS = 14 * 24 * 60 * 60 * 1000; // 2 weeks
export const EVAL_SHEET_EXTEND_DURATION_MS = 7 * 24 * 60 * 60 * 1000;   // 1 week

export async function setEvalSheetConfig(
  guildId: string,
  roleId: string,
  forumChannelId: string,
): Promise<EvalSheetConfig> {
  const [config] = await db
    .insert(evalSheetConfigTable)
    .values({ guildId, roleId, forumChannelId })
    .onConflictDoUpdate({
      target: [evalSheetConfigTable.guildId, evalSheetConfigTable.roleId],
      set: { forumChannelId },
    })
    .returning();

  if (!config) throw new Error("Failed to upsert eval sheet config");
  return config;
}

export async function removeEvalSheetConfig(
  guildId: string,
  roleId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(evalSheetConfigTable)
    .where(
      and(
        eq(evalSheetConfigTable.guildId, guildId),
        eq(evalSheetConfigTable.roleId, roleId),
      ),
    )
    .returning();

  return deleted.length > 0;
}

export async function listEvalSheetConfigs(guildId: string): Promise<EvalSheetConfig[]> {
  return db
    .select()
    .from(evalSheetConfigTable)
    .where(eq(evalSheetConfigTable.guildId, guildId));
}

export async function getEvalSheetConfig(
  guildId: string,
  roleId: string,
): Promise<EvalSheetConfig | undefined> {
  const [config] = await db
    .select()
    .from(evalSheetConfigTable)
    .where(
      and(
        eq(evalSheetConfigTable.guildId, guildId),
        eq(evalSheetConfigTable.roleId, roleId),
      ),
    );

  return config;
}

export async function getEvalSheetConfigsForGuild(guildId: string): Promise<EvalSheetConfig[]> {
  return db
    .select()
    .from(evalSheetConfigTable)
    .where(eq(evalSheetConfigTable.guildId, guildId));
}

// Returns true when the user already has an eval sheet for this role.
export async function hasEvalSheet(
  guildId: string,
  userId: string,
  roleId: string,
): Promise<boolean> {
  const [row] = await db
    .select()
    .from(evalSheetsTable)
    .where(
      and(
        eq(evalSheetsTable.guildId, guildId),
        eq(evalSheetsTable.userId, userId),
        eq(evalSheetsTable.roleId, roleId),
      ),
    );

  return row !== undefined;
}

export async function recordEvalSheet(
  guildId: string,
  userId: string,
  roleId: string,
  threadId: string,
  expiresAt?: Date,
): Promise<EvalSheet> {
  const expiry = expiresAt ?? new Date(Date.now() + EVAL_SHEET_DEFAULT_DURATION_MS);

  const [row] = await db
    .insert(evalSheetsTable)
    .values({ guildId, userId, roleId, threadId, expiresAt: expiry })
    .onConflictDoNothing()
    .returning();

  if (!row) {
    // Row already existed (concurrent insert) — fetch it.
    const [existing] = await db
      .select()
      .from(evalSheetsTable)
      .where(
        and(
          eq(evalSheetsTable.guildId, guildId),
          eq(evalSheetsTable.userId, userId),
          eq(evalSheetsTable.roleId, roleId),
        ),
      );
    if (!existing) throw new Error("Failed to record eval sheet");
    return existing;
  }

  return row;
}

// Returns all active eval sheets for a user in a guild.
export async function getActiveEvalSheets(guildId: string, userId: string): Promise<EvalSheet[]> {
  return db
    .select()
    .from(evalSheetsTable)
    .where(
      and(
        eq(evalSheetsTable.guildId, guildId),
        eq(evalSheetsTable.userId, userId),
      ),
    );
}

// Extends every eval sheet the user has in this guild by the given duration.
// Returns the number of sheets that were extended.
export async function extendEvalSheets(
  guildId: string,
  userId: string,
  durationMs: number,
): Promise<EvalSheet[]> {
  const intervalSql = sql`${Math.floor(durationMs / 1000)} * interval '1 second'`;

  const updated = await db
    .update(evalSheetsTable)
    .set({
      expiresAt: sql`COALESCE(${evalSheetsTable.expiresAt}, now()) + ${intervalSql}`,
    })
    .where(
      and(
        eq(evalSheetsTable.guildId, guildId),
        eq(evalSheetsTable.userId, userId),
      ),
    )
    .returning();

  return updated;
}
