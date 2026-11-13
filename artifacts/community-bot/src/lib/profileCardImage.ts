import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { GlobalFonts, createCanvas, loadImage } from "@napi-rs/canvas";

const WIDTH = 1200;
const CONTENT_WIDTH = 1060;
const CARD_MARGIN = 70;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 20_000_000;
const MAX_IMAGE_REDIRECTS = 3;
const IMAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHED_BACKGROUNDS = 4;
const JAPANESE_FONT = "Noto Sans CJK JP";

export interface ProfileCardSection {
  title: string;
  lines: string[];
}

export interface ProfileCardImageInput {
  displayName: string;
  username: string;
  avatarUrl: string;
  cardTitle: string;
  rankLabel: string | null;
  bountyLabel: string | null;
  bountyValue: string | null;
  sections: ProfileCardSection[];
  accentColor: number;
  backgroundBuffer: Buffer | null;
  avatarBuffer: Buffer | null;
}

interface ImageCacheEntry {
  buffer: Buffer;
  expiresAt: number;
}

const backgroundCache = new Map<string, ImageCacheEntry>();
const backgroundLoads = new Map<string, Promise<Buffer>>();
let fontReady = false;

function ensureJapaneseFont() {
  if (fontReady) return;
  if (GlobalFonts.has(JAPANESE_FONT)) {
    fontReady = true;
    return;
  }

  const candidates = new Set<string>();
  if (process.env.PROFILE_CARD_FONT_PATH) candidates.add(process.env.PROFILE_CARD_FONT_PATH);
  try {
    const matchedPath = execFileSync("fc-match", ["-f", "%{file}", JAPANESE_FONT], {
      encoding: "utf8",
      timeout: 1_500,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (matchedPath) candidates.add(matchedPath);
  } catch {
    // Optional on hosts without fontconfig; explicit candidate paths are checked below.
  }
  candidates.add("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc");
  candidates.add("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc");

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    if (GlobalFonts.registerFromPath(path, JAPANESE_FONT)) {
      fontReady = true;
      return;
    }
  }
  throw new Error("Japanese profile font is missing; install Noto Sans CJK JP or set PROFILE_CARD_FONT_PATH.");
}

function isPublicIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  if (a === undefined || b === undefined || c === undefined) return false;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function imageDimensions(buffer: Buffer, contentType: string): { width: number; height: number } {
  if (contentType === "image/png" && buffer.length >= 24
      && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (contentType !== "image/jpeg" || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new Error("Only valid PNG and JPEG images are supported.");
  }

  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 4 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buffer[offset + 1]!;
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
    if (frameMarkers.has(marker)) {
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }
    offset += segmentLength;
  }
  throw new Error("JPEG dimensions could not be read.");
}

function validateImageDimensions(buffer: Buffer, contentType: string) {
  const { width, height } = imageDimensions(buffer, contentType);
  if (!width || !height || width > 8_192 || height > 8_192 || width * height > MAX_IMAGE_PIXELS) {
    throw new Error("Image dimensions exceed the profile background limit.");
  }
}

async function resolvePublicIpv4(hostname: string): Promise<string> {
  if (isIP(hostname) === 4) {
    if (!isPublicIpv4(hostname)) throw new Error("Private or reserved image hosts are not allowed.");
    return hostname;
  }
  if (isIP(hostname) !== 0) throw new Error("IPv6 image hosts are not supported.");
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  const ipv4 = addresses.filter(entry => entry.family === 4);
  if (ipv4.length === 0 || ipv4.some(entry => !isPublicIpv4(entry.address))) {
    throw new Error("Image host must resolve only to public IPv4 addresses.");
  }
  return ipv4[0]!.address;
}

export function resolveProfileImageRedirect(currentUrl: string, location: string, redirectCount: number): string {
  if (redirectCount >= MAX_IMAGE_REDIRECTS) throw new Error("Background image exceeded the redirect limit.");
  let target: URL;
  try {
    target = new URL(location, currentUrl);
  } catch {
    throw new Error("Background image redirect URL is invalid.");
  }
  if (target.protocol !== "https:" || (target.port && target.port !== "443") || target.username || target.password) {
    throw new Error("Background image redirects must use public HTTPS on port 443.");
  }
  return target.toString();
}

export async function fetchProfileImage(urlText: string, redirectCount = 0): Promise<Buffer> {
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw new Error("Background image URL is invalid.");
  }
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password) {
    throw new Error("Background image must use a public HTTPS URL on port 443.");
  }
  const pinnedAddress = await resolvePublicIpv4(url.hostname);

  const result = await new Promise<{ kind: "image"; buffer: Buffer } | { kind: "redirect"; location: string }>((resolve, reject) => {
    const pinnedLookup = ((hostname, options, callback) => {
      callback(null, pinnedAddress, 4);
    }) as LookupFunction;
    const request = httpsRequest({
      hostname: url.hostname,
      port: 443,
      method: "GET",
      path: `${url.pathname}${url.search}`,
      headers: { accept: "image/png,image/jpeg", "user-agent": "CommunityBot-ProfileCard/1.0" },
      lookup: pinnedLookup,
      servername: url.hostname,
      timeout: 8_000,
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        const location = response.headers.location;
        response.resume();
        if (!location) {
          reject(new Error("Background image redirect is missing a location."));
          return;
        }
        if (redirectCount >= MAX_IMAGE_REDIRECTS) {
          reject(new Error("Background image exceeded the redirect limit."));
          return;
        }
        resolve({ kind: "redirect", location });
        return;
      }
      const contentType = String(response.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
      if (response.statusCode !== 200 || (contentType !== "image/png" && contentType !== "image/jpeg")) {
        response.resume();
        reject(new Error("Background image must be a directly accessible PNG or JPEG (redirects are not followed)."));
        return;
      }
      const declaredLength = Number(response.headers["content-length"] ?? 0);
      if (declaredLength > MAX_IMAGE_BYTES) {
        response.destroy(new Error("Background image exceeds the 5 MB limit."));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer | string) => {
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += part.length;
        if (total > MAX_IMAGE_BYTES) {
          response.destroy(new Error("Background image exceeds the 5 MB limit."));
          return;
        }
        chunks.push(part);
      });
      response.on("end", () => {
        const image = Buffer.concat(chunks);
        try {
          validateImageDimensions(image, contentType);
          resolve({ kind: "image", buffer: image });
        } catch (error) {
          reject(error);
        }
      });
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("Background image request timed out.")));
    request.on("error", reject);
    request.end();
  });
  if (result.kind === "redirect") {
    return fetchProfileImage(resolveProfileImageRedirect(url.toString(), result.location, redirectCount), redirectCount + 1);
  }
  return result.buffer;
}

