import { describe, expect, it } from "vitest";
import { isCommunityCommandBlocked as blocked } from "../lib/restrictedCommandAccess.js";

describe("community restricted-role command access", () => {
  it.each([["島民"], ["島民", "本船員"], ["島民", "任意のロール"]])(
    "allows island members to reach the zombie handler (%s)", (...roles) => {
      for (const command of ["zombie", "infect", "heal"])
        expect(blocked(command, roles)).toBe(false);
    },
  );
  it.each([["島民"], ["島民", "本船員"], ["島民", "任意のロール"]])(
    "does not impose a command whitelist on island members (%s)", (...roles) => {
      for (const command of ["shop", "other", "vc時間", "vcランク", "武器確認", "ボス情報"])
        expect(blocked(command, roles)).toBe(false);
    },
  );
  it("does not grant permission to an administrator-only operation just by passing the common gate", () => {
    // Admin checks remain in the handlers, as covered by zombie/forge/boss interaction tests.
    expect(blocked("zombie", ["島民"])).toBe(false);
    expect(blocked("ボス開催", ["島民"])).toBe(false);
  });
  it.each([["追放者"], ["島民", "追放者"]])("preserves the exile restriction (%s)", (...roles) => {
    for (const command of ["zombie", "infect", "heal"]) expect(blocked(command, roles)).toBe(true);
  });
  it.each(["守門卿", "門番", "門番見習い", "航海士", "提督", "大提督"])("preserves the %s staff exemption", role => {
    expect(blocked("zombie", ["島民", "追放者", role])).toBe(false);
  });
  it("preserves VC access and unrestricted users' existing access", () => {
    for (const role of ["島民", "追放者"])
      for (const command of ["vc時間", "vcランク"]) expect(blocked(command, [role])).toBe(false);
    expect(blocked("zombie", [])).toBe(false);
    expect(blocked("zombie", ["本船員"])).toBe(false); // Handler still checks live Administrator.
  });
});
