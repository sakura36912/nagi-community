import { describe, expect, it } from "vitest";
import { casinoCommand } from "../commands/casino.js";

describe("/casino command definition", () => {
  it("keeps chohan while omitting the poker command group", () => {
    const groups = casinoCommand.data.toJSON().options?.filter((option) => option.type === 2);
    expect(groups?.map((option) => option.name)).toContain("chohan");
    expect(groups?.map((option) => option.name)).not.toContain("poker");
  });
});