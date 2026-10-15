import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type InValue = SQLInputValue;
export type InStatement = string | { sql: string; args?: unknown[] };
export type SqliteResult = { rows: Record<string, string | number | null | Uint8Array>[]; arrays: unknown[][]; rowsAffected: number };
export type Client = SqliteClient;

export function sqliteUrl(path = process.env.SQLITE_PATH): string {
  if (!path || !isAbsolute(path)) throw new Error("SQLITE_PATH must be an absolute persistent SQLite file path");
  return pathToFileURL(path).href;
}

async function retryBusy<T>(operation: () => T | Promise<T>): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { return await operation(); }
    catch (error) {
      const code = (error as { errcode?: number })?.errcode;
      if ((code !== 5 && code !== 6) || Date.now() >= deadline) throw error;
      // Do not block the JS event loop while another process/async writer owns SQLite.
      await new Promise((resolve) => setTimeout(resolve, 25 + Math.random() * 50));
    }
  }
}
function input(value: unknown): SQLInputValue {
  if (value instanceof Date) return value.getTime() * 1000;
  if (typeof value === "boolean") return Number(value);
  if (value === null || typeof value === "string" || typeof value === "bigint" || value instanceof Uint8Array) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error("Unsupported SQLite parameter");
}
function output(value: SQLOutputValue) {
  if (typeof value !== "bigint") return value;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("SQLite integer exceeds the bot's safe numeric range");
  return number;
}

/** One native SQLite connection with async transaction ownership and a FIFO queue. */
export class SqliteClient {
  private native: DatabaseSync;
  private tail = Promise.resolve();
  private context = new AsyncLocalStorage<{ active: boolean }>();
  private closed = false;
  constructor(url: string) {
    this.native = new DatabaseSync(fileURLToPath(url), { timeout: 0, enableForeignKeyConstraints: true });
  }
  private async acquire() {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([previous, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("SQLite operation queue timed out")), 60_000);
      })]);
    } catch (error) { void previous.finally(release); throw error; }
    finally { clearTimeout(timer); }
    return release;
  }
  private executeNow(query: InStatement): SqliteResult {
    if (this.closed) throw new Error("SQLite connection is closed");
    const sql = typeof query === "string" ? query : query.sql;
    const args = typeof query === "string" ? [] : (query.args ?? []).map(input);
    const statement = this.native.prepare(sql);
    statement.setReadBigInts(true);
    const columns = statement.columns().map((c) => c.name);
    if (columns.length) {
      statement.setReturnArrays(true);
      const arrays = (statement.all(...args) as unknown as SQLOutputValue[][]).map((row) => row.map(output));
      return { arrays, rows: arrays.map((row) => Object.fromEntries(columns.map((name, i) => [name, row[i]!]))), rowsAffected: 0 };
    }
    const result = statement.run(...args);
    return { rows: [], arrays: [], rowsAffected: Number(result.changes) };
  }
  async execute(query: InStatement): Promise<SqliteResult> {
    if (this.context.getStore()?.active) return retryBusy(() => this.executeNow(query));
    const release = await this.acquire();
    try { return await retryBusy(() => this.executeNow(query)); }
    finally { release(); }
  }
  async executeMultiple(sql: string) {
    const release = await this.acquire();
    try { this.native.exec(sql); } finally { release(); }
  }
  /** Holds queue ownership while Drizzle awaits an async callback. */
  async exclusiveScope<T>(callback: () => Promise<T>): Promise<T> {
    if (this.context.getStore()?.active) throw new Error("Use tx.transaction for nested SQLite transactions");
    const release = await this.acquire();
    const token = { active: true };
    try { return await this.context.run(token, callback); }
    finally { token.active = false; release(); }
  }
  async transaction(mode: "write" | "read" | "deferred" = "write") {
    const release = await this.acquire();
    try { await retryBusy(() => this.executeNow(mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN")); }
    catch (error) { release(); throw error; }
    let active = true;
    const finish = () => { if (active) { active = false; release(); } };
    const rollback = async () => {
      if (!active) return;
      try { this.executeNow("ROLLBACK"); } finally { finish(); }
    };
    return {
      execute: async (query: InStatement) => {
        if (!active) throw new Error("SQLite transaction is closed");
        return this.executeNow(query);
      },
      commit: async () => {
        if (!active) throw new Error("SQLite transaction is closed");
        try { await retryBusy(() => this.executeNow("COMMIT")); finish(); }
        catch (error) { await rollback(); throw error; }
      },
      rollback,
      close: () => { if (active) { try { this.executeNow("ROLLBACK"); } finally { finish(); } } },
    };
  }
  close() {
    if (!this.closed) { this.native.close(); this.closed = true; }
  }
}
export const openSqlite = (url: string) => new SqliteClient(url);
export function openRuntimeSqlite(): SqliteClient {
  const url = sqliteUrl();
  if (!existsSync(process.env.SQLITE_PATH!) || statSync(process.env.SQLITE_PATH!).size === 0) {
    throw new Error("SQLite file is missing or empty. Import a verified backup (or explicitly initialize a NEW database) before starting bots.");
  }
  return openSqlite(url);
}
