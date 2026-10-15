import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, rm, lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { parse, stringify, isLosslessNumber } from "lossless-json";
import type { Client, InValue } from "./sqliteClient";
import { openSqlite } from "./sqliteClient";
import { quote, sqliteTables, sqliteSchemaFingerprint } from "./sqliteSchema";
import * as schema from "./schema/index";

type Manifest = {
  format: string; version: number; backupId: string; complete: boolean;
  tableCount: number; totalRows: number;
  tables: { schema: string; name: string; rowCount: number }[];
  parts: { file: string; bytes: number; sha256: string; rowCount: number }[];
};
const MODULUS = 1n << 256n;
function rowHash(values: unknown[]): bigint {
  return BigInt(`0x${createHash("sha256").update(JSON.stringify(values)).digest("hex")}`);
}
function exactNumber(value: unknown): number {
  const n = Number(isLosslessNumber(value) ? value.value : value);
  if (!Number.isFinite(n) || (Number.isInteger(n) && !Number.isSafeInteger(n))) {
    throw new Error("A numeric value cannot be represented safely by the bot. Source backup was not changed.");
  }
  return n;
}
function convert(value: unknown, column: (typeof sqliteTables)[number]["columns"][number], sqliteSource: boolean): InValue {
  if (value === null) return null;
  if (column.columnType === "SQLiteCustomColumn") {
    if (sqliteSource) return exactNumber(value);
    if (typeof value !== "string" || !/(Z|[+-]\d\d:\d\d)$/.test(value)) throw new Error("Timestamp has no explicit timezone");
    const n = Date.parse(value);
    if (!Number.isFinite(n)) throw new Error("Invalid timestamp in source");
    const fraction = /\.(\d+)(?:Z|[+-]\d\d:\d\d)$/.exec(value)?.[1] ?? "";
    if (fraction.length > 6) throw new Error("Timestamp precision exceeds microseconds");
    const microseconds = n * 1000 + Number(fraction.padEnd(6, "0").slice(3));
    if (!Number.isSafeInteger(microseconds)) throw new Error("Timestamp is outside the supported SQLite range");
    return microseconds;
  }
  if (column.columnType === "SQLiteBoolean") {
    if (typeof value === "boolean") return Number(value);
    const n = exactNumber(value);
    if (n !== 0 && n !== 1) throw new Error("Invalid boolean in source");
    return n;
  }
  if (column.columnType === "SQLiteTextJson") {
    if (sqliteSource) {
      if (typeof value !== "string") throw new Error("Invalid SQLite JSON cell");
      parse(value);
      return value;
    }
    return stringify(value)!;
  }
  if (column.dataType === "number") return exactNumber(value);
  if (typeof value !== "string") throw new Error("Invalid text cell in source");
  return value;
}

