import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportDatabaseJsonBackup } from "../../../../lib/db/src/jsonBackup";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root() {
  const directory = await mkdtemp(join(tmpdir(), "json-backup-test-"));
  roots.push(directory);
  return directory;
}
function database(tables: { schema: string; name: string; rows: string[] }[]) {
  let index = -1, fetched = false;
  const client = {
    release: vi.fn(),
    query: vi.fn(async (sql: string) => {
      if (sql.includes("transaction_timestamp")) return { rows: [{ snapshot_at: "2026-10-15 00:00:00+00" }] };
      if (sql.includes("pg_catalog.pg_class")) return { rows: tables.map((table, oid) => ({ ...table, oid: oid + 1, kind: "r" })) };
      if (sql.includes("pg_catalog.pg_attribute")) return { rows: [{ name: "id", type: "bigint" }] };
      if (sql.startsWith("DECLARE")) { index++; fetched = false; }
      if (sql.startsWith("FETCH")) {
        if (fetched) return { rows: [] };
        fetched = true;
        return { rows: tables[index]!.rows.map((json) => ({ json })) };
      }
      return { rows: [] };
    }),
  };
  return { client, pool: { connect: vi.fn(async () => client) } as unknown as Parameters<typeof exportDatabaseJsonBackup>[0]["pool"] };
}
describe("read-only database JSON backups", () => {
  it("exports all schemas, users and empty tables with exact numeric text and checksums", async () => {
    const db = database([
      { schema: "public", name: "wallets", rows: ['{"id":9007199254740993,"amount":12345678901234567890.123456789,"guild":"A"}', '{"id":2,"guild":"B"}'] },
      { schema: "archive", name: 'strange"table', rows: [] },
    ]);
    const backup = await exportDatabaseJsonBackup({ pool: db.pool, outputRoot: await root(), source: "shell" });
    expect(backup.manifest).toMatchObject({ complete: true, tableCount: 2, totalRows: 2 });
    const text = await readFile(join(backup.directory, backup.manifest.parts[0]!.file), "utf8");
    expect(text).toContain("9007199254740993");
    expect(text).toContain("12345678901234567890.123456789");
    expect(JSON.parse(text).tables[1]).toMatchObject({ schema: "archive", name: 'strange"table', rows: [], rowCount: 0 });
    const part = backup.manifest.parts[0]!;
    expect(part.sha256).toBe(createHash("sha256").update(text).digest("hex"));
    expect(part.bytes).toBe(Buffer.byteLength(text));
    expect((await stat(backup.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(backup.directory, part.file))).mode & 0o777).toBe(0o600);
    expect(db.client.query).toHaveBeenCalledWith(expect.stringContaining('"archive"."strange""table"'));
    expect(db.client.query).toHaveBeenCalledWith("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(db.client.query).toHaveBeenCalledWith("SET LOCAL row_security = off");
    expect(db.client.query).toHaveBeenCalledWith("COMMIT");
    expect(db.client.release).toHaveBeenCalledWith(false);
    expect(await readFile(join(backup.directory, "manifest.json"), "utf8")).not.toContain("DATABASE_URL");
  });
  it("splits oversized exports into valid bounded JSON without omitting or duplicating rows", async () => {
    const rows = Array.from({ length: 12 }, (_, id) => JSON.stringify({ id, text: "あ".repeat(90) }));
    const db = database([{ schema: "public", name: "messages", rows }]);
    const backup = await exportDatabaseJsonBackup({ pool: db.pool, outputRoot: await root(), source: "bot-runtime", maxPartBytes: 2048 });
    expect(backup.manifest.parts.length).toBeGreaterThan(1);
    const found = [];
    let offset = 0;
    for (const part of backup.manifest.parts) {
      expect(part.bytes).toBeLessThanOrEqual(2048);
      const parsed = JSON.parse(await readFile(join(backup.directory, part.file), "utf8"));
      for (const table of parsed.tables) {
        expect(table.rowOffset).toBe(offset);
        found.push(...table.rows.map((row: { id: number }) => row.id));
        offset += table.rows.length;
      }
    }
    expect(found).toEqual(Array.from({ length: 12 }, (_, id) => id));
    expect(backup.manifest.totalRows).toBe(12);
  });
  it("rolls back, discards the connection and removes incomplete files after a query error", async () => {
    const db = database([{ schema: "public", name: "users", rows: ["{}"] }]);
    const query = db.client.query.getMockImplementation()!;
    db.client.query.mockImplementation(async (sql) => {
      if (sql.startsWith("FETCH")) throw new Error("Query failed");
      return query(sql);
    });
    const outputRoot = await root();
    await expect(exportDatabaseJsonBackup({ pool: db.pool, outputRoot, source: "shell" })).rejects.toThrow("Query failed");
    expect(db.client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(db.client.release).toHaveBeenCalledWith(true);
    expect(await readdir(outputRoot)).toEqual([]);
  });
  it("produces a valid empty snapshot when there are no application tables", async () => {
    const db = database([]);
    const backup = await exportDatabaseJsonBackup({ pool: db.pool, outputRoot: await root(), source: "shell" });
    expect(backup.manifest.totalRows).toBe(0);
    expect(JSON.parse(await readFile(join(backup.directory, "data-0001.json"), "utf8")).tables).toEqual([]);
  });
  it("fails explicitly instead of silently truncating a row larger than a Discord part", async () => {
    const db = database([{ schema: "public", name: "large", rows: [JSON.stringify({ value: "x".repeat(3000) })] }]);
    const outputRoot = await root();
    await expect(exportDatabaseJsonBackup({ pool: db.pool, outputRoot, source: "shell", maxPartBytes: 1024 })).rejects.toThrow("single database row");
    expect(await readdir(outputRoot)).toEqual([]);
  });
});
