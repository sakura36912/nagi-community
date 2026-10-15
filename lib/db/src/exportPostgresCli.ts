// Deliberately does NOT import the bot runtime or open SQLite/a Discord gateway.
import { exportPostgresDatabaseJsonBackup } from "./jsonBackup";
import { resolve } from "node:path";

async function main() {
  const [output, ...extra] = process.argv.slice(2);
  if (!output || extra.length) throw new Error("Usage: backup:postgres <private-output-directory>");
  const backup = await exportPostgresDatabaseJsonBackup({ outputRoot: resolve(output), source: "shell" });
  console.log(`PostgreSQL JSON export complete: ${backup.manifest.tableCount} tables / ${backup.manifest.totalRows} rows`);
  console.log(`Directory: ${backup.directory}`);
}
main().catch((error) => {
  console.error(`PostgreSQL export failed (${error instanceof Error ? error.name : "unknown"}). No incomplete output retained.`);
  process.exitCode = 1;
});
