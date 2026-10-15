/**
 * Replit Object Storage への画像アップロード/ダウンロードユーティリティ。
 * @replit/object-storage SDK を使用（BOT プロセスで認証なしに動作）。
 */
import { Client } from "@replit/object-storage";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { localAssetPath } from "./localAssets";

// 遅延初期化 — モジュール読み込み時ではなく最初の使用時に生成
let _client: Client | null = null;
function getClient(): Client {
  if (!_client) {
    const bucketId = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
    if (!bucketId) throw new Error("DEFAULT_OBJECT_STORAGE_BUCKET_ID が設定されていません");
    _client = new Client({ bucketId });
  }
  return _client;
}

/**
 * URL から画像をダウンロードして Object Storage にアップロードする。
 * @returns 保存したオブジェクト名（path）
 */
export async function uploadImageFromUrl(
  sourceUrl: string,
  objectName: string,
  _contentType?: string,
): Promise<string> {
  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`画像のダウンロードに失敗しました: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (process.env.ASSET_DIRECTORY) {
    const destination = localAssetPath(objectName);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.upload-${randomUUID()}`;
    try {
      await writeFile(temporary, buffer, { flag: "wx", mode: 0o600 });
      await rename(temporary, destination);
    } finally { await rm(temporary, { force: true }); }
    return objectName;
  }
  const result = await getClient().uploadFromBytes(objectName, buffer);
  if (!result.ok) {
    throw new Error(`アップロードに失敗しました: ${result.error.message}`);
  }
  return objectName;
}

/**
 * Object Storage から画像を Buffer としてダウンロードする。
 * 存在しない場合は null を返す。
 */
export async function downloadImageAsBuffer(objectName: string): Promise<Buffer | null> {
  if (process.env.ASSET_DIRECTORY) {
    try { return await readFile(localAssetPath(objectName)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  const result = await getClient().downloadAsBytes(objectName);
  if (!result.ok) return null;
  return result.value[0] ?? null;
}

/**
 * Object Storage のオブジェクトを削除する（存在しない場合は無視）。
 */
export async function deleteGcsObject(objectName: string): Promise<void> {
  if (process.env.ASSET_DIRECTORY) {
    await rm(localAssetPath(objectName), { force: true });
    return;
  }
  await getClient().delete(objectName, { ignoreNotFound: true });
}
