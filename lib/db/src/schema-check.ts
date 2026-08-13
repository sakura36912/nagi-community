import { getTableConfig } from "drizzle-orm/pg-core";
import type { Pool } from "pg";
import * as schema from "./schema/index.js";

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
 * @param pool  pg Pool connected to the target database.
 * @param log   Function used to emit warning lines (defaults to console.warn).
 */
export async function checkSchemaDrift(
  pool: Pool,
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
        // Not a PgTable — skip enums, types, zod schemas, etc.
      }
    }

    if (expectedTables.size === 0) {
      return { missingTables: [], missingColumns: [], ok: true };
    }

    // Query the actual columns present in the database for each expected table.
    const tableNames = [...expectedTables.keys()];
    const result = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [tableNames],
    );

    const existingColumns = new Set(
      result.rows.map((r) => `${r.table_name}.${r.column_name}`),
    );
    const existingTables = new Set(result.rows.map((r) => r.table_name));

    const missingTables: string[] = [];
    const missingColumns: Array<{ table: string; column: string }> = [];

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

    if (missingTables.length === 0 && missingColumns.length === 0) {
      return { missingTables: [], missingColumns: [], ok: true };
    }

    log(
      `[schema-check] ⚠ Schema drift detected — ${missingTables.length} missing table(s), ` +
        `${missingColumns.length} missing column(s). ` +
        `Run: pnpm --filter @workspace/db run push-force`,
    );
    return { missingTables, missingColumns, ok: false };
  } catch (err) {
    log(`[schema-check] Failed to check schema drift (DB unreachable?): ${err}`);
    return { missingTables: [], missingColumns: [], ok: false };
  }
}
