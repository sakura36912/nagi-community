import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("bank command restoration", () => {
  it("registers the bank's transfer, balance, casino, and restored command handlers", () => {
    const source = readFileSync(new URL("../commands/index.ts", import.meta.url), "utf8");
    const list = source.split("export const commands: Command[] = [")[1]!.split("];")[0]!;

    for (const name of [
      "give", "guide", "leavelog", "roulette",
      "balance", "pay", "casino", "leaderboard",
    ]) {
      expect(list).toContain(`${name}Command`);
    }
  });

  it("does not remove the restored commands during startup or deployment", () => {
    const startup = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const deploy = readFileSync(new URL("../deploy-commands.ts", import.meta.url), "utf8");

    expect(startup).not.toContain("startRetiredBankCommandCleanup");
    expect(deploy).not.toContain("removeRetiredBankCommands");
    expect(deploy).toContain("rest.post(itemRoute");
  });
});
