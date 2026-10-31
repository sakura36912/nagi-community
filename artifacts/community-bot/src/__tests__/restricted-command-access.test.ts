import { describe, expect, it } from "vitest";
import { isCommunityCommandBlocked as blocked } from "../lib/restrictedCommandAccess.js";

describe("community restricted-role command access", () => {
  it.each([["島民"], ["島民", "本船員"], ["島民", "任意のロール"]])(
    "allows island members to check only their own zombie role (%s)", (...roles) => {
      expect(blocked("zombie", "me", roles)).toBe(false);
    },
  );
  it.each(["start", "begin", "status", "requests", "config", "vc", "rewards", "exclude", "set_zombie", "set_healer", "set_human", "end", "cancel"])(
    "does not grant island members zombie %s", sub => {
      expect(blocked("zombie", sub, ["島民"])).toBe(true);
    },
  );
  it("does not exempt the whole command, other commands, or request/approval actions", () => {
    expect(blocked("zombie", null, ["島民"])).toBe(true);
    for (const command of ["infect", "heal", "shop", "other"])
      for (const sub of ["me", "request", "accept", "reject"])
        expect(blocked(command, sub, ["島民"])).toBe(true);
  });
  it.each([["追放者"], ["島民", "追放者"]])("preserves the exile restriction (%s)", (...roles) => {
    expect(blocked("zombie", "me", roles)).toBe(true);
  });
  it.each(["守門卿", "門番", "門番見習い", "航海士", "提督", "大提督"])("preserves the %s staff exemption", role => {
    expect(blocked("zombie", "status", ["島民", "追放者", role])).toBe(false);
  });
  it("preserves VC access and unrestricted users' existing access", () => {
    for (const role of ["島民", "追放者"])
      for (const command of ["vc時間", "vcランク"]) expect(blocked(command, null, [role])).toBe(false);
    expect(blocked("zombie", "me", [])).toBe(false);
    expect(blocked("zombie", "status", ["本船員"])).toBe(false); // Handler still checks live Administrator.
  });
});
