import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg, { type Pool } from "pg";
import { BackupJsonWriter } from "./backupJsonWriter";

const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
type TableInfo = { oid: number; schema: string; name: string; kind: string };
export type DatabaseBackup = Awaited<ReturnType<typeof exportDatabaseJsonBackup>>;

/** A bounded, dedicated connection cannot monopolize the bot's command pool. */
export async function exportPostgresDatabaseJsonBackup(
  options: Omit<Parameters<typeof exportDatabaseJsonBackup>[0], "pool">,
) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  const backupPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10_000, max: 1, application_name: "json-backup",
  });
  try {
    return await exportDatabaseJsonBackup({ ...options, pool: backupPool });
  } finally {
    await backupPool.end();
  }
}

/** Runtime is SQLite-only. PostgreSQL export remains an offline migration tool. */
export async function exportCurrentDatabaseJsonBackup(
  options: Omit<Parameters<typeof exportDatabaseJsonBackup>[0], "pool">,
) {
  const { exportSqliteJsonBackup } = await import("./sqliteBackup");
  return exportSqliteJsonBackup(options);
}

/** All application schemas; no pg_* or information_schema/system objects. */
export async function exportDatabaseJsonBackup(options: {
  pool: Pick<Pool, "connect">;
  outputRoot: string;
  source: "bot-runtime" | "shell";
  maxPartBytes?: number;
  timeoutMs?: number;
  onProgress?: (tablesDone: number, totalTables: number, totalRows: number) => Promise<void>;
}) {
  const { pool, outputRoot, source, maxPartBytes } = options;
  if (maxPartBytes !== undefined && (!Number.isFinite(maxPartBytes) || maxPartBytes < 1024)) {
    throw new Error("JSON part limit must be at least 1024 bytes");
  }
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(outputRoot, "database-backup-"));
  const deadline = Date.now() + (options.timeoutMs ?? 300_000);
  let abandoned = false;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  const connecting = pool.connect().then((connection) => {
    if (abandoned) {
      connection.release();
      throw new Error("Database backup connection timed out");
    }
    return connection;
  });
  const client = await Promise.race([
    connecting,
    new Promise<never>((_, reject) => {
      connectTimer = setTimeout(() => {
        abandoned = true;
        reject(new Error("Database backup connection timed out"));
      }, 10_000);
    }),
  ]).finally(() => clearTimeout(connectTimer)).catch(async (error) => {
    await rm(directory, { recursive: true, force: true });
    throw error;
  });
  let writer: BackupJsonWriter | undefined;
  let failed = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");
    // If RLS would filter rows, fail instead of silently claiming a full backup.
    await client.query("SET LOCAL row_security = off");
    await client.query("SET LOCAL timezone = 'UTC'");
    const { rows: snapshot } = await client.query<{ snapshot_at: string }>(
      "SELECT transaction_timestamp()::text AS snapshot_at",
    );
    const header = {
      format: "replit-postgres-json-backup", version: 1,
      backupId: randomUUID(), source, snapshotAt: snapshot[0]!.snapshot_at,
    };
    writer = new BackupJsonWriter(directory, header, maxPartBytes);
    const { rows: tables } = await client.query<TableInfo>(`
      SELECT c.oid, n.nspname AS schema, c.relname AS name, c.relkind AS kind
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind IN ('r','p','m') AND NOT c.relispartition
        AND n.nspname <> 'information_schema' AND left(n.nspname,3) <> 'pg_'
      ORDER BY n.nspname,c.relname
    `);
    const summaries = [];
    let totalRows = 0;
    for (const table of tables) {
      if (Date.now() > deadline) throw new Error("Database JSON backup timed out");
      const { rows: columns } = await client.query(
        `SELECT a.attname AS name, pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,
          a.attnotnull AS not_null, a.attidentity AS identity, a.attgenerated AS generated,
          pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_expression
         FROM pg_catalog.pg_attribute a
         LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
         WHERE a.attrelid=$1::oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
        [table.oid],
      );
      const relation = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}`;
      // ONLY avoids duplicating inherited rows; partition roots include their
      // partitions and partition children were excluded from the catalog list.
      await client.query(`DECLARE backup_rows NO SCROLL CURSOR FOR
        SELECT row_to_json(backup_row)::text AS json FROM ${table.kind === "r" ? "ONLY " : ""}${relation} AS backup_row`);
      await writer.beginTable(table.schema, table.name);
      let rowCount = 0;
      while (true) {
        if (Date.now() > deadline) throw new Error("Database JSON backup timed out");
        const { rows } = await client.query<{ json: string }>("FETCH FORWARD 250 FROM backup_rows");
        if (!rows.length) break;
        // PostgreSQL serializes directly: bigint/numeric digits are never
        // rounded by parsing them through JavaScript Number.
        for (const row of rows) await writer.row(row.json);
        rowCount += rows.length;
      }
      await client.query("CLOSE backup_rows");
      await writer.endTable();
      totalRows += rowCount;
      summaries.push({ schema: table.schema, name: table.name, kind: table.kind, columns, rowCount });
      await options.onProgress?.(summaries.length, tables.length, totalRows);
    }
    const parts = await writer.finish();
    await client.query("COMMIT");
    const manifest = {
      ...header, complete: true, tableCount: tables.length, totalRows,
      tables: summaries, parts,
      notes: [
        "All parts and this manifest form one backup; verify every SHA-256 before use.",
        "Database rows and column metadata only; external files, secrets/environment variables, database roles, indexes and triggers are not exported.",
        "Large numeric values are preserved as exact JSON number text; use a lossless parser when importing.",
      ],
    };
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return { directory, manifest, files: ["manifest.json", ...parts.map((part) => part.file)] };
  } catch (error) {
    failed = true;
    await client.query("ROLLBACK").catch(() => {});
    await writer?.abort();
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    client.release(failed);
  }
}
