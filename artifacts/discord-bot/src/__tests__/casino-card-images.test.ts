import { beforeEach, describe, expect, it, vi } from "vitest";
import Jimp from "jimp";
import { getBjCardImages } from "../lib/bjCardImages";
import { downloadImageAsBuffer } from "../lib/gcsStorage";
import { blackjackCardKey, buildBlackjackCardStrip } from "../lib/casinoCardImages";
import type { PokerCard } from "../lib/dealerCasinoRules";

vi.mock("../lib/bjCardImages", () => ({ getBjCardImages: vi.fn() }));
vi.mock("../lib/gcsStorage", () => ({ downloadImageAsBuffer: vi.fn() }));

const cards: PokerCard[] = [
  { suit: "spades", rank: 14 },
  { suit: "hearts", rank: 11 },
  { suit: "diamonds", rank: 10 },
];

describe("スリーカードポーカーのブラックジャック画像", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ブラックジャックに登録した同じランク・スートの画像キーを使う", () => {
    expect(cards.map(blackjackCardKey)).toEqual(["A:spade", "J:heart", "10:diamond"]);
    expect(blackjackCardKey({ suit: "clubs", rank: 13 })).toBe("K:club");
  });

  it("登録済みの3枚をブラックジャックと同じ横一列の画像にする", async () => {
    const image = await new Jimp(20, 30, 0xff0000ff).getBufferAsync(Jimp.MIME_PNG);
    vi.mocked(getBjCardImages).mockResolvedValue(new Map([
      ["A:spade", "bj-cards/test/spade/A.png"],
      ["J:heart", "bj-cards/test/heart/J.png"],
      ["10:diamond", "bj-cards/test/diamond/10.png"],
    ]));
    vi.mocked(downloadImageAsBuffer).mockResolvedValue(image);

    const strip = await buildBlackjackCardStrip("test", cards, "hand.png");
    expect(getBjCardImages).toHaveBeenCalledWith("test");
    expect(downloadImageAsBuffer).toHaveBeenCalledTimes(3);
    expect(strip?.filename).toBe("hand.png");
    const buffer = strip?.attachment.attachment;
    expect(Buffer.isBuffer(buffer)).toBe(true);
    const result = await Jimp.read(buffer as Buffer);
    expect(result.bitmap.width).toBe(60);
    expect(result.bitmap.height).toBe(30);
  });

  it("1枚でも未登録・取得不能なら不完全な画像を出さず文字表示へ戻す", async () => {
    vi.mocked(getBjCardImages).mockResolvedValue(new Map([["A:spade", "a.png"]]));
    expect(await buildBlackjackCardStrip("test", cards, "hand.png")).toBeNull();
    expect(downloadImageAsBuffer).not.toHaveBeenCalled();

    vi.mocked(getBjCardImages).mockResolvedValue(new Map(cards.map((card) => [blackjackCardKey(card), "a.png"])));
    vi.mocked(downloadImageAsBuffer).mockResolvedValue(null);
    expect(await buildBlackjackCardStrip("test", cards, "hand.png")).toBeNull();
  });
});