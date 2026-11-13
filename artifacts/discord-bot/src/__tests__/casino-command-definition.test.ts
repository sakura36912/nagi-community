import { describe, expect, it } from "vitest";
import { casinoCommand } from "../commands/casino.js";

describe("/casino command definition", () => {
  it("keeps chohan while omitting the poker command group", () => {
    const groups = casinoCommand.data.toJSON().options?.filter((option) => option.type === 2);
    expect(groups?.map((option) => option.name)).toContain("chohan");
    expect(groups?.map((option) => option.name)).not.toContain("poker");
  });

  it("keeps only chohan start and removes the redundant roll command", () => {
    const options = casinoCommand.data.toJSON().options ?? [];
    const chohan = options.find((option) => option.type === 2 && option.name === "chohan");
    const chohanOptions = chohan && "options" in chohan
      ? (chohan.options ?? []).map((option) => option.name)
      : [];
    expect(chohanOptions).toEqual(["start"]);
    expect(options.map((option) => option.name)).toContain("close");
  });
});