export async function getCachedProfileBackground(url: string): Promise<Buffer> {
  const cached = backgroundCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.buffer;
  const inFlight = backgroundLoads.get(url);
  if (inFlight) return inFlight;

  const load = fetchProfileImage(url).then(buffer => {
    backgroundCache.delete(url);
    backgroundCache.set(url, { buffer, expiresAt: Date.now() + IMAGE_CACHE_TTL_MS });
    while (backgroundCache.size > MAX_CACHED_BACKGROUNDS) {
      backgroundCache.delete(backgroundCache.keys().next().value!);
    }
    return buffer;
  }).finally(() => backgroundLoads.delete(url));
  backgroundLoads.set(url, load);
  return load;
}

export function clearProfileBackgroundCache() {
  backgroundCache.clear();
  backgroundLoads.clear();
}

function toHexColor(color: number): string {
  return `#${Math.max(0, color).toString(16).padStart(6, "0").slice(-6)}`;
}

function wrapText(context: ReturnType<ReturnType<typeof createCanvas>["getContext"]>, text: string, maxWidth: number) {
  const lines: string[] = [];
  for (const sourceLine of text.split("\n")) {
    let line = "";
    for (const character of [...sourceLine]) {
      if (context.measureText(line + character).width > maxWidth && line) {
        lines.push(line);
        line = character;
      } else {
        line += character;
      }
    }
    lines.push(line || " ");
  }
  return lines;
}

