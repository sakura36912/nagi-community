/**
 * Replit Object Storage (GCS) への画像アップロードユーティリティ。
 * Discord の添付ファイル URL から画像をダウンロードして GCS に保存し、公開 URL を返す。
 */
import { Storage } from "@google-cloud/storage";

const bucketId = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
if (!bucketId) throw new Error("DEFAULT_OBJECT_STORAGE_BUCKET_ID is not set");

// Replit sidecar 認証で自動的に認証される
const storage = new Storage();
const bucket = storage.bucket(bucketId);

/**
 * URL から画像をダウンロードして GCS にアップロードし、公開 URL を返す。
 * @param sourceUrl  ダウンロード元 URL（Discord CDN など）
 * @param gcsPath    GCS 内のオブジェクトパス（例: "bj-cards/guild/spade/A.png"）
 * @param contentType MIME タイプ（例: "image/png"）
 */
export async function uploadImageFromUrl(
  sourceUrl: string,
  gcsPath: string,
  contentType: string,
): Promise<string> {
  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`画像のダウンロードに失敗しました: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const file = bucket.file(gcsPath);
  await file.save(buffer, { contentType, resumable: false });
  await file.makePublic();
  return `https://storage.googleapis.com/${bucketId}/${gcsPath}`;
}

/**
 * GCS のオブジェクトを削除する（画像の上書き前のクリーンアップ用）。
 * 存在しない場合はエラーを無視する。
 */
export async function deleteGcsObject(gcsPath: string): Promise<void> {
  try {
    await bucket.file(gcsPath).delete();
  } catch {
    // 存在しない場合は無視
  }
}
