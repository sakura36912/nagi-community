import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import { describe, expect, it, vi } from "vitest";
import {
  createPinnedProfileLookup,
  fetchProfileImage,
  hasJapaneseFontCoverage,
  renderProfileCard,
  resolveProfileImageRedirect,
} from "../lib/profileCardImage";

function testImage() {
  const canvas = createCanvas(320, 240);
  const context = canvas.getContext("2d");
  context.fillStyle = "#37556b";
  context.fillRect(0, 0, canvas.width, canvas.height);
  return canvas.toBuffer("image/png");
}

describe("profile card image", () => {
  it("renders Japanese profile text over a supplied background as a PNG", async () => {
    const background = testImage();
    const card = await renderProfileCard({
      displayName: "さくら",
      username: "sakura",
      avatarUrl: "https://cdn.example/avatar.png",
      cardTitle: "🏴‍☠️ WANTED",
      rankLabel: "VIP",
      bountyLabel: "懸賞金",
      bountyValue: "500,000$",
      sections: [
        { title: "🎭 ロール", lines: ["軍師"] },
        { title: "⚔️ 戦闘情報", lines: ["武器：大剣 Lv3", "最大ダメージ：9,500"] },
        { title: "🎒 所持品", lines: ["レア卵：1個", "エサ：2個", "おもちゃ：1個"] },
      ],
      accentColor: 0xc49a5a,
      backgroundBuffer: background,
      avatarBuffer: null,
    });

    expect(card.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const image = await loadImage(card);
    expect(image.width).toBe(1200);
    expect(image.height).toBeGreaterThanOrEqual(1_500);
    expect(GlobalFonts.has("Noto Sans CJK JP")).toBe(true);
  });

  it("rejects insecure and local background URLs before making a request", async () => {
    await expect(fetchProfileImage("http://example.com/image.png")).rejects.toThrow("HTTPS");
    await expect(fetchProfileImage("https://127.0.0.1/image.png")).rejects.toThrow("Private or reserved");
  });

  it("allows only bounded HTTPS redirects for public image URLs", () => {
    expect(resolveProfileImageRedirect("https://cdn.discordapp.com/upload", "/attachments/file.jpg", 0))
      .toBe("https://cdn.discordapp.com/attachments/file.jpg");
    expect(() => resolveProfileImageRedirect("https://cdn.discordapp.com/upload", "http://127.0.0.1/file.jpg", 0))
      .toThrow("public HTTPS");
    expect(() => resolveProfileImageRedirect("https://cdn.discordapp.com/upload", "/file.jpg", 3))
      .toThrow("redirect limit");
  });

  it("supports both standard and all-address Node lookup callback forms", () => {
    const lookup = createPinnedProfileLookup("93.184.216.34");
    const standardCallback = vi.fn();
    const allCallback = vi.fn();

    lookup("cdn.example", {}, standardCallback);
    lookup("cdn.example", { all: true }, allCallback);

    expect(standardCallback).toHaveBeenCalledWith(null, "93.184.216.34", 4);
    expect(allCallback).toHaveBeenCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);
  });

  it("rejects fonts that do not declare Japanese language coverage", () => {
    expect(hasJapaneseFontCoverage("en|fr|ja|zh-cn")).toBe(true);
    expect(hasJapaneseFontCoverage("en|fr|zh-cn")).toBe(false);
  });
});
