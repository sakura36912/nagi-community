import { isAbsolute, join } from "node:path";

/** Only relative object keys, never filesystem paths supplied by a member. */
export function localAssetPath(objectName: string, root = process.env.ASSET_DIRECTORY): string {
  if (!root || !isAbsolute(root)) throw new Error("ASSET_DIRECTORY must be an absolute persistent directory");
  const segments = objectName.split("/");
  if (!segments.length || segments.some((s) => !/^[A-Za-z0-9._-]+$/.test(s) || s === "." || s === "..")) {
    throw new Error("Invalid asset object key");
  }
  return join(root, ...segments);
}
