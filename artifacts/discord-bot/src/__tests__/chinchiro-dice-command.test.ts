import { describe, expect, it } from "vitest";
import { chinchiroDiceCommandData } from "../commands/chinchiroDice.js";
import { validDiceFace } from "../lib/chinchiroDiceImages.js";

describe("chinchiro dice command", () => {
  it("exposes set, list, and delete subcommands", () => {
    const names = (chinchiroDiceCommandData().toJSON() as { options?: { name: string }[] }).options?.map((o) => o.name);
    expect(names).toEqual(["set", "list", "delete"]);
  });

  it("accepts only integer faces one through six", () => {
    expect([1, 2, 3, 4, 5, 6].every(validDiceFace)).toBe(true);
    expect([0, 7, 1.5, NaN].some(validDiceFace)).toBe(false);
  });
});