function fitImage(context: ReturnType<ReturnType<typeof createCanvas>["getContext"]>, image: Awaited<ReturnType<typeof loadImage>>, x: number, y: number, width: number, height: number) {
  const scale = Math.max(width / image.width, height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  context.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
}

function drawRoundedRect(context: ReturnType<ReturnType<typeof createCanvas>["getContext"]>, x: number, y: number, width: number, height: number, radius: number) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

export async function renderProfileCard(input: ProfileCardImageInput): Promise<Buffer> {
  ensureJapaneseFont();
  const loadedBackground = input.backgroundBuffer ? await loadImage(input.backgroundBuffer) : null;
  const loadedAvatar = input.avatarBuffer ? await loadImage(input.avatarBuffer).catch(() => null) : null;
  const measureContext = createCanvas(WIDTH, 10).getContext("2d");
  measureContext.font = `26px "${JAPANESE_FONT}"`;
  const wrappedSections = input.sections.map(section => ({
    title: section.title.replace(/^[^\p{L}\p{N}]+/u, "").trim() || section.title,
    lines: section.lines.flatMap(line => wrapText(measureContext, line, CONTENT_WIDTH - 56)),
  }));
  const sectionHeights = wrappedSections.map(section => 38 + Math.max(1, section.lines.length) * 38 + 28);
  const bountyHeight = input.bountyValue ? 184 : 0;
  const headerHeight = 344;
  const footerHeight = 104;
  const gap = 18;
  const height = Math.max(1_500, 72 + headerHeight + bountyHeight
    + (bountyHeight ? 22 : 0)
    + sectionHeights.reduce((total, value) => total + value, 0)
    + Math.max(0, wrappedSections.length - 1) * gap
    + footerHeight);
  if (height > 3_200) throw new Error("Profile content is too long to fit on one card.");

  const canvas = createCanvas(WIDTH, height);
  const context = canvas.getContext("2d");
  const accent = toHexColor(input.accentColor);
  if (loadedBackground) fitImage(context, loadedBackground, 0, 0, WIDTH, height);
  else {
    const base = context.createLinearGradient(0, 0, WIDTH, height);
    base.addColorStop(0, "#28333a");
    base.addColorStop(0.5, "#26211c");
    base.addColorStop(1, "#171b20");
    context.fillStyle = base;
    context.fillRect(0, 0, WIDTH, height);
  }

  const shade = context.createLinearGradient(0, 0, WIDTH, height);
  shade.addColorStop(0, "rgba(7, 13, 18, 0.60)");
  shade.addColorStop(0.55, "rgba(8, 12, 17, 0.78)");
  shade.addColorStop(1, "rgba(7, 10, 15, 0.86)");
  context.fillStyle = shade;
  context.fillRect(0, 0, WIDTH, height);

  context.strokeStyle = accent;
  context.lineWidth = 5;
  drawRoundedRect(context, 28, 28, WIDTH - 56, height - 56, 34);
  context.stroke();
  context.strokeStyle = "rgba(255, 255, 255, 0.38)";
  context.lineWidth = 1.5;
  drawRoundedRect(context, 44, 44, WIDTH - 88, height - 88, 26);
  context.stroke();

  context.textBaseline = "alphabetic";
  context.fillStyle = accent;
  context.font = `bold 42px "${JAPANESE_FONT}"`;
  context.fillText("WANTED", CARD_MARGIN, 110);
  context.fillStyle = "rgba(255, 255, 255, 0.88)";
  context.font = `28px "${JAPANESE_FONT}"`;
  context.fillText("海賊プロフィールカード", CARD_MARGIN, 154);
  context.strokeStyle = accent;
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(CARD_MARGIN, 180);
  context.lineTo(WIDTH - CARD_MARGIN, 180);
  context.stroke();

  const avatarSize = 164;
  const avatarX = CARD_MARGIN;
  const avatarY = 204;
  context.save();
  context.beginPath();
  context.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
  context.clip();
  context.fillStyle = "rgba(255,255,255,0.16)";
  context.fillRect(avatarX, avatarY, avatarSize, avatarSize);
  if (loadedAvatar) fitImage(context, loadedAvatar, avatarX, avatarY, avatarSize, avatarSize);
  else {
    context.fillStyle = "rgba(255,255,255,0.92)";
    context.font = `bold 76px "${JAPANESE_FONT}"`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText([...input.displayName][0] ?? "?", avatarX + avatarSize / 2, avatarY + avatarSize / 2);
    context.textAlign = "left";
  }
  context.restore();
  context.strokeStyle = accent;
  context.lineWidth = 5;
  context.beginPath();
  context.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2 + 3, 0, Math.PI * 2);
  context.stroke();

  const textX = avatarX + avatarSize + 38;
  context.fillStyle = "#ffffff";
  context.font = `bold 48px "${JAPANESE_FONT}"`;
  context.fillText(input.displayName.slice(0, 24), textX, 266, WIDTH - textX - CARD_MARGIN);
  context.fillStyle = "rgba(255,255,255,0.76)";
  context.font = `26px "${JAPANESE_FONT}"`;
  context.fillText(`@${input.username}`.slice(0, 42), textX, 310, WIDTH - textX - CARD_MARGIN);
  context.fillStyle = accent;
  context.font = `bold 28px "${JAPANESE_FONT}"`;
  context.fillText(input.rankLabel ?? input.cardTitle.replace(/^🏴‍☠️\s*/, ""), textX, 356, WIDTH - textX - CARD_MARGIN);

  let y = 390;
  if (input.bountyValue) {
    drawRoundedRect(context, CARD_MARGIN, y, CONTENT_WIDTH, bountyHeight - 10, 24);
    context.fillStyle = "rgba(10, 12, 16, 0.68)";
    context.fill();
    context.strokeStyle = accent;
    context.lineWidth = 2;
    context.stroke();
    context.fillStyle = "rgba(255,255,255,0.76)";
    context.font = `bold 26px "${JAPANESE_FONT}"`;
    context.fillText(input.bountyLabel ?? "懸賞金", CARD_MARGIN + 32, y + 52);
    context.fillStyle = accent;
    context.font = `bold 48px "${JAPANESE_FONT}"`;
    context.fillText(input.bountyValue, CARD_MARGIN + 32, y + 120, CONTENT_WIDTH - 64);
    y += bountyHeight + 22;
  }

  context.textBaseline = "alphabetic";
  for (let index = 0; index < wrappedSections.length; index++) {
    const section = wrappedSections[index]!;
    const boxHeight = sectionHeights[index]!;
    drawRoundedRect(context, CARD_MARGIN, y, CONTENT_WIDTH, boxHeight, 20);
    context.fillStyle = "rgba(8, 12, 16, 0.69)";
    context.fill();
    context.strokeStyle = "rgba(255,255,255,0.27)";
    context.lineWidth = 1.5;
    context.stroke();
    context.fillStyle = accent;
    context.font = `bold 28px "${JAPANESE_FONT}"`;
    context.fillText(section.title, CARD_MARGIN + 28, y + 42, CONTENT_WIDTH - 56);
    context.fillStyle = "rgba(255,255,255,0.94)";
    context.font = `26px "${JAPANESE_FONT}"`;
    section.lines.forEach((line, lineIndex) => {
      context.fillText(line, CARD_MARGIN + 28, y + 82 + lineIndex * 38, CONTENT_WIDTH - 56);
    });
    y += boxHeight + gap;
  }
  context.fillStyle = "rgba(255,255,255,0.7)";
  context.font = `20px "${JAPANESE_FONT}"`;
  context.fillText("プロフィールカード", CARD_MARGIN, height - 55);
  context.textAlign = "right";
  context.fillStyle = accent;
  context.fillText(input.cardTitle.replace(/^🏴‍☠️\s*/, ""), WIDTH - CARD_MARGIN, height - 55);
  context.textAlign = "left";
  return canvas.toBuffer("image/png");
}
