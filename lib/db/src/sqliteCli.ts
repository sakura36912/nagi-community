import { importJsonBackup, initializeEmptySqlite } from "./sqliteMigration";
import { sqliteUrl } from "./sqliteClient";
import { resolve } from "node:path";

async function main() {
  sqliteUrl();
  const [command, argument, ...extra] = process.argv.slice(2);
  if (command === "import" && argument && !extra.length) {
    console.log(JSON.stringify(await importJsonBackup(resolve(argument), process.env.SQLITE_PATH!), null, 2));
  } else if (command === "init" && argument === "--new-empty-database" && !extra.length) {
    console.log(JSON.stringify(await initializeEmptySqlite(process.env.SQLITE_PATH!), null, 2));
  } else {
    throw new Error("Usage: sqlite:import <backup-directory> OR sqlite:init --new-empty-database; SQLITE_PATH is required.");
  }
}
main().catch((error) => {
  // Never dump database rows or connection details on failure.
  console.error(`SQLite operation failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
