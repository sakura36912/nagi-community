import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "./schema/index";
import { createHash } from "node:crypto";

export const sqliteTables = (Object.values(schema) as unknown[]).filter((value): value is SQLiteTable => is(value, SQLiteTable))
  .map((table) => getTableConfig(table)).sort((a, b) => a.name.localeCompare(b.name));
export const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
// Independent of Drizzle snapshot UUIDs. Used to reject incompatible files.
export const sqliteSchemaFingerprint = createHash("sha256").update(JSON.stringify(sqliteTables.map((t) => ({
  name: t.name,
  columns: t.columns.map((c) => [c.name, c.getSQLType(), c.columnType, c.notNull, c.primary]),
  indexes: t.indexes.map((i) => i.config.name).sort(),
  unique: t.uniqueConstraints.map((u) => u.getName()).sort(),
  foreignKeys: t.foreignKeys.map((f) => f.getName()).sort(),
  checks: t.checks.map((c) => c.name).sort(),
})))).digest("hex");
