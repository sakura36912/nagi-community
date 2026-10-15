// Run inside Replit while its storage credentials are available. No gateway login.
import { Client } from "@replit/object-storage";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { localAssetPath } from "./lib/localAssets";

async function main() {
  const [option, target, ...extra] = process.argv.slice(2);
  if (option && (option !== "--output" || !target || extra.length)) throw new Error("Usage: assets:export [--output <private-directory>]");
  if (!process.env.SQLITE_PATH || !process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID) throw new Error("Migrated SQLITE_PATH and the source App Storage bucket are required");
  const db = new DatabaseSync(process.env.SQLITE_PATH, { readOnly: true });
  let paths: string[];
  try {
    paths = [...new Set([
      ...db.prepare("SELECT image_url AS path FROM bj_card_images").all(),
      ...db.prepare("SELECT object_path AS path FROM chinchiro_dice_images").all(),
    ].map((r) => String(r.path)))];
  } finally { db.close(); }
  const root = target ? resolve(target) : fileURLToPath(new URL("../../../generated-artifacts/asset-exports", import.meta.url));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, "assets-export-"));
  const client = new Client({ bucketId: process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID });
  try {
    const files = [];
    for (const objectName of paths) {
      const path = localAssetPath(objectName, directory);
      const result = await client.downloadAsBytes(objectName);
      if (!result.ok || !result.value[0]) throw new Error("A referenced image could not be downloaded; source data was not changed");
      const bytes = result.value[0];
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
      files.push({ objectName, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    await writeFile(join(directory, "asset-manifest.json"), JSON.stringify({ complete: true, files }, null, 2), { flag: "wx", mode: 0o600 });
    console.log(`Asset export complete: ${files.length} files. Directory: ${directory}`);
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
main().catch((error) => {
  console.error(`Asset export failed (${error instanceof Error ? error.name : "unknown"}). No incomplete export retained.`);
  process.exitCode = 1;
});
