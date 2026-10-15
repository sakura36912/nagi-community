import { getTableConfig } from "drizzle-orm/sqlite-core";
import type { Client } from "./sqliteClient";
import * as schema from "./schema/index.js";
import { sqliteTables } from "./sqliteSchema";

export interface SchemaDriftResult {
  missingTables: string[];
  missingColumns: Array<{ table: string; column: string }>;
  ok: boolean;
}

/**
 * Compares the Drizzle schema definitions against what actually exists in the
 * database and reports any missing tables or columns.
 *
 * Call this at bot startup so that schema drift (e.g. a `drizzle-kit push`
 * that was never run after a merge) surfaces as a clear warning in logs
 * instead of as cryptic runtime errors from individual queries.
 *
 * Never throws — any DB failure is caught and returned as `{ ok: false }`.
 *
 * @param pool  SQLite connection to the target database.
 * @param log   Function used to emit warning lines (defaults to console.warn).
 */
export async function checkSchemaDrift(
  pool: Pick<Client, "execute">,
  log: (msg: string) => void = console.warn,
): Promise<SchemaDriftResult> {
  try {
    // Collect the expected table / column names from all exported Drizzle table
    // objects. getTableConfig throws for non-table values, so we skip those.
    const expectedTables = new Map<string, string[]>();
    for (const value of Object.values(schema)) {
      try {
        const config = getTableConfig(value as Parameters<typeof getTableConfig>[0]);
        expectedTables.set(
          config.name,
          config.columns.map((c) => c.name),
        );
      } catch {
        // Not a SQLite table — skip types, zod schemas, etc.
      }
    }

    if (expectedTables.size === 0) {
      return { missingTables: [], missingColumns: [], ok: true };
    }

    // Query the actual columns present in the database for each expected table.
    const result = await pool.execute(
      `SELECT m.name AS table_name, p.name AS column_name
       FROM sqlite_master m JOIN pragma_table_info(m.name) p
       WHERE m.type = 'table'`,
    );

    const existingColumns = new Set(
      result.rows.map((r) => `${r.table_name}.${r.column_name}`),
    );
    const existingTables = new Set(result.rows.map((r) => r.table_name));

    const missingTables: string[] = [];
    const missingColumns: Array<{ table: string; column: string }> = [];
    const indexes = await pool.execute("SELECT name FROM sqlite_master WHERE type='index'");
    const indexNames = new Set(indexes.rows.map((row) => String(row.name)));
    const missingIndexes = sqliteTables.flatMap((table) => [
      ...table.indexes.map((index) => index.config.name),
      ...table.uniqueConstraints.map((unique) => unique.getName()),
    ]).filter((name): name is string => Boolean(name) && !indexNames.has(name!));
    for (const name of missingIndexes) log(`[schema-check] Required SQLite index missing: ${name}`);

    for (const [table, cols] of expectedTables) {
      if (!existingTables.has(table)) {
        missingTables.push(table);
        log(`[schema-check] ⚠ Table missing from database: ${table}`);
        continue;
      }
      for (const col of cols) {
        if (!existingColumns.has(`${table}.${col}`)) {
          missingColumns.push({ table, column: col });
          log(`[schema-check] ⚠ Column missing from database: ${table}.${col}`);
        }
      }
    }

    if (missingTables.length === 0 && missingColumns.length === 0 && missingIndexes.length === 0) {
      return { missingTables: [], missingColumns: [], ok: true };
    }

    log(
      `[schema-check] ⚠ Schema drift detected — ${missingTables.length} missing table(s), ` +
        `${missingColumns.length} missing column(s). ` +
        `Run the reviewed SQLite migrations before starting the bot.`,
    );
    return { missingTables, missingColumns, ok: false };
  } catch (err) {
    log(`[schema-check] Failed to check schema drift (DB unreachable?): ${err}`);
    return { missingTables: [], missingColumns: [], ok: false };
  }
}
