/**
 * ルーレットホイールGIFジェネレーター
 * ImageMagick (magick) を使って SVG フレームをGIFにまとめる。
 * 生成時間 約1〜1.5秒 / 300x300px / 20フレーム
 */

import { execFile } from "child_process";
import { writeFile, readFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";

const exec = promisify(execFile);

// ─── ホイール定数 ─────────────────────────────────────────────────────────────

/** ヨーロピアン・ルーレット時計回り並び順 */
export const WHEEL_ORDER = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13,
  36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14,
  31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
];

const RED_NUMS = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18,
  19, 21, 23, 25, 27, 30, 32, 34, 36,
]);

function sectorColor(n: number): string {
  if (n === 0) return "#00a63f";
  return RED_NUMS.has(n) ? "#c0392b" : "#2c2c2c";
}

// ─── SVGヘルパー ─────────────────────────────────────────────────────────────

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function arcPath(
  cx: number, cy: number,
  r1: number, r2: number,
  a1: number, a2: number,
): string {
  const [x1, y1] = polar(cx, cy, r1, a1);
  const [x2, y2] = polar(cx, cy, r1, a2);
  const [x3, y3] = polar(cx, cy, r2, a2);
  const [x4, y4] = polar(cx, cy, r2, a1);
  const lg = a2 - a1 > 180 ? 1 : 0;
  return (
    `M${x1.toFixed(1)},${y1.toFixed(1)} ` +
    `A${r1},${r1} 0 ${lg} 1 ${x2.toFixed(1)},${y2.toFixed(1)} ` +
    `L${x3.toFixed(1)},${y3.toFixed(1)} ` +
    `A${r2},${r2} 0 ${lg} 0 ${x4.toFixed(1)},${y4.toFixed(1)} Z`
  );
}

// ─── フレーム生成 ─────────────────────────────────────────────────────────────

function makeSvgFrame(wheelRot: number, ballAngle: number, sz = 300): string {
  const cx = sz / 2;
  const cy = sz / 2;
  const R  = 140;  // 外周半径
  const ri = 63;   // 内周半径（中心ハブ）
  const nr = 105;  // 数字表示半径
  const tw = 360 / 37; // 1セクター角度

  const parts: string[] = [];

  for (let i = 0; i < WHEEL_ORDER.length; i++) {
    const n  = WHEEL_ORDER[i];
    const a1 = i * tw + wheelRot;
    const a2 = (i + 1) * tw + wheelRot;
    const mid = (a1 + a2) / 2;
    const [bx, by] = polar(cx, cy, nr, mid);
    const fs = n >= 10 ? 7 : 9;

    parts.push(
      `<path d="${arcPath(cx, cy, R, ri, a1, a2)}" fill="${sectorColor(n)}" stroke="#8B7355" stroke-width="0.8"/>`,
      `<text x="${bx.toFixed(1)}" y="${by.toFixed(1)}" ` +
      `text-anchor="middle" dominant-baseline="middle" ` +
      `fill="white" font-size="${fs}" font-weight="bold" font-family="Arial" ` +
      `transform="rotate(${mid.toFixed(1)},${bx.toFixed(1)},${by.toFixed(1)})">${n}</text>`,
    );
  }

  const [blx, bly] = polar(cx, cy, R - 8, ballAngle);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sz}" height="${sz}">` +
    `<circle cx="${cx}" cy="${cy}" r="${sz / 2}" fill="#0d0d1a"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${R + 6}" fill="#5C4827"/>` +
    parts.join("") +
    `<circle cx="${cx}" cy="${cy}" r="${ri}" fill="#1a1a2e"/>` +
    `<circle cx="${cx}" cy="${cy}" r="18" fill="#5C4827"/>` +
    `<circle cx="${blx.toFixed(1)}" cy="${bly.toFixed(1)}" r="7" fill="white" stroke="#ccc" stroke-width="1"/>` +
    `</svg>`
  );
}

// ─── GIF生成 ──────────────────────────────────────────────────────────────────

/** フレームごとの遅延（センチ秒 = 1/100s）: 高速→減速→停止 */
const DELAYS = [4, 4, 4, 4, 4, 4, 4, 4, 5, 6, 8, 10, 13, 18, 24, 32, 45, 65, 100, 200];
const FRAMES = DELAYS.length; // 20

// ─── GIFキャッシュ ────────────────────────────────────────────────────────────

/** 事前生成済みGIFのキャッシュ（数字 → Buffer）*/
const gifCache = new Map<number, Buffer>();

/**
 * ボット起動時に0〜36の全GIFをバックグラウンドで生成してキャッシュに格納する。
 * ready イベント後に呼び出すこと（awaitしなくてよい）。
 */
export async function initRouletteGifCache(
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const total = 37; // 0〜36
  let done = 0;
  for (let n = 0; n < total; n++) {
    try {
      const buf = await generateRouletteGifRaw(n);
      gifCache.set(n, buf);
      done++;
      onProgress?.(done, total);
    } catch (err) {
      // 個別失敗は無視 — フォールバックでその場生成される
      console.error(`[roulette-cache] Failed to pre-generate GIF for ${n}:`, err);
    }
  }
}

/**
 * ルーレットGIFを返す。
 * キャッシュ済みであればキャッシュから、未完了ならその場で生成する。
 * @param landedNumber 0〜36 のどこで止まるか
 */
export async function generateRouletteGif(landedNumber: number): Promise<Buffer> {
  const cached = gifCache.get(landedNumber);
  if (cached) return cached;
  // キャッシュ未完了 — フォールバック生成
  return generateRouletteGifRaw(landedNumber);
}

/**
 * ルーレットGIFを生成してBufferで返す（内部実装）。
 * @param landedNumber 0〜36 のどこで止まるか
 */
async function generateRouletteGifRaw(landedNumber: number): Promise<Buffer> {
  const landedIdx = WHEEL_ORDER.indexOf(landedNumber);
  const tw = 360 / 37;
  const finalRot  = -((landedIdx + 0.5) * tw);  // 止まったときのホイール回転量
  const finalBall = finalRot;                     // ボールもポケットに合わせる

  const id   = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const svgs : string[] = [];
  const gifPath = join(tmpdir(), `rw_${id}.gif`);

  try {
    // SVGファイルを並列書き込み
    await Promise.all(
      Array.from({ length: FRAMES }, async (_, i) => {
        const t    = i / (FRAMES - 1);
        const ease = 1 - Math.pow(1 - t, 3); // cubic ease-out

        // ホイールは最終位置まで3周分余計に回転して止まる
        const wheelRot  = (finalRot  - 360 * 3 * (1 - ease)) % 360;
        // ボールはホイールより少し速く（4周分）動いてポケットへ落ちる
        const ballAngle = (finalBall - 360 * 4 * (1 - ease)) % 360;

        const svgPath = join(tmpdir(), `rw_${id}_${i.toString().padStart(2, "0")}.svg`);
        svgs.push(svgPath);
        await writeFile(svgPath, makeSvgFrame(wheelRot, ballAngle));
      }),
    );

    // magick コマンド組み立て
    const args: string[] = [];
    for (let i = 0; i < FRAMES; i++) {
      args.push("-delay", DELAYS[i].toString(), svgs[i]);
    }
    // ループ0 = 無限ループ（最終フレームが長いのでほぼ止まって見える）
    args.push("-loop", "0", "-layers", "optimize", gifPath);

    await exec("magick", args);
    return await readFile(gifPath);
  } finally {
    await Promise.all(
      [...svgs, gifPath].map((f) => unlink(f).catch(() => {})),
    );
  }
}
