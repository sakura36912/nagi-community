import { exportCurrentDatabaseJsonBackup } from "@workspace/db";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 2 || (args.length && (args[0] !== "--output" || !args[1]))) {
    throw new Error("Usage: backup:export [--output <directory>]");
  }
  const backup = await exportCurrentDatabaseJsonBackup({
    outputRoot: args[1] ? resolve(args[1]) : fileURLToPath(new URL("../../../generated-artifacts/database-backups", import.meta.url)),
    source: "shell",
  });
  console.log(`JSONバックアップ完了: ${backup.manifest.tableCount}テーブル / ${backup.manifest.totalRows}行`);
  console.log(`保存先: ${backup.directory}`);
  console.log("manifest.json とすべての data-*.json をセットで安全に保管してください。");
}
main().catch((error) => {
  console.error(`JSONバックアップに失敗しました（${error instanceof Error ? error.name : "unknown"}）。不完全な出力は削除しました。`);
  process.exitCode = 1;
});
