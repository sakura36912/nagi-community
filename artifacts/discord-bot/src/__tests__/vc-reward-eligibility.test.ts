import { describe, expect, it } from "vitest";
import { isBeachVoiceChannel } from "../lib/vcRewardEligibility.js";

describe("VC滞在報酬の砂浜判定", () => {
  it("名前が砂浜のVCだけを対象にする", () => {
    expect(isBeachVoiceChannel("砂浜", null)).toBe(true);
    expect(isBeachVoiceChannel("雑談", null)).toBe(false);
  });

  it("砂浜カテゴリ内のVCを対象にする", () => {
    expect(isBeachVoiceChannel("海の家", "砂浜")).toBe(true);
    expect(isBeachVoiceChannel("海の家", "雑談")).toBe(false);
  });
});