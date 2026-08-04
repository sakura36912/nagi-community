/**
 * Tests for saveSchedule application-level validation.
 *
 * Verifies that saveSchedule rejects inserts with a missing or blank
 * channelName before they reach the database, so malformed rows can never
 * accumulate in vc_schedules.
 */

import { describe, expect, it } from "vitest";
import { saveSchedule } from "../lib/vc.js";

describe("saveSchedule – channelName validation", () => {
  const futureDate = new Date(Date.now() + 60 * 60 * 1000);

  it("throws when channelName is an empty string", async () => {
    await expect(
      saveSchedule("guild-1", "channel-1", "", futureDate),
    ).rejects.toThrow("channelName is required and cannot be empty");
  });

  it("throws when channelName is a whitespace-only string", async () => {
    await expect(
      saveSchedule("guild-1", "channel-1", "   ", futureDate),
    ).rejects.toThrow("channelName is required and cannot be empty");
  });
});
