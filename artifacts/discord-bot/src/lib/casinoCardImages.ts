import { AttachmentBuilder } from "discord.js";
import Jimp from "jimp";
import { getBjCardImages } from "./bjCardImages";
import { downloadImageAsBuffer } from "./gcsStorage";
import type { PokerCard } from "./dealerCasinoRules";

const SUIT_KEY: Record<PokerCard["suit"], string> = {
  spades: "spade",
  hearts: "heart",
  diamonds: "diamond",
  clubs: "club",
};

/** /blackjack config card と同じ rank:suit キーを使う。 */
export function blackjackCardKey(card: PokerCard): string {
  const rank = card.rank === 14
    ? "A"
    : card.rank === 13
      ? "K"
      : card.rank === 12
        ? "Q"
        : card.rank === 11
          ? "J"
          : String(card.rank);
  return `${rank}:${SUIT_KEY[card.suit]}`;
}

export interface CardStrip {
  filename: string;
  attachment: AttachmentBuilder;
}

/**
 * Blackjack's registered card art and 90px horizontal-strip presentation.
 * Never show a partial strip: if any card art is unavailable, the caller
 * displays the complete hand as text instead.
 */
export async function buildBlackjackCardStrip(
  guildId: string,
  cards: readonly PokerCard[],
  filename: string,
): Promise<CardStrip | null> {
  if (!cards.length) return null;
  try {
    const paths = await getBjCardImages(guildId);
    const objects = cards.map((card) => paths.get(blackjackCardKey(card)));
    if (objects.some((path) => !path)) return null;
    const buffers = await Promise.all(objects.map((path) => downloadImageAsBuffer(path!)));
    if (buffers.some((buffer) => !buffer)) return null;

    const images = await Promise.all(buffers.map((buffer) => Jimp.read(buffer!)));
    const height = Math.min(Math.max(...images.map((image) => image.bitmap.height)), 90);
    const resized = images.map((image) =>
      image.resize(Math.round(image.bitmap.width * height / image.bitmap.height), height, Jimp.RESIZE_BICUBIC));
    const width = resized.reduce((total, image) => total + image.bitmap.width, 0);
    const strip = new Jimp(width, height, 0x00000000);
    let x = 0;
    for (const image of resized) {
      strip.composite(image, x, 0);
      x += image.bitmap.width;
    }
    return { filename, attachment: new AttachmentBuilder(await strip.getBufferAsync(Jimp.MIME_PNG), { name: filename }) };
  } catch {
    return null;
  }
}