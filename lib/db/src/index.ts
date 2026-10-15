import { drizzle } from "drizzle-orm/sqlite-proxy";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import type { SQL } from "drizzle-orm";
import { openRuntimeSqlite } from "./sqliteClient";
import { sqliteSchemaFingerprint } from "./sqliteSchema";
import * as schema from "./schema";

export const pool = openRuntimeSqlite();
try {
  const meta = await pool.execute("SELECT key, value FROM _bot_sqlite_meta");
  const values = new Map(meta.rows.map((r) => [String(r.key), String(r.value)]));
  if (values.get("complete") !== "1" || values.get("schema") !== sqliteSchemaFingerprint) {
    throw new Error("SQLite schema fingerprint mismatch");
  }
} catch {
  pool.close();
  throw new Error("SQLite is incomplete or incompatible. Import a verified backup using this schema version before starting.");
}
await pool.execute("PRAGMA foreign_keys = ON");
await pool.execute("PRAGMA journal_mode = WAL");
await pool.execute("PRAGMA synchronous = FULL");
const database = drizzle(async (sql, args, method) => {
  const result = await pool.execute({ sql, args });
  return { rows: method === "get" ? result.arrays[0] ?? [] : result.arrays };
}, { schema });
const runTransaction = database.transaction.bind(database);
const dialect = new SQLiteSyncDialect();
/** Row-oriented raw queries keep the existing callers explicit and typed. */
export const db = Object.assign(database, {
  transaction<T>(callback: Parameters<typeof runTransaction<T>>[0]): Promise<T> {
    return pool.exclusiveScope(() => runTransaction(callback, { behavior: "immediate" }));
  },
  async execute<T extends Record<string, unknown> = Record<string, unknown>>(query: SQL) {
    const compiled = dialect.sqlToQuery(query);
    const result = await pool.execute({ sql: compiled.sql, args: compiled.params });
    const rows = result.rows as T[];
    return { rows, rowCount: rows.length };
  },
});

export * from "./schema";
export * from "./vcHub";
export * from "./evalSheetConfig";
export * from "./preban";
export * from "./timedRoleGrants";
export * from "./shopForumPanel";
export * from "./uraRecruitment";
export * from "./schema-check";
export * from "./dealerCasino";
export * from "./bounty";
export * from "./jsonBackup";
export * from "./processLock";
