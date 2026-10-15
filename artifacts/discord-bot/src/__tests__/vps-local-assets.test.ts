import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { localAssetPath } from "../lib/localAssets";
import { uploadImageFromUrl, downloadImageAsBuffer, deleteGcsObject } from "../lib/gcsStorage";

const oldRoot = process.env.ASSET_DIRECTORY;
let root: string | undefined;
afterEach(async () => {
  vi.unstubAllGlobals();
  if (oldRoot === undefined) delete process.env.ASSET_DIRECTORY;
  else process.env.ASSET_DIRECTORY = oldRoot;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});
describe("VPS local image storage", () => {
  it("uploads, reads and removes images without cloud credentials", async () => {
    root = await mkdtemp(join(tmpdir(), "bot-local-assets-"));
    process.env.ASSET_DIRECTORY = root;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]))));
    const key = "bj-cards/123/spade/A.png";
    expect(await uploadImageFromUrl("https://example.test/image.png", key)).toBe(key);
    expect(await downloadImageAsBuffer(key)).toEqual(Buffer.from([1, 2, 3]));
    expect((await stat(localAssetPath(key))).mode & 0o777).toBe(0o600);
    await deleteGcsObject(key);
    expect(await downloadImageAsBuffer(key)).toBeNull();
  });
  it("rejects filesystem paths and parent traversal", () => {
    for (const key of ["../secret", "/etc/passwd", "cards/../../secret", "a\\b", "a/./b"]) {
      expect(() => localAssetPath(key, "/tmp/assets")).toThrow();
    }
    expect(() => localAssetPath("safe/file", "relative-root")).toThrow();
  });
});
