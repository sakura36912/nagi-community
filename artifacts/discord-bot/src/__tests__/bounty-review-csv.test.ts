import { describe, expect, it } from "vitest";
import { parseBountyReviewCsv } from "../lib/bountyReviewCsv";

describe("monthly bounty review CSV", () => {
  const user = "123456789012345678";
  const role = "223456789012345678";
  it("accepts UTF-8 BOM, CRLF and multiple roles", () => {
    expect(parseBountyReviewCsv(`\uFEFFuser_id,role_ids\r\n"${user}","${role}|323456789012345678"\r\n`))
      .toEqual([{ userId: user, roleIds: [role, "323456789012345678"] }]);
  });
  it("rejects duplicate users, duplicate roles, bad IDs and missing data", () => {
    expect(() => parseBountyReviewCsv(`user_id,role_ids\n${user},${role}\n${user},${role}`)).toThrow(/重複/);
    expect(() => parseBountyReviewCsv(`user_id,role_ids\n${user},${role}|${role}`)).toThrow(/重複/);
    expect(() => parseBountyReviewCsv(`user_id,role_ids\ninvalid,${role}`)).toThrow(/不正/);
    expect(() => parseBountyReviewCsv("user_id,role_ids\n")).toThrow(/1〜500/);
  });
});