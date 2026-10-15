import { and, eq } from "drizzle-orm";
import { db, textTriggersTable, type TextTrigger } from "@workspace/db";

export type { TextTrigger };

export async function addTextTrigger(
  guildId: string,
  triggerText: string,
  notifyChannelId: string,
  watchChannelId: string | null,
): Promise<TextTrigger> {
  const [row] = await db
    .insert(textTriggersTable)
    .values({ guildId, triggerText, notifyChannelId, watchChannelId })
    .returning();
  if (!row) throw new Error("Failed to insert text_trigger");
  return row;
}

export async function removeTextTrigger(
  guildId: string,
  id: number,
): Promise<boolean> {
  const result = await db
    .delete(textTriggersTable)
    .where(and(eq(textTriggersTable.guildId, guildId), eq(textTriggersTable.id, id)))
    .returning({ id: textTriggersTable.id });
  return result.length > 0;
}

export async function listTextTriggers(guildId: string): Promise<TextTrigger[]> {
  return db
    .select()
    .from(textTriggersTable)
    .where(eq(textTriggersTable.guildId, guildId))
    .orderBy(textTriggersTable.id);
}

/**
 * 指定チャンネル・テキストに一致するトリガーを返す。
 * watchChannelId が null のトリガーは全チャンネルで反応する。
 */
export async function matchTextTriggers(
  guildId: string,
  channelId: string,
  content: string,
): Promise<TextTrigger[]> {
  const all = await listTextTriggers(guildId);
  return all.filter(
    (t) =>
      t.triggerText === content &&
      (t.watchChannelId === null || t.watchChannelId === channelId),
  );
}
