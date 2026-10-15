import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { initializeEmptySqlite, importJsonBackup } from "@workspace/db/sqlite-tools";
import { openSqlite } from "@workspace/db/sqlite-client";
import { exportSqliteJsonBackup } from "@workspace/db/sqlite-backup";

const roots: string[] = [];
const originalPath = process.env.SQLITE_PATH;
afterEach(async () => {
  if (originalPath === undefined) delete process.env.SQLITE_PATH;
  else process.env.SQLITE_PATH = originalPath;
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bot-sqlite-migration-"));
  roots.push(root);
  const source = join(root, "source.sqlite");
  await initializeEmptySqlite(source);
  const client = openSqlite(pathToFileURL(source).href);
  await client.execute({
    sql: "INSERT INTO wallets(guild_id,user_id,balance,created_at,updated_at) VALUES(?,?,?,?,?)",
    args: ["fixture", "1526418867335725247", 123456, 1790000000123456, 1790000000123456],
  });
  await client.execute({
    sql: "INSERT INTO slot_settings(guild_id,fixed_emoji_ids,emoji_weights) VALUES(?,?,?)",
    args: ["fixture", '["emoji-1","emoji-2"]', '{"emoji-1":4}'],
  });
  client.close();
  process.env.SQLITE_PATH = source;
  const backup = await exportSqliteJsonBackup({ outputRoot: root, source: "shell", maxPartBytes: 4096 });
  return { root, source, backup, destination: join(root, "imported.sqlite") };
}

describe("SQLite backup migration", () => {
  // The first fixture loads the schema generator; allow startup on slow CI.
  it("round-trips all tables, raw microseconds, JSON, balances, text IDs and indexes", async () => {
    const { backup, destination } = await fixture();
    const report = await importJsonBackup(backup.directory, destination);
    expect(report).toMatchObject({ tableCount: 90, totalRows: 2, contentVerified: true });
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
    const client = openSqlite(pathToFileURL(destination).href);
    try {
      expect((await client.execute("SELECT user_id,balance,created_at FROM wallets")).rows[0]).toMatchObject({
        user_id: "1526418867335725247", balance: 123456, created_at: 1790000000123456,
      });
      expect((await client.execute("SELECT fixed_emoji_ids,emoji_weights FROM slot_settings")).rows[0]).toMatchObject({
        fixed_emoji_ids: '["emoji-1","emoji-2"]', emoji_weights: '{"emoji-1":4}',
      });
      expect((await client.execute("SELECT name FROM sqlite_master WHERE type='index' AND name='transactions_session_key_idx'")).rows).toHaveLength(1);
      expect((await client.execute("SELECT value FROM _bot_sqlite_meta WHERE key='complete'")).rows[0]?.value).toBe("1");
    } finally { client.close(); }
  }, 30_000);

  it("imports PostgreSQL timestamps without dropping their last three fractional digits", async () => {
    const { backup, root, destination } = await fixture();
    const manifest = backup.manifest;
    manifest.format = "replit-postgres-json-backup";
    for (const part of manifest.parts) {
      const path = join(backup.directory, part.file);
      const data = JSON.parse(await readFile(path, "utf8"));
      data.format = manifest.format;
      for (const segment of data.tables) {
        for (const row of segment.rows) {
          if (segment.name === "wallets") {
            row.created_at = "2026-09-21T14:13:20.123456+00:00";
            row.updated_at = "2026-09-21T14:13:20.123456+00:00";
            row.last_daily_at = null;
            row.initial_issued_at = null;
          } else if (segment.name === "slot_settings") {
            row.updated_at = "2026-09-21T14:13:20.123456+00:00";
            row.fixed_emoji_ids = JSON.parse(row.fixed_emoji_ids);
            row.sticker_ids = JSON.parse(row.sticker_ids);
            row.payout_multipliers = JSON.parse(row.payout_multipliers);
            row.emoji_weights = JSON.parse(row.emoji_weights);
          }
        }
      }
      const bytes = Buffer.from(JSON.stringify(data));
      part.bytes = bytes.length;
      part.sha256 = createHash("sha256").update(bytes).digest("hex");
      await writeFile(path, bytes);
    }
    await writeFile(join(backup.directory, "manifest.json"), JSON.stringify(manifest));
    await importJsonBackup(backup.directory, destination);
    const client = openSqlite(pathToFileURL(destination).href);
    try {
      const expected = Date.parse("2026-09-21T14:13:20.123Z") * 1000 + 456;
      expect((await client.execute("SELECT created_at FROM wallets")).rows[0]?.created_at).toBe(expected);
    } finally { client.close(); }
  }, 30_000);

  it("rejects a corrupted or incomplete backup without activating a database", async () => {
    const { backup, destination } = await fixture();
    await writeFile(join(backup.directory, backup.manifest.parts[0]!.file), "corrupted");
    await expect(importJsonBackup(backup.directory, destination)).rejects.toThrow("checksum");
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("never overwrites an existing destination", async () => {
    const { backup, destination } = await fixture();
    await writeFile(destination, "existing database");
    await expect(importJsonBackup(backup.directory, destination)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(destination, "utf8")).toBe("existing database");
  }, 30_000);

  it("serializes async writers on the same client and on separate SQLite connections", async () => {
    const { source } = await fixture();
    const first = openSqlite(pathToFileURL(source).href);
    const second = openSqlite(pathToFileURL(source).href);
    try {
      const add = async (client: typeof first) => {
        const tx = await client.transaction("write");
        try {
          const row = (await tx.execute("SELECT balance FROM wallets WHERE guild_id='fixture'")).rows[0]!;
          await new Promise((resolve) => setTimeout(resolve, 5));
          await tx.execute({ sql: "UPDATE wallets SET balance=? WHERE guild_id='fixture'", args: [Number(row.balance) + 1] });
          await tx.commit();
        } catch (error) { await tx.rollback(); throw error; }
        finally { tx.close(); }
      };
      await Promise.all(Array.from({ length: 12 }, (_, i) => add(i % 2 ? first : second)));
      expect((await first.execute("SELECT balance FROM wallets WHERE guild_id='fixture'")).rows[0]?.balance).toBe(123468);
      const tx = await first.transaction("write");
      await tx.execute("UPDATE wallets SET balance=0 WHERE guild_id='fixture'");
      await tx.rollback();
      expect((await first.execute("SELECT balance FROM wallets WHERE guild_id='fixture'")).rows[0]?.balance).toBe(123468);
    } finally { first.close(); second.close(); }
  }, 30_000);
});
