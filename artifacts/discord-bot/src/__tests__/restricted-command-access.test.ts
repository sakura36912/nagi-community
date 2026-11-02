import { describe, expect, it } from "vitest";
import { isBankCommandBlocked as blocked } from "../lib/restrictedCommandAccess";

describe("bank restricted-role command access", () => {
  const general = ["送金", "残高確認", "slot", "blackjack", "baccarat", "highlow", "chinchiro", "裏航海", "bounty", "shop", "vc", "other"];
  it.each([
    { roles: ["島民"] }, { roles: ["島民", "本船員"] }, { roles: ["島民", "夜鴉"] },
    { roles: ["島民", "黒兵"] }, { roles: ["島民", "任意のロール"] }, { roles: [] },
  ])("does not restrict general commands for %j", ({ roles }) => {
    for (const command of general) expect(blocked(command, roles)).toBe(false);
  });
  it.each([{ roles: ["追放者"] }, { roles: ["島民", "追放者"] }])(
    "keeps the exact exile whitelist for %j", ({ roles }) => {
      for (const command of ["送金", "残高確認", "slot", "blackjack", "highlow", "chinchiro", "裏航海", "bounty"])
        expect(blocked(command, roles)).toBe(false);
      for (const command of ["baccarat", "shop", "vc", "other"])
        expect(blocked(command, roles)).toBe(true);
    },
  );
  it.each(["守門卿", "門番", "門番見習い", "見習い門番", "航海士", "提督", "大提督", "賭博頭領", "賭博師"])(
    "preserves the existing staff exemption for %s", role => {
      expect(blocked("shop", ["島民", "追放者", role])).toBe(false);
    },
  );
});
