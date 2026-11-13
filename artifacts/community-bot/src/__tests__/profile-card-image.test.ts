import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { fetchProfileImage, renderProfileCard } from "../lib/profileCardImage";

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
});
