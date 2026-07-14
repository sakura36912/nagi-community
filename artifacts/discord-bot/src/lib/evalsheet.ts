import { and, eq } from "drizzle-orm";
import {
  db,
  evalSheetConfigTable,
  evalSheetsTable,
  type EvalSheetConfig,
} from "@workspace/db";

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
): Promise<void> {
  await db
    .insert(evalSheetsTable)
    .values({ guildId, userId, roleId, threadId })
    .onConflictDoNothing();
}
