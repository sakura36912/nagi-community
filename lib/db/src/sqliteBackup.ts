import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BackupJsonWriter } from "./backupJsonWriter";
import { openSqlite, sqliteUrl } from "./sqliteClient";
import { quote } from "./sqliteSchema";

/** Dedicated, consistent read snapshot; raw UTC microseconds remain exact. */
export async function exportSqliteJsonBackup(options: {
  outputRoot: string;
  source: "bot-runtime" | "shell";
  maxPartBytes?: number;
  timeoutMs?: number;
  onProgress?: (tablesDone: number, totalTables: number, totalRows: number) => Promise<void>;
}) {
  if (options.maxPartBytes !== undefined && (!Number.isFinite(options.maxPartBytes) || options.maxPartBytes < 1024)) throw new Error("JSON part limit must be at least 1024 bytes");
  await mkdir(options.outputRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(options.outputRoot, "database-backup-"));
  const client = openSqlite(sqliteUrl());
  const deadline = Date.now() + (options.timeoutMs ?? 300_000);
  let writer: BackupJsonWriter | undefined;
  let tx: Awaited<ReturnType<typeof client.transaction>> | undefined;
  try {
    tx = await client.transaction("read");
    const tables = await tx.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '_bot_sqlite_meta' ORDER BY name");
    const header = { format: "discord-sqlite-json-backup", version: 1, backupId: randomUUID(), source: options.source, snapshotAt: new Date().toISOString() };
    writer = new BackupJsonWriter(directory, header, options.maxPartBytes);
    const summaries = [];
    let totalRows = 0;
    for (const table of tables.rows) {
      const name = String(table.name);
      const info = await tx.execute(`PRAGMA table_info(${quote(name)})`);
      const columns = info.rows.map((c) => ({
        name: String(c.name), type: String(c.type), not_null: Boolean(c.notnull),
        identity: "", generated: "", default_expression: c.dflt_value,
      }));
      await writer.beginTable("public", name);
      let offset = 0;
      for (;;) {
        if (Date.now() > deadline) throw new Error("SQLite JSON backup timed out");
        const rows = await tx.execute({ sql: `SELECT * FROM ${quote(name)} LIMIT 250 OFFSET ?`, args: [offset] });
        if (!rows.rows.length) break;
        for (const row of rows.rows) await writer.row(JSON.stringify(Object.fromEntries(columns.map((c) => [c.name, row[c.name]]))));
        offset += rows.rows.length;
      }
      await writer.endTable();
      totalRows += offset;
      summaries.push({ schema: "public", name, kind: "r", columns, rowCount: offset });
      await options.onProgress?.(summaries.length, tables.rows.length, totalRows);
    }
    const parts = await writer.finish();
    await tx.commit();
    const manifest = {
      ...header, complete: true, tableCount: summaries.length, totalRows, tables: summaries, parts,
      notes: [
        "All parts and manifest form one backup. Verify every SHA-256.",
        "SQLite cells are exported without conversion: UTC timestamp columns contain integer microseconds; JSON columns contain JSON strings.",
        "External images/files and secrets are not included. sqlite_sequence is reconstructed by importing explicit primary keys.",
      ],
    };
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    return { directory, manifest, files: ["manifest.json", ...parts.map((p) => p.file)] };
  } catch (error) {
    await tx?.rollback().catch(() => {});
    await writer?.abort();
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally { tx?.close(); client.close(); }
}
