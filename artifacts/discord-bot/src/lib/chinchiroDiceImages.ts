import { and, eq } from "drizzle-orm";
import { chinchiroDiceImagesTable, db } from "@workspace/db";

export function validDiceFace(face: number): boolean {
  return Number.isInteger(face) && face >= 1 && face <= 6;
}

export async function setChinchiroDiceImage(guildId: string, face: number, objectPath: string): Promise<void> {
  if (!validDiceFace(face)) throw new Error("チンチロの目は1〜6で指定してください。");
  await db.insert(chinchiroDiceImagesTable).values({ guildId, face, objectPath })
    .onConflictDoUpdate({
      target: [chinchiroDiceImagesTable.guildId, chinchiroDiceImagesTable.face],
      set: { objectPath },
    });
}

export async function getChinchiroDiceImages(guildId: string): Promise<Map<number, string>> {
  const rows = await db.select().from(chinchiroDiceImagesTable)
    .where(eq(chinchiroDiceImagesTable.guildId, guildId));
  return new Map(rows.map((row) => [Number(row.face), row.objectPath]));
}

export async function deleteChinchiroDiceImage(guildId: string, face: number): Promise<void> {
  await db.delete(chinchiroDiceImagesTable).where(and(
    eq(chinchiroDiceImagesTable.guildId, guildId),
    eq(chinchiroDiceImagesTable.face, face),
  ));
}