async function buildSchema(client: Client) {
  // Schema generation is local-only; never connects to the old PostgreSQL DB.
  const { generateSQLiteDrizzleJson, generateSQLiteMigration } = await import("drizzle-kit/api");
  const empty = await generateSQLiteDrizzleJson({});
  const current = await generateSQLiteDrizzleJson(schema);
  const statements = await generateSQLiteMigration(empty, current);
  for (const statement of statements) await client.executeMultiple(statement);
  await client.execute(`CREATE TABLE _bot_sqlite_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
}

async function freshDatabase(destination: string, work: (client: Client) => Promise<Record<string, unknown>>) {
  if (!isAbsolute(destination)) throw new Error("Destination must be an absolute path");
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.import-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  await handle.close();
  const client = openSqlite(pathToFileURL(temporary).href);
  try {
    // FULL durability while importing. WAL is enabled only after publishing the file.
    await client.execute("PRAGMA synchronous = FULL");
    await buildSchema(client);
    const report = await work(client);
    const integrity = await client.execute("PRAGMA integrity_check");
    if (integrity.rows.length !== 1 || integrity.rows[0]?.integrity_check !== "ok") throw new Error("SQLite integrity check failed");
    const fk = await client.execute("PRAGMA foreign_key_check");
    if (fk.rows.length) throw new Error(`SQLite foreign key check failed (${fk.rows.length} violations)`);
    await client.execute({ sql: "INSERT INTO _bot_sqlite_meta VALUES ('schema', ?), ('complete', '1')", args: [sqliteSchemaFingerprint] });
    client.close();
    // Hard link on the same filesystem is atomic and fails if destination exists.
    // Unlike rename(), this can never overwrite a previously migrated database.
    await link(temporary, destination);
    await chmod(destination, 0o600);
    await rm(temporary);
    return report;
  } finally {
    client.close();
    await rm(temporary, { force: true });
    await rm(`${temporary}-wal`, { force: true });
    await rm(`${temporary}-shm`, { force: true });
  }
}

export async function initializeEmptySqlite(destination: string) {
  return freshDatabase(destination, async () => ({ initializedEmpty: true, tableCount: sqliteTables.length }));
}

/** A completed manifest plus ALL parts is required. No network or source DB writes. */
export async function importJsonBackup(directory: string, destination: string) {
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as Manifest;
  if (!["replit-postgres-json-backup", "discord-sqlite-json-backup"].includes(manifest.format) ||
      manifest.version !== 1 || manifest.complete !== true || !manifest.backupId ||
      !Array.isArray(manifest.tables) || !Array.isArray(manifest.parts) || !manifest.parts.length) {
    throw new Error("Unsupported or incomplete backup manifest");
  }
  const sqliteSource = manifest.format === "discord-sqlite-json-backup";
  const configs = new Map(sqliteTables.map((t) => [t.name, t]));
  const totals = new Map<string, { count: number; hash: bigint }>();
  if (manifest.tableCount !== manifest.tables.length || manifest.tables.length !== configs.size) throw new Error("Backup table set does not match the current schema");
  for (const t of manifest.tables) {
    if (t.schema !== "public" || !configs.has(t.name) || totals.has(t.name) || !Number.isSafeInteger(t.rowCount) || t.rowCount < 0) {
      throw new Error("Unknown, duplicate, or invalid table in manifest");
    }
    totals.set(t.name, { count: 0, hash: 0n });
  }
  const seenFiles = new Set<string>();
  // Validate all bytes before creating a destination. Part contents are parsed
  // again inside the transaction; no partial database is ever made active.
  for (const part of manifest.parts) {
    if (!/^data-\d+\.json$/.test(part.file) || basename(part.file) !== part.file || seenFiles.has(part.file)) throw new Error("Invalid part path");
    seenFiles.add(part.file);
    const path = join(directory, part.file);
    if (!(await lstat(path)).isFile()) throw new Error("Backup part must be a regular file");
    const bytes = await readFile(path);
    if (bytes.length !== part.bytes || createHash("sha256").update(bytes).digest("hex") !== part.sha256) throw new Error("Backup part checksum mismatch");
  }
  return freshDatabase(destination, async (client) => {
    await client.execute("PRAGMA foreign_keys = OFF");
    const tx = await client.transaction("write");
    try {
      let partIndex = 0;
      for (const part of manifest.parts) {
        const bytes = await readFile(join(directory, part.file));
        if (createHash("sha256").update(bytes).digest("hex") !== part.sha256) throw new Error("Backup changed during import");
        const data = parse(bytes.toString("utf8")) as {
          format: string; version: unknown; backupId: string; part: unknown; partComplete: boolean;
          tables: { schema: string; name: string; rowOffset: unknown; rowCount: unknown; rows: Record<string, unknown>[] }[];
        };
        if (data.backupId !== manifest.backupId || data.format !== manifest.format || exactNumber(data.version) !== 1 ||
            exactNumber(data.part) !== ++partIndex || data.partComplete !== true || !Array.isArray(data.tables)) throw new Error("Backup part header mismatch");
        let partRows = 0;
        for (const segment of data.tables) {
          const config = configs.get(segment.name);
          const total = totals.get(segment.name);
          if (segment.schema !== "public" || !config || !total || !Array.isArray(segment.rows) ||
              exactNumber(segment.rowOffset) !== total.count || exactNumber(segment.rowCount) !== segment.rows.length) throw new Error("Backup row segment mismatch");
          const names = config.columns.map((c) => c.name);
          const sql = `INSERT INTO ${quote(config.name)} (${names.map(quote).join(",")}) VALUES (${names.map(() => "?").join(",")})`;
          for (const row of segment.rows) {
            if (Object.keys(row).length !== names.length || names.some((name) => !Object.hasOwn(row, name))) throw new Error(`Column mismatch in ${config.name}; use a matching schema version`);
            const values = config.columns.map((c) => convert(row[c.name], c, sqliteSource));
            await tx.execute({ sql, args: values });
            total.count++;
            total.hash = (total.hash + rowHash(values)) % MODULUS;
            partRows++;
          }
        }
        if (partRows !== part.rowCount) throw new Error("Backup part row count mismatch");
      }
      for (const table of manifest.tables) {
        if (totals.get(table.name)!.count !== table.rowCount) throw new Error(`Incomplete table: ${table.name}`);
      }
      if ([...totals.values()].reduce((n, t) => n + t.count, 0) !== manifest.totalRows) throw new Error("Backup total row count mismatch");
      await tx.commit();
    } catch (error) { await tx.rollback(); throw error; }
    finally { tx.close(); }
    // Independently read back stored rows, checking full content not just counts.
    for (const config of configs.values()) {
      const names = config.columns.map((c) => c.name);
      let offset = 0, hash = 0n;
      for (;;) {
        const rows = await client.execute({ sql: `SELECT ${names.map(quote).join(",")} FROM ${quote(config.name)} LIMIT 500 OFFSET ?`, args: [offset] });
        if (!rows.rows.length) break;
        for (const row of rows.rows) hash = (hash + rowHash(names.map((n) => row[n]))) % MODULUS;
        offset += rows.rows.length;
      }
      const source = totals.get(config.name)!;
      if (offset !== source.count || hash !== source.hash) throw new Error(`Read-back verification failed: ${config.name}`);
    }
    return { backupId: manifest.backupId, tableCount: manifest.tableCount, totalRows: manifest.totalRows, contentVerified: true };
  });
}
